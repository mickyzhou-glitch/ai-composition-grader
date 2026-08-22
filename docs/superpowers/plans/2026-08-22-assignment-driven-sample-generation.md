# 题目配置驱动的示范作文实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让示范作文严格遵循教师填写的年级、目标字数和结构格式，不再保存不足目标字数或段落数错误的结果。

**架构：** 新建一个专注的示范作文约束模块，集中解析 `AssignmentConfig`、生成模型规则并执行汉字数与段落数校验。云端纯文本分析、旧图片分析、自动修复、单段重写和全文重写共用该模块；语言年龄感通过动态提示约束，字数与段落数通过服务端确定性校验。

**技术栈：** TypeScript、Zod 4、Vitest、OpenAI 兼容 Chat Completions、React 19、Next.js 16。

---

## 文件结构

- 创建 `src/ai/sample-writing-requirements.ts`：解析示范作文约束、统计汉字、构建动态提示并校验模型结果。
- 创建 `src/ai/sample-writing-requirements.test.ts`：覆盖动态范围、汉字统计、年级提示和段落数校验。
- 修改 `src/domain/contracts.ts`：为作业配置增加兼容历史数据的 `sampleParagraphCount`，移除只适用于内置题目的固定 600–700 字校验。
- 修改 `src/domain/contracts.test.ts`：覆盖新配置字段，并保留报告基础结构测试。
- 修改 `src/ai/review-semantics.ts`：对所有题目调用统一的示范作文硬校验。
- 修改 `src/ai/composition-review-adapter.ts`：初次生成与自动修复使用教师配置驱动的规则。
- 修改 `src/ai/composition-review-adapter.test.ts`：覆盖五升六提示、600 字硬校验、修复成功与二次失败。
- 修改 `src/ai/openai-review-adapter.ts`：旧分析链路、单段重写和全文重写共用相同规则。
- 修改 `src/ai/openai-review-adapter.test.ts`：覆盖动态提示、容错回退不放行短文以及两种重写校验。
- 修改 `app/(protected)/new/page.tsx`：新建的内置与自定义作业显式保存 5 段配置。
- 修改 `app/(protected)/new/page.test.tsx`：断言创建请求保存段落数。

## 任务 1：建立统一的示范作文约束

**文件：**

- 创建：`src/ai/sample-writing-requirements.test.ts`
- 创建：`src/ai/sample-writing-requirements.ts`
- 修改：`src/domain/contracts.test.ts`
- 修改：`src/domain/contracts.ts`

- [ ] **步骤 1：为作业配置字段编写失败测试**

在 `src/domain/contracts.test.ts` 增加以下断言：

```ts
it("接受 1 至 10 段的示范作文配置并兼容历史配置", () => {
  expect(assignmentConfigSchema.parse({ ...validConfig, sampleParagraphCount: 5 }))
    .toMatchObject({ sampleParagraphCount: 5 });
  expect(assignmentConfigSchema.parse(validConfig).sampleParagraphCount).toBeUndefined();
  expect(() => assignmentConfigSchema.parse({ ...validConfig, sampleParagraphCount: 0 })).toThrow();
  expect(() => assignmentConfigSchema.parse({ ...validConfig, sampleParagraphCount: 11 })).toThrow();
  expect(() => assignmentConfigSchema.parse({ ...validConfig, sampleParagraphCount: 2.5 })).toThrow();
});
```

- [ ] **步骤 2：运行配置测试并确认红灯**

运行：

```bash
npm test -- src/domain/contracts.test.ts -t "接受 1 至 10 段"
```

预期：FAIL，解析结果会丢弃 `sampleParagraphCount`，无效数字也不会按预期失败。

- [ ] **步骤 3：实现最小配置字段**

在 `assignmentConfigSchema` 中加入：

```ts
sampleParagraphCount: z.number().int().min(1).max(10).optional(),
```

运行同一测试，预期 PASS。

- [ ] **步骤 4：为统一约束模块编写失败测试**

创建 `src/ai/sample-writing-requirements.test.ts`，覆盖以下行为：

