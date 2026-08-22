# 示例作文段落数一致性实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让历史和新建作文默认生成恰好 5 段示例正文，并确保 AI 提示词与服务端语义校验读取同一个段落数配置。

**架构：** 在领域契约中增加可选的 `sampleParagraphCount` 和唯一的缺省值读取函数。主内容模型、兼容适配器和整篇示例重写都使用该函数生成提示词并验证响应；新建作业入口显式保存 5。基础报告 Schema 仍允许 1–10 段，历史 JSON 不做迁移。

**技术栈：** TypeScript、Zod、Vitest、React 19、Next.js 16

---

## 文件结构

- `src/domain/contracts.ts`：定义段落数配置边界和历史默认值读取函数。
- `src/domain/contracts.test.ts`：验证合法范围、非法范围和历史默认值。
- `src/ai/review-semantics.ts`：按作业配置精确校验模型返回的示例段落数。
- `src/ai/composition-review-adapter.ts`：为主内容模型生成动态段落数提示词。
- `src/ai/composition-review-adapter.test.ts`：复现自定义作业三段被接受的问题并验证提示词、修复错误码和合法响应。
- `src/ai/openai-review-adapter.ts`：让兼容分析与整篇重写使用相同段落数规则。
- `src/ai/openai-review-adapter.test.ts`：验证兼容链路的动态提示词与响应校验。
- `app/(protected)/new/page.tsx`：新建内置和自定义作业时显式保存 5 段。
- `app/(protected)/new/page.test.tsx`：验证创建请求携带 `sampleParagraphCount: 5`。

### 任务 1：建立领域层段落数契约

**文件：**
- 修改：`src/domain/contracts.ts`
- 测试：`src/domain/contracts.test.ts`

- [ ] **步骤 1：编写失败的配置边界和历史兼容测试**

在 `assignmentConfigSchema` 测试中导入并覆盖期望函数：

```ts
import {
  assignmentConfigSchema,
  expectedSampleParagraphCount,
} from "./contracts";

it("历史配置默认要求5段，显式配置保留指定段落数", () => {
  const historical = assignmentConfigSchema.parse({
    title: "珍贵的礼物",
    writingRequirements: "写一件真实的事。",
    structureRequirements: "分五段展开。",
    scoringFocus: "细节与真情实感。",
    templateType: "custom",
  });

  expect(expectedSampleParagraphCount(historical)).toBe(5);
  expect(expectedSampleParagraphCount({ ...historical, sampleParagraphCount: 3 })).toBe(3);
});

it.each([0, 1.5, 11])("拒绝非法示例段落数 %s", (sampleParagraphCount) => {
  expect(() => assignmentConfigSchema.parse({
    title: "珍贵的礼物",
    writingRequirements: "写一件真实的事。",
    structureRequirements: "分五段展开。",
    scoringFocus: "细节与真情实感。",
    templateType: "custom",
    sampleParagraphCount,
  })).toThrow();
});
```

- [ ] **步骤 2：运行测试确认因字段被剥离和函数缺失而失败**

运行：

```bash
node ./node_modules/vitest/vitest.mjs run src/domain/contracts.test.ts
```

预期：FAIL，提示 `expectedSampleParagraphCount` 未导出，或显式配置值未保留。

- [ ] **步骤 3：实现可选字段和唯一默认值函数**

在 `assignmentConfigSchema` 中新增：

```ts
sampleParagraphCount: z.number().int().min(1).max(10).optional(),
```

在 `AssignmentConfig` 类型之后新增：

```ts
export function expectedSampleParagraphCount(config: AssignmentConfig): number {
  return config.sampleParagraphCount ?? 5;
}
```

- [ ] **步骤 4：运行领域测试确认通过**

运行：

```bash
node ./node_modules/vitest/vitest.mjs run src/domain/contracts.test.ts
```

预期：该文件全部通过。

- [ ] **步骤 5：提交任务 1**

```bash
git add src/domain/contracts.ts src/domain/contracts.test.ts
git commit -m "fix(AI): 统一示例作文段落数配置（任务 1/3）"
```

### 任务 2：统一模型提示词与响应校验

**文件：**
- 修改：`src/ai/review-semantics.ts`
- 修改：`src/ai/composition-review-adapter.ts`
- 测试：`src/ai/composition-review-adapter.test.ts`
- 修改：`src/ai/openai-review-adapter.ts`
- 测试：`src/ai/openai-review-adapter.test.ts`

- [ ] **步骤 1：编写主内容模型的失败回归测试**

将现有自定义测试基准显式设为 1 段，并在预设测试中覆盖为 5 段。新增历史配置回归用例：

```ts
const config: AssignmentConfig = {
  title: "一次难忘的经历",
  grade: "六年级",
  writingRequirements: "写一件真实的事。",
  targetCharacters: 500,
  structureRequirements: "起因、经过、结果完整。",
  scoringFocus: "内容具体。",
  templateType: "custom",
  sampleParagraphCount: 1,
};

it("历史自定义配置默认要求5段并拒绝三段响应", async () => {
  const harness = setup();
  const threeParagraphReport = {
    ...report,
    sampleParagraphs: Array.from({ length: 3 }, (_, index) => ({
      title: `第${index + 1}段`,
      text: "围绕礼物展开具体描写。",
      suggestion: "补充动作与心理。",
    })),
  };
  harness.create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
    report: threeParagraphReport,
    annotationAnchors: [],
  }) } }] });

  const historicalConfig = { ...config, sampleParagraphCount: undefined };
  await expect(harness.adapter.analyzeText({
    config: historicalConfig,
    pages: [{ pageIndex: 0, text: "爸爸送给我一根跳绳。" }],
  })).rejects.toMatchObject({ upstreamCode: "sample_paragraphs" });

  const prompt = (harness.create.mock.calls[0][0] as {
    messages: Array<{ content: string }>;
  }).messages[0].content;
  expect(prompt).toContain("sampleParagraphs 必须恰好5段");
});
```

