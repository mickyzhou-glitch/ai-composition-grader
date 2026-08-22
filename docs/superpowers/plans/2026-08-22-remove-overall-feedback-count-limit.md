# 移除优点与修改项数量限制实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让主分析和局部重新生成不再因优点或修改项数量不在 2 至 4 条之间而失败。

**架构：** 保留现有报告 Schema、文本规范化和其他语义校验，只删除数量判断。云端内容分析、直接图片分析和局部重新生成的提示词统一改为按作文实际内容生成，不再向模型声明数量范围。

**技术栈：** TypeScript、Zod、Vitest、OpenAI 兼容接口。

---

## 文件结构

- 修改 `src/ai/review-semantics.ts`：删除主报告优点与修改项的数量校验，保留规范化。
- 修改 `src/ai/composition-review-adapter.ts`：删除云端内容模型提示词中的数量要求。
- 修改 `src/ai/composition-review-adapter.test.ts`：覆盖超过 4 条仍通过和提示词无数量要求。
- 修改 `src/ai/openai-review-adapter.ts`：删除直接分析、局部重新生成提示词及 Zod 数量限制。
- 修改 `src/ai/openai-review-adapter.test.ts`：覆盖主提示词和局部重新生成的无数量限制行为。

### 任务 1：放宽云端内容分析报告校验

**文件：**
- 修改：`src/ai/composition-review-adapter.test.ts`
- 修改：`src/ai/review-semantics.ts`
- 修改：`src/ai/composition-review-adapter.ts`

- [ ] **步骤 1：把超过 4 条修改项的测试改为成功用例**

将现有 `rejects feedback with more than four non-empty improvements` 测试改为断言模型只调用一次，并返回清理序号和空白项后的 5 条修改项：

```ts
it("accepts more than four non-empty improvements", async () => {
  const harness = setup();
  const painPoints = [
    "1. 第二段补充事情发生的具体背景",
    "2、第三段写清比赛过程中的心理变化",
    "3.",
    "第四段补充冲线前后的具体动作",
    "结尾部分要注意回扣题目中心",
    "开头部分压缩起床和到校的过程",
  ];
  harness.create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
    report: { ...report, painPoints },
    annotationAnchors: [],
  }) } }] });

  await expect(harness.adapter.analyzeText({
    config,
    pages: [{ pageIndex: 0, text: "我终于明白了坚持的意义。" }],
    studentName: "小艾",
  })).resolves.toMatchObject({
    report: { painPoints: painPoints.filter((item) => item !== "3.").map((item) => item.replace(/^\\s*(?:(?:[1-4]|[一二三四])[.、．)）:]|[-*•])\\s*/u, "")) },
  });
  expect(harness.create).toHaveBeenCalledTimes(1);
});
```

在生成请求测试中增加：

```ts
expect(serialized).not.toContain("2-4 条");
expect(serialized).toContain("根据作文实际内容生成优点和修改项");
```

- [ ] **步骤 2：运行测试验证红灯**

运行：`npm test -- src/ai/composition-review-adapter.test.ts`

预期：FAIL。超过 4 条的结果触发 `AI_INVALID_RESPONSE`，提示词仍包含 `2-4 条`。

- [ ] **步骤 3：删除数量校验并更新云端提示词**

从 `validateGeneratedReportSemantics()` 删除：

```ts
if (
  strengths.length < 2 || strengths.length > 4 ||
  painPoints.length < 2 || painPoints.length > 4
) {
  throw new Error("overall feedback must contain two to four non-empty strengths and improvements");
}
```

把 `src/ai/composition-review-adapter.ts` 的提示词改为：

```ts
"根据作文实际内容生成优点和修改项：personalizedComment 中的优点用换行分隔；painPoints 返回修改项数组。每条 10-20 个汉字，只写一个具体要点，不加序号。commonIssues 和 revisionSuggestions 必须返回空数组。",
```

- [ ] **步骤 4：运行测试验证绿灯**

运行：`npm test -- src/ai/composition-review-adapter.test.ts`

预期：该测试文件全部通过，超过 4 条的结果不触发模型修复请求。

- [ ] **步骤 5：提交云端内容分析修改**

```bash
git add src/ai/review-semantics.ts src/ai/composition-review-adapter.ts src/ai/composition-review-adapter.test.ts
git commit -m "fix(AI): 取消批改要点数量校验"
```

### 任务 2：放宽直接分析和局部重新生成

**文件：**
- 修改：`src/ai/openai-review-adapter.test.ts`
- 修改：`src/ai/openai-review-adapter.ts`

- [ ] **步骤 1：编写无数量限制的提示词和局部生成测试**

把主提示词断言调整为：

```ts
expect(serialized).not.toContain("2-4 条");
expect(serialized).toContain("根据作文实际内容列出优点和需要修改");
```

把局部重新生成测试的 `items` 扩展到 5 条，并断言提示词不包含 `2-4 条`：

```ts
const items = [
  "选材真实贴近自己的生活",
  "礼物线索贯穿全文始终",
  "人物动作描写具体自然",
  "结尾感悟能够回扣题目",
  "母子之间情感表达真切",
];
expect(serialized).not.toContain("2-4 条");
expect(serialized).toContain("根据文章实际内容生成");
```

- [ ] **步骤 2：运行测试验证红灯**

运行：`npm test -- src/ai/openai-review-adapter.test.ts`

预期：FAIL。5 条局部生成结果被 `.max(4)` 拒绝，旧提示词断言也失败。

- [ ] **步骤 3：删除直接分析和局部生成的数量要求**

将 `CONCISE_FEEDBACK_RULE` 的开头改为：

```ts
"给学生的评价必须简洁、直观：根据作文实际内容列出优点和需要修改。personalizedComment 中的优点用换行分隔；painPoints 返回修改项数组。每条 10-20 个汉字，只说一个具体要点，不写总评段落，不加“一、二、三、四”等序号，不重复解释。"
```

局部重新生成提示词改为：

```ts
"根据文章实际内容生成，不要为凑数添加重复或空泛内容。",
```

局部响应 Schema 改为：

```ts
return z.object({ items: z.array(itemSchema) }).parse(parseJsonResponse(content));
```

- [ ] **步骤 4：运行测试验证绿灯**

运行：`npm test -- src/ai/openai-review-adapter.test.ts`

预期：该测试文件全部通过，5 条局部结果能够返回。

- [ ] **步骤 5：提交直接分析修改**

```bash
git add src/ai/openai-review-adapter.ts src/ai/openai-review-adapter.test.ts
git commit -m "fix(AI): 放宽局部批改要点数量"
```

### 任务 3：完整验证

**文件：**
- 验证：`src/ai/review-semantics.ts`
- 验证：`src/ai/composition-review-adapter.ts`
- 验证：`src/ai/openai-review-adapter.ts`

- [ ] **步骤 1：运行 AI 相关回归测试**

运行：`npm test -- src/ai/composition-review-adapter.test.ts src/ai/openai-review-adapter.test.ts src/cloudflare/d1-analysis-jobs.test.ts`

预期：所有相关测试通过，且无未处理异常。

- [ ] **步骤 2：运行完整测试套件**

运行：`npm test`

预期：全部测试通过，失败数为 0。

- [ ] **步骤 3：运行静态检查和生产构建**

运行：`npm run lint && npm run build`

预期：ESLint 和 Next.js 生产构建均以退出码 0 完成。

- [ ] **步骤 4：检查最终差异**

运行：`git diff --check && git status --short`

预期：没有空白错误，只包含计划内文件变更或已经提交的计划内 commit。