```ts
import { describe, expect, it } from "vitest";

import type { AssignmentConfig } from "../domain/contracts";
import {
  buildSampleWritingRule,
  countSampleTextCharacters,
  resolveSampleWritingRequirements,
  validateSampleWritingRequirements,
} from "./sample-writing-requirements";

const config: AssignmentConfig = {
  title: "一次有趣的活动",
  grade: "五升六",
  writingRequirements: "围绕一次真实活动写出自己的感受。",
  targetCharacters: 600,
  structureRequirements: "全文五段，按开头、经过、高潮、结果、感受展开。",
  scoringFocus: "过程具体，感受真实。",
  templateType: "custom",
  sampleParagraphCount: 5,
};

const paragraphs = (total: number) => {
  const lengths = [120, 120, 120, 120, total - 480];
  return lengths.map((length, index) => ({
    title: `第 ${index + 1} 段`,
    text: `${"文".repeat(length)}，。123ABC`,
    suggestion: "修改建议不计入字数。",
  }));
};

describe("sample writing requirements", () => {
  it("按目标字数生成 600 至 660 个汉字的动态范围", () => {
    expect(resolveSampleWritingRequirements(config)).toEqual({
      paragraphCount: 5,
      minimumCharacters: 600,
      maximumCharacters: 660,
    });
    expect(countSampleTextCharacters(paragraphs(600))).toBe(600);
  });

  it.each([599, 661])("拒绝合计 %i 个汉字的示范正文", (total) => {
    expect(() => validateSampleWritingRequirements(paragraphs(total), config))
      .toThrow(/expectedCharacters=600\.\.660/u);
  });

  it("拒绝段落数不符合题目配置的示范正文", () => {
    expect(() => validateSampleWritingRequirements(paragraphs(600).slice(0, 4), config))
      .toThrow(/expectedParagraphs=5/u);
  });

  it("提示词逐项保留教师配置并限定五升六学生水平", () => {
    const rule = buildSampleWritingRule(config);
    expect(rule).toContain("五升六");
    expect(rule).toContain("600-660");
    expect(rule).toContain(config.writingRequirements);
    expect(rule).toContain(config.structureRequirements);
    expect(rule).toContain(config.scoringFocus);
    expect(rule).toContain("不得写成初中生或成人范文");
  });
});
```

- [ ] **步骤 5：运行约束测试并确认红灯**

运行：

```bash
npm test -- src/ai/sample-writing-requirements.test.ts
```

预期：FAIL，模块尚不存在。

- [ ] **步骤 6：实现最小统一约束模块**

创建 `src/ai/sample-writing-requirements.ts`：

```ts
import type { AssignmentConfig } from "../domain/contracts";

interface SampleParagraphLike {
  title: string;
  text: string;
  suggestion: string;
}

export interface SampleWritingRequirements {
  paragraphCount: number;
  minimumCharacters: number;
  maximumCharacters: number;
}

export function resolveSampleWritingRequirements(
  config: AssignmentConfig,
): SampleWritingRequirements {
  return {
    paragraphCount: config.sampleParagraphCount ?? 5,
    minimumCharacters: config.targetCharacters,
    maximumCharacters: Math.ceil(config.targetCharacters * 1.1),
  };
}

export function countSampleTextCharacters(
  paragraphs: SampleParagraphLike[],
): number {
  return paragraphs.reduce(
    (total, paragraph) => total + (paragraph.text.match(/\p{Script=Han}/gu)?.length ?? 0),
    0,
  );
}

export function validateSampleWritingRequirements(
  paragraphs: SampleParagraphLike[],
  config: AssignmentConfig,
): void {
  const expected = resolveSampleWritingRequirements(config);
  const actualCharacters = countSampleTextCharacters(paragraphs);
  if (
    paragraphs.length !== expected.paragraphCount ||
    actualCharacters < expected.minimumCharacters ||
    actualCharacters > expected.maximumCharacters
  ) {
    throw new Error(
      `sample paragraphs invalid: expectedParagraphs=${expected.paragraphCount}; ` +
      `actualParagraphs=${paragraphs.length}; ` +
      `expectedCharacters=${expected.minimumCharacters}..${expected.maximumCharacters}; ` +
      `actualCharacters=${actualCharacters}`,
    );
  }
}

export function buildSampleWritingRule(config: AssignmentConfig): string {
  const expected = resolveSampleWritingRequirements(config);
  return [
    "教师填写的作业配置是唯一标准，通用教学建议不得覆盖或改写它。",
    `范文作者的学生水平必须严格符合：${JSON.stringify(config.grade)}。`,
    "年级指学生实际能自然写出的水平，不是批改老师的身份；不得写成初中生或成人范文。",
    `写作要求：${JSON.stringify(config.writingRequirements)}`,
    `结构与格式：${JSON.stringify(config.structureRequirements)}`,
    `评分重点：${JSON.stringify(config.scoringFocus)}`,
    `sampleParagraphs 必须恰好 ${expected.paragraphCount} 段。`,
    `只统计各段 text 的汉字，合计必须为 ${expected.minimumCharacters}-${expected.maximumCharacters} 个汉字；title、suggestion 和标点不计入。`,
    "输出前自查词汇、句式、修辞和感悟是否符合指定学生水平，并保留小学生真实自然的口吻。",
  ].join("\n");
}
```

