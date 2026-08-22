# 作文结构要求逐项分析实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把教师填写的连续编号结构要求转换为模型必须逐项回答、服务端必须完整校验的结构诊断，杜绝缺项报告落库。

**架构：** 新建一个无状态的结构要求模块，集中完成编号解析、提示词规则生成和结构诊断覆盖校验。OCR 纯文本适配器与旧图片直读适配器共用该模块；报告继续使用现有 `diagnostics.structure.finding/action`，不改 Schema、数据库或公共 API。

**技术栈：** TypeScript、Zod 4、Vitest 4、React 19、Testing Library、Next.js 16.2 App Router。

---

## 文件结构

### 新建文件

- `src/ai/structure-review-requirements.ts`：解析连续编号要求、构建逐项提示规则、校验结构诊断覆盖。
- `src/ai/structure-review-requirements.test.ts`：覆盖解析、提示规则和标记校验边界。

### 修改文件

- `src/ai/composition-review-adapter.ts`：纯文本分析提示接入共享规则，并把覆盖失败映射为稳定错误码。
- `src/ai/composition-review-adapter.test.ts`：验证逐项提示、自动修复和修复失败拒绝保存。
- `src/ai/review-semantics.ts`：新报告严格语义校验接入结构覆盖检查。
- `src/ai/openai-review-adapter.ts`：旧图片链路的初次、继续、修复提示以及宽容回退均接入共享规则。
- `src/ai/openai-review-adapter.test.ts`：验证三类提示和宽容回退不能绕过覆盖检查。
- `app/(protected)/reviews/ReviewPage.tsx`：错误路径文案不再硬编码「五段结构」。
- `app/(protected)/reviews/ReviewPage.test.tsx`：验证通用结构错误文案。

## 任务 1：建立编号解析与覆盖校验模块

**文件：**
- 创建：`src/ai/structure-review-requirements.ts`
- 创建：`src/ai/structure-review-requirements.test.ts`

- [ ] **步骤 1：编写编号解析失败测试**

创建测试，定义同一行、多行与失败降级行为：

```ts
import { describe, expect, it } from "vitest";

import { parseNumberedStructureRequirements } from "./structure-review-requirements";

describe("parseNumberedStructureRequirements", () => {
  it("拆分同一行的连续编号要求", () => {
    expect(parseNumberedStructureRequirements(
      "1. 开头倒叙。 2、交代困难。 3）详写努力。 4．写出结果。 5) 回扣标题。",
    )).toEqual(["开头倒叙。", "交代困难。", "详写努力。", "写出结果。", "回扣标题。"]);
  });

  it("拆分多行连续编号要求", () => {
    expect(parseNumberedStructureRequirements("1. 开头\n2. 经过\n3. 结果"))
      .toEqual(["开头", "经过", "结果"]);
  });

  it.each([
    "开头点题，结尾升华。",
    "1. 开头点题。",
    "1. 开头点题。 3. 结尾升华。",
    "2. 先写经过。 3. 再写结果。",
  ])("无法可靠拆分时返回 null: %s", (value) => {
    expect(parseNumberedStructureRequirements(value)).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证红灯**

运行：`npm test -- src/ai/structure-review-requirements.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现最小编号解析器**

在新模块中实现：

```ts
const NUMBERED_ITEM = /(?:^|[\s])([1-9]\d?)[.、．)）]\s*/gu;

export function parseNumberedStructureRequirements(value: string): string[] | null {
  const matches = [...value.matchAll(NUMBERED_ITEM)];
  if (matches.length < 2) return null;
  const numbers = matches.map((match) => Number(match[1]));
  if (numbers.some((number, index) => number !== index + 1)) return null;
  const items = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? value.length;
    return value.slice(start, end).trim();
  });
  return items.every(Boolean) ? items : null;
}
```

- [ ] **步骤 4：运行解析测试验证绿灯**

运行：`npm test -- src/ai/structure-review-requirements.test.ts`

预期：3 个测试通过。

- [ ] **步骤 5：编写提示规则与覆盖校验失败测试**

追加测试，锁定稳定标记、状态和顺序：

```ts
import {
  buildStructureReviewRule,
  validateStructureRequirementCoverage,
} from "./structure-review-requirements";

const numbered = "1. 开头倒叙。 2. 交代困难。 3. 详写努力。";

it("为编号要求生成逐项输出规则", () => {
  const rule = buildStructureReviewRule(numbered);
  expect(rule).toContain("【第1项】");
  expect(rule).toContain("【第3项】");
  expect(rule).toContain("部分符合");
  expect(rule).toContain("原文依据");
});

it("接受按顺序完整回答的结构诊断", () => {
  expect(() => validateStructureRequirementCoverage([
    "【第1项】符合：首段先写比赛结果。",
    "【第2项】部分符合：第二段提到困难但不具体。",
    "【第3项】不符合：原文没有详写努力过程。",
  ].join("\n"), numbered)).not.toThrow();
});

it.each([
  "【第1项】符合：有依据。\n【第3项】不符合：有依据。",
  "【第1项】符合：有依据。\n【第1项】符合：有依据。\n【第3项】不符合：有依据。",
  "【第2项】符合：有依据。\n【第1项】符合：有依据。\n【第3项】不符合：有依据。",
  "【第1项】判断：有依据。\n【第2项】符合：有依据。\n【第3项】符合：有依据。",
])("拒绝不完整或无稳定状态的逐项诊断", (finding) => {
  expect(() => validateStructureRequirementCoverage(finding, numbered))
    .toThrow(/structure coverage invalid/u);
});

it("普通自然语言要求不启用逐项校验", () => {
  expect(() => validateStructureRequirementCoverage("结构基本完整。", "开头点题，结尾升华。"))
    .not.toThrow();
});
```