另加显式 3 段配置成功测试，证明提示词和校验同时采用 3。

- [ ] **步骤 2：编写兼容适配器的失败测试**

新增显式 3 段配置用例，断言：

```ts
expect(prompt).toContain("sampleParagraphs 必须恰好3段");
expect(result.report?.sampleParagraphs).toHaveLength(3);
```

并为 `rewriteAllSamples` 增加 3 段输入，断言提示词包含「严格 3 段」且只接受 3 个对象。

- [ ] **步骤 3：运行 AI 测试确认现有逻辑错误地接受历史三段或仍硬编码五段**

运行：

```bash
node ./node_modules/vitest/vitest.mjs run src/ai/composition-review-adapter.test.ts src/ai/openai-review-adapter.test.ts
```

预期：FAIL，历史自定义三段未被拒绝，动态段落提示词不存在。

- [ ] **步骤 4：实现统一语义校验**

在 `review-semantics.ts` 导入 `expectedSampleParagraphCount`，替换模板分支：

```ts
const expectedParagraphs = expectedSampleParagraphCount(config);
if (report.sampleParagraphs.length !== expectedParagraphs) {
  throw new Error(`composition requires ${expectedParagraphs} sample paragraphs`);
}
```

- [ ] **步骤 5：实现主内容模型动态提示词**

在 `contentPrompt` 读取期望值：

```ts
const expectedParagraphs = expectedSampleParagraphCount(input.config);
const sampleParagraphRule =
  `sampleParagraphs 必须恰好${expectedParagraphs}段，每段包含非空 title、text、suggestion；` +
  `${expectedParagraphs}段 text 合计 600-700 个汉字。`;
```

- [ ] **步骤 6：实现兼容适配器动态提示词和校验**

在分析提示词、修复提示词、`validateUsableEnvelope` 和 `rewriteAllSamples` 中读取同一辅助函数。整篇重写结果 Schema 使用：

```ts
const expectedParagraphs = expectedSampleParagraphCount(input.config);
return z.object({
  sampleParagraphs: z.array(sampleParagraphSchema).length(expectedParagraphs),
}).parse(parseJsonResponse(content));
```

- [ ] **步骤 7：运行两个 AI 测试文件确认通过**

运行：

```bash
node ./node_modules/vitest/vitest.mjs run src/ai/composition-review-adapter.test.ts src/ai/openai-review-adapter.test.ts
```

预期：两个文件全部通过。

- [ ] **步骤 8：提交任务 2**

```bash
git add src/ai/review-semantics.ts src/ai/composition-review-adapter.ts src/ai/composition-review-adapter.test.ts src/ai/openai-review-adapter.ts src/ai/openai-review-adapter.test.ts
git commit -m "fix(AI): 强制模型按配置生成示例段落（任务 2/3）"
```

### 任务 3：让新作业显式保存 5 段配置

**文件：**
- 修改：`app/(protected)/new/page.tsx`
- 测试：`app/(protected)/new/page.test.tsx`

- [ ] **步骤 1：扩展创建请求测试**

在现有「填写学生姓名后按调整后的四图顺序上传」测试中增加：

```ts
expect(JSON.parse((reviewRequest[1] as RequestInit).body as string)).toMatchObject({
  studentName: "李羿辰",
  config: {
    title: "为自己鼓掌",
    sampleParagraphCount: 5,
  },
});
```

- [ ] **步骤 2：运行页面测试确认请求缺少新字段**

运行：

```bash
node ./node_modules/vitest/vitest.mjs run 'app/(protected)/new/page.test.tsx'
```

预期：FAIL，创建请求的配置中没有 `sampleParagraphCount`。

- [ ] **步骤 3：更新内置与自定义默认配置**

在 `presetConfig` 和 `customConfig` 中都加入：

```ts
sampleParagraphCount: 5,
```

从已保存题目切换时保留历史配置；缺失字段仍由领域辅助函数按 5 处理，不在页面上重写历史 JSON。

- [ ] **步骤 4：运行页面测试确认通过**

运行：

```bash
node ./node_modules/vitest/vitest.mjs run 'app/(protected)/new/page.test.tsx'
```

预期：该文件全部通过。

- [ ] **步骤 5：提交任务 3**

```bash
git add 'app/(protected)/new/page.tsx' 'app/(protected)/new/page.test.tsx'
git commit -m "fix(作业): 新建作文默认生成五段示例（任务 3/3）"
```

### 最终验证与交付

- [ ] 运行定向测试：

```bash
node ./node_modules/vitest/vitest.mjs run src/domain/contracts.test.ts src/ai/composition-review-adapter.test.ts src/ai/openai-review-adapter.test.ts 'app/(protected)/new/page.test.tsx'
```

- [ ] 运行完整测试：

```bash
node ./node_modules/vitest/vitest.mjs run
```

- [ ] 运行静态检查和构建：

```bash
npm run lint
npm run build
```

- [ ] 检查提交差异和工作树状态：

```bash
git diff --check main...HEAD
git status --short
git log --oneline main..HEAD
```

- [ ] 合并到 `main` 后在合并结果上复跑完整测试，再推送 GitHub 并执行 Cloudflare 部署。