- [ ] **步骤 7：移除报告基础 Schema 中的固定模板字数规则**

从 `src/domain/contracts.ts` 删除私有 `countChineseCharacters` 以及 `createEvaluationReportSchema` 中只对 `preset_self_applause` 写死 5 段、600–700 字的 `superRefine`。保留函数签名以兼容调用方：

```ts
export function createEvaluationReportSchema(_templateType: TemplateType) {
  return evaluationReportSchema;
}
```

同步把 `src/domain/contracts.test.ts` 中固定模板字数测试改为只验证报告基础结构；精确字数与段落数由新模块测试负责。

- [ ] **步骤 8：运行领域与约束测试并确认绿灯**

运行：

```bash
npm test -- src/domain/contracts.test.ts src/ai/sample-writing-requirements.test.ts
```

预期：两个测试文件全部 PASS。

- [ ] **步骤 9：提交统一约束模块**

```bash
git add src/domain/contracts.ts src/domain/contracts.test.ts src/ai/sample-writing-requirements.ts src/ai/sample-writing-requirements.test.ts
git commit -m "feat(AI): 统一示范作文字数与段落约束"
```

## 任务 2：让云端内容生成严格遵循教师配置

**文件：**

- 修改：`src/ai/composition-review-adapter.test.ts`
- 修改：`src/ai/composition-review-adapter.ts`
- 修改：`src/ai/review-semantics.ts`

- [ ] **步骤 1：把测试夹具改成符合配置的五段范文**

在 `src/ai/composition-review-adapter.test.ts` 的 `config` 中加入 `sampleParagraphCount: 5`，并把共享 `report.sampleParagraphs` 改成 5 段、合计 500 个汉字，以满足该测试配置的 500–550 字范围：

```ts
sampleParagraphs: Array.from({ length: 5 }, (_, index) => ({
  title: `第 ${index + 1} 段`,
  text: "我".repeat(100),
  suggestion: "补充心理变化。",
})),
```

- [ ] **步骤 2：编写提示词与短文修复的失败测试**

增加两个适配器测试：

```ts
it("uses the teacher assignment as the only sample-writing standard", async () => {
  const harness = setup();
  await harness.adapter.analyzeText({
    config: {
      ...config,
      grade: "五升六",
      targetCharacters: 600,
      writingRequirements: "写一次真实活动。",
      structureRequirements: "全文五段。",
      scoringFocus: "过程具体。",
    },
    pages: [{ pageIndex: 0, text: "我参加了跳绳比赛。" }],
    studentName: "小艾",
  }).catch(() => undefined);

  const prompt = JSON.stringify(harness.create.mock.calls[0][0]);
  expect(prompt).toContain("五升六");
  expect(prompt).toContain("600-660");
  expect(prompt).toContain("不得写成初中生或成人范文");
  expect(prompt).toContain("全文五段");
});

it("repairs a short sample once and rejects it when it is still short", async () => {
  const harness = setup();
  const shortReport = {
    ...report,
    sampleParagraphs: report.sampleParagraphs.map((paragraph) => ({
      ...paragraph,
      text: "我".repeat(90),
    })),
  };
  harness.create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({
    report: shortReport,
    annotationAnchors: [],
  }) } }] });

  await expect(harness.adapter.analyzeText({
    config,
    pages: [{ pageIndex: 0, text: "我参加了跳绳比赛。" }],
    studentName: "小艾",
  })).rejects.toMatchObject({
    code: "AI_INVALID_RESPONSE",
    upstreamCode: "sample_paragraphs",
  });
  expect(harness.create).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(harness.create.mock.calls[1][0])).toContain("actualCharacters=450");
});
```

- [ ] **步骤 3：运行新增测试并确认红灯**

运行：

```bash
npm test -- src/ai/composition-review-adapter.test.ts -t "teacher assignment|short sample"
```

预期：FAIL。当前自定义题目提示仍写 1–10 段且不含动态范围，450 字响应会被直接保存。

- [ ] **步骤 4：接入统一提示与硬校验**

在 `src/ai/review-semantics.ts` 中导入并调用：

```ts
validateSampleWritingRequirements(report.sampleParagraphs, config);
```