- [ ] **步骤 6：运行测试验证红灯**

运行：`npm test -- src/ai/structure-review-requirements.test.ts`

预期：FAIL，两个新函数尚未导出。

- [ ] **步骤 7：实现规则生成与确定性校验**

实现 `buildStructureReviewRule(value)`：普通要求返回一条逐段核对规则；编号要求列出原文，要求
`finding` 恰好输出 N 行并使用 `【第N项】符合|部分符合|不符合：原文依据`。

实现 `validateStructureRequirementCoverage(finding, value)`：逐项模式下按非空行检查行数，
并用 `^【第N项】(?:部分符合|不符合|符合)[：:]\S+` 逐行验证。失败统一抛出
`new Error("structure coverage invalid: expected=N")`。

- [ ] **步骤 8：运行模块测试并提交**

运行：`npm test -- src/ai/structure-review-requirements.test.ts`

预期：全部通过。

```bash
git add src/ai/structure-review-requirements.ts src/ai/structure-review-requirements.test.ts
git commit -m "feat(AI): 解析并校验编号结构要求"
```

## 任务 2：让 OCR 纯文本分析强制逐项覆盖

**文件：**
- 修改：`src/ai/composition-review-adapter.ts:64-97`
- 修改：`src/ai/composition-review-adapter.test.ts`
- 修改：`src/ai/review-semantics.ts:16-56`

- [ ] **步骤 1：编写纯文本提示与自动修复失败测试**

在 `composition-review-adapter.test.ts` 中构造 3 项编号配置和带完整标记的有效报告，新增：

```ts
it("逐项核对编号结构要求并修复缺项响应", async () => {
  const harness = setup();
  const numberedConfig = {
    ...config,
    structureRequirements: "1. 开头倒叙。 2. 交代困难。 3. 详写努力。",
  };
  const invalid = {
    report: { ...report, diagnostics: { ...report.diagnostics, structure: {
      finding: "结构基本完整。", action: "补充努力过程。",
    } } },
    annotationAnchors: [],
  };
  const repaired = {
    report: { ...report, diagnostics: { ...report.diagnostics, structure: {
      finding: [
        "【第1项】符合：首段先写比赛结果。",
        "【第2项】部分符合：第二段只简单提到困难。",
        "【第3项】不符合：没有详写努力过程。",
      ].join("\n"),
      action: "第二段具体交代困难，第三段补写努力过程。",
    } } },
    annotationAnchors: [],
  };
  harness.create
    .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(invalid) } }] })
    .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(repaired) } }] });

  await expect(harness.adapter.analyzeText({
    config: numberedConfig,
    pages: [{ pageIndex: 0, text: "我参加了比赛。" }],
  })).resolves.toMatchObject({ report: repaired.report });

  const firstPrompt = JSON.stringify(harness.create.mock.calls[0][0]);
  const repairPrompt = JSON.stringify(harness.create.mock.calls[1][0]);
  expect(firstPrompt).toContain("【第1项】");
  expect(firstPrompt).toContain("详写努力");
  expect(repairPrompt).toContain("structure_coverage");
});
```

另加测试：初次与修复响应都缺项时，最终错误 `upstreamCode` 为 `structure_coverage`。

- [ ] **步骤 2：运行测试验证红灯**

运行：`npm test -- src/ai/composition-review-adapter.test.ts -t "编号结构要求|缺项"`

预期：至少 1 个测试失败，因为当前提示和语义校验不检查覆盖。

- [ ] **步骤 3：接入共享规则和语义校验**

在 `contentPrompt()` 中加入：

```ts
buildStructureReviewRule(input.config.structureRequirements),
```

在 `validateGeneratedReportSemantics()` 完成现有 `validateReport()` 后调用：

```ts
validateStructureRequirementCoverage(
  report.diagnostics.structure.finding,
  config.structureRequirements,
);
```

两个适配器的错误码函数都把 `structure coverage invalid` 映射为
`structure_coverage`；`validationDetail()` 对该错误返回稳定错误码，触发现有修复请求。

- [ ] **步骤 4：运行纯文本链路测试验证绿灯**

运行：`npm test -- src/ai/structure-review-requirements.test.ts src/ai/composition-review-adapter.test.ts`

预期：全部通过。

