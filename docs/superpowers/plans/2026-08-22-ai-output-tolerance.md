# AI 批改输出容错实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 避免时间词段首和可确定性清理的评语格式偏差导致整篇作文分析失败，同时继续拒绝真正不完整的 AI 响应。

**架构：** 保留 `CompositionReviewAdapter` 的 Zod 结构校验与一次模型修复流程，只调整 `validateGeneratedReportSemantics` 对展示层约束的处理。文风规则继续存在于提示词中但不再阻断保存；评语在语义校验阶段无损规范化后再检查有效条数。

**技术栈：** TypeScript、Zod 4、Vitest、OpenAI 兼容 Chat Completions。

---

## 文件结构

- 修改 `src/ai/composition-review-adapter.test.ts`：增加线上两类错误的适配器级回归测试，并收紧无法恢复评语的既有测试。
- 修改 `src/ai/review-semantics.ts`：取消时间词段首的致命校验，规范化空评语与废弃字段，保留有效条数校验。

## 任务 1：让示范段落时间词成为非致命文风偏差

**文件：**

- 修改：`src/ai/composition-review-adapter.test.ts`
- 修改：`src/ai/review-semantics.ts`

- [ ] **步骤 1：编写时间词回归测试**

在 `CompositionReviewAdapter` 测试中加入以下用例，使用自定义作文配置模拟线上作文：

```ts
it("accepts a valid custom report when a sample paragraph begins with a time word", async () => {
  const harness = setup();
  harness.create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
    report: {
      ...report,
      sampleParagraphs: [{
        title: "运动会开场",
        text: "清晨的阳光透过窗帘，我看着准备好的跑鞋，心里充满期待。",
        suggestion: "用环境描写交代活动背景。",
      }],
    },
    annotationAnchors: [],
  }) } }] });

  await expect(harness.adapter.analyzeText({
    config,
    pages: [{ pageIndex: 0, text: "清晨的阳光透过窗帘，我准备参加运动会。" }],
    studentName: "小艾",
  })).resolves.toMatchObject({
    report: { sampleParagraphs: [{ text: expect.stringMatching(/^清晨/u) }] },
  });
  expect(harness.create).toHaveBeenCalledTimes(1);
});
```

- [ ] **步骤 2：运行测试并确认红灯**

运行：

```bash
npm test -- src/ai/composition-review-adapter.test.ts -t "accepts a valid custom report when a sample paragraph begins with a time word"
```

预期：FAIL。适配器会发起第二次请求；相同返回再次触发 `sample_paragraphs`，最终抛出 `AI_INVALID_RESPONSE`。

- [ ] **步骤 3：删除时间词致命校验**

从 `src/ai/review-semantics.ts` 删除 `FORBIDDEN_TIME_OPENING` 和对应的 `throw`：

```ts
// 删除：
const FORBIDDEN_TIME_OPENING = /.../u;

// 删除：
if (report.sampleParagraphs.some((paragraph) => FORBIDDEN_TIME_OPENING.test(paragraph.text.trim()))) {
  throw new Error("sample paragraphs must not begin with a time word");
}
```

不得删除 `composition-review-adapter.ts` 中提示模型避免时间词段首的规则。

- [ ] **步骤 4：运行测试并确认绿灯**

运行：

```bash
npm test -- src/ai/composition-review-adapter.test.ts -t "accepts a valid custom report when a sample paragraph begins with a time word"
```

预期：PASS，模型客户端调用 1 次。

## 任务 2：规范化可恢复的学生评语

**文件：**

- 修改：`src/ai/composition-review-adapter.test.ts`
- 修改：`src/ai/review-semantics.ts`

- [ ] **步骤 1：编写可恢复评语回归测试**

加入一个模型返回用例：优点中包含空行和超过 40 个字符的有效条目，修改建议带序号，两个废弃字段非空。期望分析只调用模型 1 次，并返回清理后的内容：