删除只对 `preset_self_applause` 检查 5 段的旧分支。

在 `src/ai/composition-review-adapter.ts` 中用 `buildSampleWritingRule(input.config)` 替换模板类型分支，并让 `validationCode` 把包含 `sample paragraphs invalid` 的错误稳定映射为 `sample_paragraphs`。

另增加只向修复请求提供内部校验详情的辅助函数：

```ts
function validationDetail(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("sample paragraphs invalid:")) {
    return error.message;
  }
  return validationCode(error);
}
```

修复请求中的 `validationError` 使用 `validationDetail(initialError)`，最终 `upstreamCode` 仍使用 `validationCode(repairError)`。这样模型能看到实际字数，公开错误分类仍保持稳定。

- [ ] **步骤 5：运行云端内容适配器测试并确认绿灯**

运行：

```bash
npm test -- src/ai/composition-review-adapter.test.ts
```

预期：该测试文件全部 PASS；短文会调用 2 次模型并以 `sample_paragraphs` 失败。

- [ ] **步骤 6：提交云端生成修复**

```bash
git add src/ai/composition-review-adapter.ts src/ai/composition-review-adapter.test.ts src/ai/review-semantics.ts
git commit -m "fix(AI): 按题目配置生成示范作文"
```

## 任务 3：统一旧分析链路与示范文重写

**文件：**

- 修改：`src/ai/openai-review-adapter.test.ts`
- 修改：`src/ai/openai-review-adapter.ts`

- [ ] **步骤 1：编写旧链路与重写的失败测试**

在 `src/ai/openai-review-adapter.test.ts` 增加以下行为断言：

```ts
it("all image-analysis prompts use the configured grade and character range", async () => {
  const harness = setup([JSON.stringify(successEnvelope)]);
  await harness.adapter.analyze({
    config: { ...config, grade: "五升六" },
    imageDataUrls: ["data:image/jpeg;base64,eA=="],
  });
  const prompt = JSON.stringify(harness.create.mock.calls[0][0]);
  expect(prompt).toContain("五升六");
  expect(prompt).toContain("600-660");
  expect(prompt).toContain("不得写成初中生或成人范文");
});

it("does not let the tolerant repair fallback save a short sample", async () => {
  const shortEnvelope = {
    ...successEnvelope,
    report: {
      ...report,
      sampleParagraphs: report.sampleParagraphs.map((paragraph) => ({
        ...paragraph,
        text: "我".repeat(100),
      })),
    },
  };
  const harness = setup([JSON.stringify(shortEnvelope), JSON.stringify(shortEnvelope)]);
  await expect(harness.adapter.analyze({
    config,
    imageDataUrls: ["data:image/jpeg;base64,eA=="],
  })).rejects.toMatchObject({
    code: "AI_INVALID_RESPONSE",
    upstreamCode: "sample_paragraph_count",
  });
});

it("rejects a single-paragraph rewrite that leaves the whole sample short", async () => {
  const harness = setup([JSON.stringify({ text: "我".repeat(20) })]);
  await expect(harness.adapter.rewriteSample({
    config,
    sampleParagraphs: report.sampleParagraphs,
    index: 0,
  })).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE" });
});

it("validates full rewrites against configured paragraph and character limits", async () => {
  const shortSamples = report.sampleParagraphs.map((paragraph) => ({
    ...paragraph,
    text: "我".repeat(100),
  }));
  const harness = setup([JSON.stringify({ sampleParagraphs: shortSamples })]);
  await expect(harness.adapter.rewriteAllSamples({
    config,
    sampleParagraphs: report.sampleParagraphs,
  })).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE" });
});
```

- [ ] **步骤 2：运行新增测试并确认红灯**

运行：

```bash
npm test -- src/ai/openai-review-adapter.test.ts -t "configured grade|tolerant repair fallback|single-paragraph rewrite|full rewrites"
```

预期：至少 3 个用例 FAIL；旧提示固定为 600–700，容错回退和两种重写会放行短文。

- [ ] **步骤 3：让图片分析与修复提示使用统一规则**

在 `buildPrompt`、`buildContinueAnalysisPrompt` 和 `buildRepairPrompt` 中加入 `buildSampleWritingRule(config)`，删除固定的五段、600–700 字样和覆盖教师年级的硬编码句子。`buildRepairPrompt` 新增一个内部 `validationDetail` 参数，用于携带统一校验错误中的期望与实际字数；最终 `AiAdapterError.upstreamCode` 仍只使用稳定的 `safeValidationCode`。