- [ ] **步骤 5：提交纯文本链路修改**

```bash
git add src/ai/composition-review-adapter.ts src/ai/composition-review-adapter.test.ts src/ai/review-semantics.ts
git commit -m "fix(AI): 强制逐项分析结构要求"
```

## 任务 3：统一旧图片直读链路并封死宽容回退

**文件：**
- 修改：`src/ai/openai-review-adapter.ts:162-230`
- 修改：`src/ai/openai-review-adapter.ts:299-330`
- 修改：`src/ai/openai-review-adapter.ts:400-445`
- 修改：`src/ai/openai-review-adapter.test.ts`

- [ ] **步骤 1：编写三类提示失败测试**

使用编号配置分别触发初次分析、`readable=false` 后继续分析、无效响应后修复，断言对应请求均包含：

```ts
expect(JSON.stringify(harness.create.mock.calls[index][0])).toContain("【第1项】");
expect(JSON.stringify(harness.create.mock.calls[index][0])).toContain("【第3项】");
```

- [ ] **步骤 2：编写宽容回退失败测试**

让初次响应缺项，修复响应 Schema 合法但仍缺项。断言：

```ts
await expect(harness.adapter.analyze({
  config: numberedConfig,
  imageDataUrls: ["data:image/jpeg;base64,eA=="],
})).rejects.toMatchObject({
  code: "AI_INVALID_RESPONSE",
  upstreamCode: "structure_coverage",
});
```

该测试必须证明 `validateUsableEnvelope()` 的宽容回退不能保存缺项报告。

- [ ] **步骤 3：运行测试验证红灯**

运行：`npm test -- src/ai/openai-review-adapter.test.ts -t "编号结构要求|宽容回退"`

预期：提示断言失败，且缺项报告被当前宽容回退错误接受。

- [ ] **步骤 4：让三个提示构建器复用共享规则**

删除 `buildPrompt()` 内局部的 `structureReviewRule`，在 `buildPrompt()`、
`buildContinueAnalysisPrompt()` 和 `buildRepairPrompt()` 中统一加入：

```ts
buildStructureReviewRule(config.structureRequirements),
```

- [ ] **步骤 5：在宽容回退中执行覆盖校验**

`validateUsableEnvelope()` 解析出 report 后调用：

```ts
validateStructureRequirementCoverage(
  report.diagnostics.structure.finding,
  config.structureRequirements,
);
```

这项校验只约束编号覆盖，不恢复其他刻意放宽的语义限制。

- [ ] **步骤 6：运行旧链路与联合回归测试**

运行：

```bash
npm test -- src/ai/structure-review-requirements.test.ts \
  src/ai/composition-review-adapter.test.ts \
  src/ai/openai-review-adapter.test.ts
```

预期：全部通过。

- [ ] **步骤 7：提交旧链路统一修改**

```bash
git add src/ai/openai-review-adapter.ts src/ai/openai-review-adapter.test.ts
git commit -m "fix(AI): 统一两条结构分析链路"
```

## 任务 4：修正通用结构文案并完成验证

**文件：**
- 修改：`app/(protected)/reviews/ReviewPage.tsx:53-70`
- 修改：`app/(protected)/reviews/ReviewPage.test.tsx`

- [ ] **步骤 1：编写通用结构错误文案失败测试**

在页面测试中保存一个 `diagnostics.structure.finding` 为空的报告，断言显示：

```ts
expect(screen.getByText("结构要求的精准定位不能为空")).toBeInTheDocument();
expect(screen.queryByText(/五段结构/u)).not.toBeInTheDocument();
```

- [ ] **步骤 2：运行页面测试验证红灯**

运行：`npm test -- 'app/(protected)/reviews/ReviewPage.test.tsx' -t "结构要求"`

预期：FAIL，当前映射仍返回「五段结构」。

- [ ] **步骤 3：修改映射并验证页面测试**

将 `diagnosticFieldLabels.structure` 从「五段结构」改为「结构要求」。

运行：`npm test -- 'app/(protected)/reviews/ReviewPage.test.tsx'`

预期：全部通过。

- [ ] **步骤 4：运行完整静态验证**

```bash
npm test
npm run lint
npm run build
git diff --check
```

预期：所有命令退出码均为 0，无测试失败、ESLint 错误、构建错误或空白错误。

- [ ] **步骤 5：检查最终差异并提交**

```bash
git status --short
git diff --stat HEAD~3
git add 'app/(protected)/reviews/ReviewPage.tsx' \
  'app/(protected)/reviews/ReviewPage.test.tsx'
git commit -m "fix(复核): 使用通用结构要求文案"
```

- [ ] **步骤 6：完成后重新运行关键验收**

```bash
npm test -- src/ai/structure-review-requirements.test.ts \
  src/ai/composition-review-adapter.test.ts \
  src/ai/openai-review-adapter.test.ts \
  'app/(protected)/reviews/ReviewPage.test.tsx'
git status --short
```

预期：关键测试全部通过；工作区没有未提交的本任务文件。