```ts
it("normalizes recoverable feedback formatting without retrying the model", async () => {
  const harness = setup();
  const longStrength = "运动会过程中的动作、心理和现场气氛描写彼此配合，让长跑比赛的紧张感和坚持到底的主题都很清楚";
  harness.create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
    report: {
      ...report,
      personalizedComment: `1. ${longStrength}\n\n2、结尾能够回扣坚持的主题`,
      painPoints: ["1. 第二段压缩到校前的过程", "2、比赛部分补充冲线动作"],
      commonIssues: ["重复内容"],
      revisionSuggestions: ["压缩开头"],
    },
    annotationAnchors: [],
  }) } }] });

  const result = await harness.adapter.analyzeText({
    config,
    pages: [{ pageIndex: 0, text: "我参加了运动会。" }],
    studentName: "小艾",
  });

  expect(result.report).toMatchObject({
    personalizedComment: `${longStrength}\n结尾能够回扣坚持的主题`,
    painPoints: ["第二段压缩到校前的过程", "比赛部分补充冲线动作"],
    commonIssues: [],
    revisionSuggestions: [],
  });
  expect(harness.create).toHaveBeenCalledTimes(1);
});
```

同时将既有 `rejects feedback when normalization would hide an empty or extra item` 用例改名为 `rejects feedback with more than four non-empty improvements`，把 `painPoints` 固定为一个空序号项和 5 条非空建议：

```ts
painPoints: [
  "1. 第二段补充事情发生的具体背景",
  "2、第三段写清比赛过程中的心理变化",
  "3.",
  "第四段补充冲线前后的具体动作",
  "结尾部分要注意回扣题目中心",
  "开头部分压缩起床和到校的过程",
],
```

该用例继续使用完整的 `analyzeText` 调用，并保持以下断言：

```ts
await expect(harness.adapter.analyzeText({
  config,
  pages: [{ pageIndex: 0, text: "我终于明白了坚持的意义。" }],
  studentName: "小艾",
})).rejects.toMatchObject({
  code: "AI_INVALID_RESPONSE",
  upstreamCode: "overall_feedback",
});
expect(harness.create).toHaveBeenCalledTimes(2);
```

- [ ] **步骤 2：运行测试并确认红灯**

运行：

```bash
npm test -- src/ai/composition-review-adapter.test.ts -t "normalizes recoverable feedback formatting without retrying the model"
```

预期：FAIL。当前长度限制或非空废弃字段触发 `overall_feedback`，并导致第二次模型请求。

- [ ] **步骤 3：实现最小规范化**

在 `validateGeneratedReportSemantics` 中把评语处理改为：

```ts
const strengths = report.personalizedComment
  .split(/\r?\n/u)
  .map(normalizeFeedbackItem)
  .filter(Boolean);
const painPoints = report.painPoints
  .map(normalizeFeedbackItem)
  .filter(Boolean);
if (
  strengths.length < 2 || strengths.length > 4 ||
  painPoints.length < 2 || painPoints.length > 4
) {
  throw new Error("overall feedback must contain two to four non-empty strengths and improvements");
}
return {
  ...report,
  personalizedComment: strengths.join("\n"),
  painPoints,
  commonIssues: [],
  revisionSuggestions: [],
};
```

不要截断、合并或补写有效条目。

- [ ] **步骤 4：运行两个评语行为测试并确认绿灯**

运行：

```bash
npm test -- src/ai/composition-review-adapter.test.ts -t "recoverable feedback|more than four non-empty improvements"
```

预期：两个用例 PASS；可恢复格式只调用模型 1 次，5 条非空修改建议仍在修复请求后返回 `overall_feedback`。

- [ ] **步骤 5：运行 AI 适配器测试**

运行：

```bash
npm test -- src/ai/composition-review-adapter.test.ts src/ai/openai-review-adapter.test.ts
```

预期：两个测试文件全部 PASS。

## 任务 3：全量验证

**文件：**

- 验证：`src/ai/composition-review-adapter.test.ts`
- 验证：`src/ai/review-semantics.ts`

- [ ] **步骤 1：检查变更质量**

运行：

```bash
git diff --check
git diff -- src/ai/composition-review-adapter.test.ts src/ai/review-semantics.ts
```

预期：`git diff --check` 无输出；差异只包含规格要求的测试和语义校验修改。

- [ ] **步骤 2：运行全量单元测试**

运行：

```bash
npm test
```

预期：所有测试文件通过，0 个失败。

- [ ] **步骤 3：运行 Lint**

运行：

```bash
npm run lint
```

预期：退出码 0，无 ESLint 错误。

- [ ] **步骤 4：运行生产构建**

运行：

```bash
npm run build
```

预期：退出码 0，Next.js 生产构建成功。

- [ ] **步骤 5：提交修复**

```bash
git add src/ai/composition-review-adapter.test.ts src/ai/review-semantics.ts
git commit -m "fix(AI): 容错可恢复的批改输出"
```