在 `validateUsableEnvelope` 返回前调用：

```ts
validateSampleWritingRequirements(report.sampleParagraphs, config);
```

更新 `safeValidationCode`，把统一校验错误映射为 `sample_paragraph_count`，确保容错回退不能绕过字数或段落数硬约束。

- [ ] **步骤 4：让两种重写使用统一提示与校验**

`rewriteSample` 解析新段落后，替换对应索引并校验整篇：

```ts
const parsed = z.object({ text: z.string().trim().min(1).max(2_000) })
  .parse(parseJsonResponse(content));
const nextParagraphs = input.sampleParagraphs.map((paragraph, index) =>
  index === input.index ? { ...paragraph, text: parsed.text } : paragraph,
);
validateSampleWritingRequirements(nextParagraphs, input.config);
return parsed;
```

`rewriteAllSamples` 的数组长度使用 `resolveSampleWritingRequirements(input.config).paragraphCount`，解析后调用 `validateSampleWritingRequirements`。两个提示都加入 `buildSampleWritingRule(input.config)`，不再写死五段或 600–700 字。

- [ ] **步骤 5：运行旧适配器测试并确认绿灯**

运行：

```bash
npm test -- src/ai/openai-review-adapter.test.ts
```

预期：该测试文件全部 PASS；短文不再被容错回退或重写入口放行。

- [ ] **步骤 6：提交旧链路与重写修复**

```bash
git add src/ai/openai-review-adapter.ts src/ai/openai-review-adapter.test.ts
git commit -m "fix(AI): 统一示范作文重写约束"
```

## 任务 4：让新作业显式保存示范段落数

**文件：**

- 修改：`app/(protected)/new/page.test.tsx`
- 修改：`app/(protected)/new/page.tsx`

- [ ] **步骤 1：编写创建请求失败测试**

扩展现有「填写学生姓名后按调整后的四图顺序上传」测试的请求断言：

```ts
expect(JSON.parse((reviewRequest[1] as RequestInit).body as string)).toMatchObject({
  studentName: "李羿辰",
  config: {
    title: "为自己鼓掌",
    sampleParagraphCount: 5,
  },
});
```

- [ ] **步骤 2：运行页面测试并确认红灯**

运行：

```bash
npm test -- 'app/(protected)/new/page.test.tsx' -t "填写学生姓名"
```

预期：FAIL，请求中的配置缺少 `sampleParagraphCount`。

- [ ] **步骤 3：为两种新建配置增加默认段落数**

在 `presetConfig` 与 `customConfig` 中加入：

```ts
sampleParagraphCount: 5,
```

不增加新的可见表单控件。

- [ ] **步骤 4：运行页面测试并确认绿灯**

运行：

```bash
npm test -- 'app/(protected)/new/page.test.tsx'
```

预期：该测试文件全部 PASS。

- [ ] **步骤 5：提交新建配置修复**

```bash
git add 'app/(protected)/new/page.tsx' 'app/(protected)/new/page.test.tsx'
git commit -m "fix(题目): 保存示范作文段落约束"
```

## 任务 5：全量验证

**文件：**

- 验证：`src/domain/contracts.ts`
- 验证：`src/ai/sample-writing-requirements.ts`
- 验证：`src/ai/review-semantics.ts`
- 验证：`src/ai/composition-review-adapter.ts`
- 验证：`src/ai/openai-review-adapter.ts`
- 验证：`app/(protected)/new/page.tsx`

- [ ] **步骤 1：运行定向回归测试**

```bash
npm test -- src/domain/contracts.test.ts src/ai/sample-writing-requirements.test.ts src/ai/composition-review-adapter.test.ts src/ai/openai-review-adapter.test.ts 'app/(protected)/new/page.test.tsx'
```

预期：全部 PASS，0 个失败。

- [ ] **步骤 2：运行全量单元测试**

```bash
npm test
```

预期：所有测试文件通过，0 个失败。

- [ ] **步骤 3：运行 Lint 与类型检查**

```bash
npm run lint
npx tsc --noEmit
```

预期：两个命令退出码均为 0，无 ESLint 或 TypeScript 错误。

- [ ] **步骤 4：运行生产构建**

```bash
npm run build
```

预期：Next.js 生产构建成功，退出码为 0。

- [ ] **步骤 5：检查差异与提交状态**

```bash
git diff --check
git status --short
git log -6 --oneline
```

预期：`git diff --check` 无输出；工作树干净；最近提交只包含本规格对应的计划和实现。
