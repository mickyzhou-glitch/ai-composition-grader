# 示范作文字数容错实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将示范作文的总字数和分段字数都降为生成参考：目标 600 字时提示 550–700，教师填写的分段数量也只作对应段落参考；任何未达标或超出都正常返回，然后恢复并完成 `teacher01` 的 36 篇重分析任务。

**架构：** 由域层 `resolveSampleWritingRequirements` 解析结构要求中的分段字数范围；范围仅用于提示词，服务端不因总字数或分段字数低于、超过参考范围拒绝结果。模型提示词、生成流程和重写入口共享同一结果。保留段落数、Schema 和其他业务校验。

**技术栈：** TypeScript、Vitest、Next.js 16、Cloudflare Workers、D1、Queues。

---

## 文件结构

- 修改：`src/ai/sample-writing-requirements.test.ts`，覆盖新的阈值和边界行为。
- 修改：`src/domain/sample-writing-requirements.ts`，解析分段范围并保留目标字数下浮 50、上浮 100 的兜底范围。
- 修改：`src/ai/composition-review-adapter.ts`，仅在段落结构错误时使用定向修复，字数不触发修复。
- 验证：`src/ai/composition-review-adapter.test.ts` 和 `src/ai/openai-review-adapter.test.ts`，确认两条 AI 链路共享新规则。

## 任务 1：用 TDD 调整字数范围

**文件：**

- 修改：`src/ai/sample-writing-requirements.test.ts`
- 修改：`src/domain/sample-writing-requirements.ts`

- [ ] **步骤 1：编写失败的阈值测试**

将目标 600 字的提示参考解析结果保留为：

```ts
expect(resolveSampleWritingRequirements(config)).toEqual({
  paragraphCount: 5,
  minimumCharacters: 550,
  maximumCharacters: 700,
});
```

- [ ] **步骤 2：编写失败的边界测试**

对同一个 5 段配置断言总字数边界都不拒绝：

```ts
expect(() => validateSampleWritingRequirements(paragraphs(550), config)).not.toThrow();
expect(() => validateSampleWritingRequirements(paragraphs(700), config)).not.toThrow();
expect(() => validateSampleWritingRequirements(paragraphs(549), config)).not.toThrow();
expect(() => validateSampleWritingRequirements(paragraphs(701), config)).not.toThrow();
```

- [ ] **步骤 3：运行测试并确认红灯**

运行：

```bash
npm test -- src/ai/sample-writing-requirements.test.ts
```

预期：FAIL，现有实现仍会拒绝 549 个汉字。

- [ ] **步骤 4：实现最小修改**

在 `validateSampleWritingRequirements` 中只保留：

```ts
if (paragraphs.length !== expectedSampleParagraphCount(config)) {
  throw new Error("sample paragraphs invalid");
}
```

- [ ] **步骤 5：运行聚焦测试并确认绿灯**

运行：

```bash
npm test -- src/ai/sample-writing-requirements.test.ts
```

预期：该测试文件全部 PASS，低于参考下限的正文不会触发错误。

- [ ] **步骤 6：提交修复**

```bash
git add src/ai/sample-writing-requirements.test.ts src/domain/sample-writing-requirements.ts
git commit -m "fix(AI): 放宽示范作文字数范围"
```

## 任务 2：验证并部署

- [ ] **步骤 0：用 TDD 实现范文定向修复**

在 `src/ai/composition-review-adapter.test.ts` 确认分段字数不达标的完整报告直接通过，不触发定向修复；段落数量错误仍使用正文 `texts` 定向修复并复验。

- [ ] **步骤 1：运行 AI 适配器回归测试**

```bash
npm test -- src/ai/composition-review-adapter.test.ts src/ai/openai-review-adapter.test.ts
```

预期：全部 PASS，提示词说明 550–700 和分段范围都只是参考，低于或超过都可正常返回。

- [ ] **步骤 2：运行全量验证**

```bash
npm test
npm run lint
npm run build
git diff --check
```

预期：所有命令退出码为 0。

- [ ] **步骤 3：部署 Worker**

```bash
npm run cf:deploy
```

预期：Cloudflare Worker 发布成功，生成新的 Version ID。

## 任务 3：恢复 36 篇线上任务

- [ ] **步骤 1：恢复 Queue 投递**

```bash
npx wrangler queues resume-delivery ai-composition-grader-analysis
```

- [ ] **步骤 2：只重试本次已失败作文**

使用短时 `teacher01` 会话，查询 `created_at >= 1787408309871` 且本轮最新任务为 `failed` 的作文 ID，逐篇调用：

```http
POST /api/reviews/:id/analyze
Content-Type: application/json

{"mode":"content_only"}
```

入队后立即撤销短时会话。

- [ ] **步骤 3：监控到终态**

按 `review_id` 只统计本次操作之后的最新任务，直到 36 篇全部为终态。对新的失败统计 `error_code`，只重试可恢复失败，不重试已成功项。

- [ ] **步骤 4：验收线上报告**

确认 36 篇作文均为 `ready_for_review`、`teacher_reviewed_at IS NULL`，最新任务为 `succeeded`，且报告范文为 5 段；总字数和分段建议字数仅作提示词参考，低于或超过都可正常返回。
