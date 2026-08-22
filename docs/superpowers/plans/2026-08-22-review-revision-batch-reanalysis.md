# 不合适退回修改与按最新框架批量重分析实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让教师能在批量审核页退回不合适的 AI 报告并立即继续下一篇，同时在历史首页预览并按同名最新保存框架批量重新分析最多 20 篇作文。

**架构：** 新增共享重分析契约与专用服务边界，SQLite 和 Cloudflare D1 分别实现等价的单篇原子入队与逐篇原子批量提交。两条流程都创建 `content_only` 任务并复用当前 OCR；前端使用专用对话框管理输入、预览和部分成功，现有页面只负责编排选择、队列切换与任务轮询。

**技术栈：** Next.js 16.2 静态导出、React 19、TypeScript、Zod 4、Vitest、Testing Library、Playwright、Drizzle ORM、SQLite、Cloudflare D1/Workers 与 Queues。

---

## 文件结构

### 新建文件

- `src/reanalysis/contracts.ts`：共享请求 Schema、响应类型、跳过代码、标题归一化与教师意见格式化。
- `src/reanalysis/contracts.test.ts`：共享契约、长度边界、标题精确匹配和稳定错误文案测试。
- `src/reanalysis/reanalysis-repository.ts`：SQLite 预览查询、单篇退回原子入队和逐篇批量原子提交。
- `src/reanalysis/reanalysis-repository.test.ts`：SQLite 所有权、版本、OCR、并发、框架更新与原子性测试。
- `src/reanalysis/reanalysis-service.ts`：把仓储结果转换为公共 API 视图，隐藏内部任务字段。
- `src/cloudflare/d1-reanalysis.ts`：D1 等价的预览、退回和批量提交能力。
- `src/cloudflare/d1-reanalysis.test.ts`：D1 SQL 守卫、batch 原子性和部分成功测试。
- `app/components/RevisionRequestDialog.tsx`：桌面对话框、移动底部面板共用的退回表单。
- `app/components/RevisionRequestDialog.test.tsx`：必填、字符上限、提交锁定和失败保留输入测试。
- `app/components/BatchReanalysisDialog.tsx`：框架分组预览、跳过清单、确认与结果状态。
- `app/components/BatchReanalysisDialog.test.tsx`：预览分组、无可提交项、部分成功和关闭行为测试。

### 修改文件

- `src/jobs/analysis-job-repository.ts`、`src/jobs/analysis-jobs.test.ts`：内部教师意见上限调整为 1100 字，保持公开手工输入 1000 字。
- `src/ai/composition-review-adapter.test.ts`、`src/ai/openai-review-adapter.test.ts`：确认退回意见进入内容模型时仍以学生原文为事实边界。
- `src/jobs/analysis-worker.ts`、`scripts/worker.ts`、`src/services/review-service.ts`、`src/jobs/analysis-jobs.test.ts`：让本机 Worker 复用已入队的任务 ID 作为分析 run ID。
- `src/runtime/application-services.ts`：装配 SQLite 重分析仓储与服务。
- `src/api/handlers.ts`、`src/api/handlers.test.ts`：新增本机单篇退回、批量预览与批量确认 handler。
- `src/cloudflare/d1-analysis-jobs.ts`、`src/cloudflare/d1-analysis-jobs.test.ts`：复用共享教师意见长度常量。
- `worker/index.ts`、`worker/index.test.ts`：新增 Worker 路由，成功提交后向 Queue 发送所有新任务。
- `app/lib/types.ts`：导出分析任务、批量预览和批量确认的前端视图类型。
- `app/(protected)/reviews/batch/BatchReviewPage.tsx`、`app/(protected)/reviews/batch/BatchReviewPage.test.tsx`：接入不合适表单、立即切换、状态轮询和队列刷新。
- `app/(protected)/page.tsx`、`app/(protected)/page.test.tsx`：接入批量重分析预览、20 篇上限、部分成功和选择保留。
- `app/globals.css`：两种对话框、移动底部面板、字符计数和结果清单样式。
- `e2e/workbench.spec.ts`：桌面与移动端两条新流程和无横向溢出验收。

## 任务 1：建立共享重分析契约

**文件：**
- 创建：`src/reanalysis/contracts.ts`
- 创建：`src/reanalysis/contracts.test.ts`
- 修改：`src/jobs/analysis-job-repository.ts`
- 修改：`src/jobs/analysis-jobs.test.ts`
- 修改：`src/cloudflare/d1-analysis-jobs.ts`
- 修改：`src/cloudflare/d1-analysis-jobs.test.ts`
- 修改：`src/ai/composition-review-adapter.test.ts`
- 修改：`src/ai/openai-review-adapter.test.ts`

- [ ] **步骤 1：编写共享契约红灯测试**

创建 `src/reanalysis/contracts.test.ts`，覆盖两个输入各自 500 字、合并后不超过内部上限、标题只做 `trim()`、批量 ID 唯一且最多 20 个：

```ts
import { describe, expect, it } from "vitest";

import {
  BATCH_REANALYSIS_LIMIT,
  MAX_ANALYSIS_TEACHER_GUIDANCE_CHARS,
  batchReanalysisPreviewInputSchema,
  formatRevisionTeacherGuidance,
  normalizeAssignmentTitle,
  revisionRequestInputSchema,
} from "./contracts";

describe("重分析共享契约", () => {
  it("格式化两个 500 字字段并保留明确标签", () => {
    const guidance = formatRevisionTeacherGuidance("原".repeat(500), "改".repeat(500));
    expect(guidance).toContain("[不合适原因]\n");
    expect(guidance).toContain("\n[修改要求]\n");
    expect(guidance.length).toBeLessThanOrEqual(MAX_ANALYSIS_TEACHER_GUIDANCE_CHARS);
  });

  it("拒绝空白和超长退回字段", () => {
    expect(() => revisionRequestInputSchema.parse({ expectedRevision: 1, reason: " ", changeRequest: "修改" })).toThrow();
    expect(() => revisionRequestInputSchema.parse({ expectedRevision: 1, reason: "原因", changeRequest: "改".repeat(501) })).toThrow();
  });

  it("标题只去除首尾空格", () => {
    expect(normalizeAssignmentTitle("  我的周末  ")).toBe("我的周末");
    expect(normalizeAssignmentTitle("My Day")).not.toBe(normalizeAssignmentTitle("my day"));
  });

  it("预览只接受 1 至 20 个唯一 ID", () => {
    expect(BATCH_REANALYSIS_LIMIT).toBe(20);
    expect(() => batchReanalysisPreviewInputSchema.parse({ reviewIds: ["review-1", "review-1"] })).toThrow();
    expect(() => batchReanalysisPreviewInputSchema.parse({ reviewIds: Array.from({ length: 21 }, (_, i) => `review-${i}`) })).toThrow();
  });
});
```

- [ ] **步骤 2：运行测试并确认红灯**

运行：`npm test -- src/reanalysis/contracts.test.ts`

预期：FAIL，`src/reanalysis/contracts.ts` 尚不存在。

- [ ] **步骤 3：实现共享常量、Schema 和公共类型**

创建 `src/reanalysis/contracts.ts`。使用现有安全 ID 规则，导出以下固定签名：

```ts
import { z } from "zod";

export const BATCH_REANALYSIS_LIMIT = 20;
export const MAX_REVISION_FIELD_CHARS = 500;
export const MAX_ANALYSIS_TEACHER_GUIDANCE_CHARS = 1_100;

const reviewIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);
const uniqueIds = z.array(reviewIdSchema).min(1).max(BATCH_REANALYSIS_LIMIT).superRefine((ids, context) => {
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "review ids must be unique" });
  }
});

export const revisionRequestInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(MAX_REVISION_FIELD_CHARS),
  changeRequest: z.string().trim().min(1).max(MAX_REVISION_FIELD_CHARS),
}).strict();

export const batchReanalysisPreviewInputSchema = z.object({ reviewIds: uniqueIds }).strict();
export const batchReanalysisCommitInputSchema = z.object({
  items: z.array(z.object({
    reviewId: reviewIdSchema,
    expectedRevision: z.number().int().nonnegative(),
    assignmentId: reviewIdSchema,
    expectedAssignmentUpdatedAt: z.string().datetime(),
  }).strict()).min(1).max(BATCH_REANALYSIS_LIMIT),
}).strict().superRefine(({ items }, context) => {
  if (new Set(items.map(({ reviewId }) => reviewId)).size !== items.length) {
    context.addIssue({ code: "custom", message: "review ids must be unique" });
  }
});

export type RevisionRequestInput = z.infer<typeof revisionRequestInputSchema>;
export type BatchReanalysisCommitItem = z.infer<typeof batchReanalysisCommitInputSchema>["items"][number];

export function normalizeAssignmentTitle(value: string): string {
  return value.trim();
}

export function formatRevisionTeacherGuidance(reason: string, changeRequest: string): string {
  const parsed = revisionRequestInputSchema.parse({ expectedRevision: 0, reason, changeRequest });
  return `[不合适原因]\n${parsed.reason}\n[修改要求]\n${parsed.changeRequest}`;
}
```

同文件定义完整公共类型。跳过代码固定为规格中的 7 种，不接受任意字符串：

```ts
export type ReanalysisSkipCode =
  | "FRAMEWORK_NOT_FOUND"
  | "FRAMEWORK_CHANGED"
  | "REVIEW_NOT_FOUND"
  | "REVISION_CONFLICT"
  | "OCR_NOT_CURRENT"
  | "ANALYSIS_ACTIVE"
  | "REVIEW_UNAVAILABLE";

export const REANALYSIS_SKIP_REASONS: Record<ReanalysisSkipCode, string> = {
  FRAMEWORK_NOT_FOUND: "没有找到同名的已保存题目框架",
  FRAMEWORK_CHANGED: "题目框架已更新，请重新预览",
  REVIEW_NOT_FOUND: "作文不存在或已不可用",
  REVISION_CONFLICT: "作文已更新，请重新预览",
  OCR_NOT_CURRENT: "识别原文不存在或已失效",
  ANALYSIS_ACTIVE: "作文正在分析中",
  REVIEW_UNAVAILABLE: "作文当前状态不能重新分析",
};

export interface PublicAnalysisJobView {
  id: string;
  reviewId: string;
  mode: "content_only";
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  progressStage: "queued" | "reading_images" | "saving_ocr" | "generating_review" | "mapping_annotations" | "validating_result" | "saving_result";
  message: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface RevisionRequestResult {
  job: PublicAnalysisJobView;
  newlyQueued: true;
}

export interface BatchReanalysisMatchedItem {
  reviewId: string;
  studentName: string;
  title: string;
  expectedRevision: number;
  assignmentId: string;
  assignmentUpdatedAt: string;
}

export interface BatchReanalysisSkippedItem {
  reviewId: string;
  studentName?: string;
  title?: string;
  code: ReanalysisSkipCode;
  reason: string;
}

export interface BatchReanalysisPreview {
  matched: BatchReanalysisMatchedItem[];
  skipped: BatchReanalysisSkippedItem[];
}

export interface BatchReanalysisSubmittedItem {
  reviewId: string;
  jobId: string;
  revision: number;
}

export interface BatchReanalysisCommitResult {
  submitted: BatchReanalysisSubmittedItem[];
  skipped: BatchReanalysisSkippedItem[];
}
```

- [ ] **步骤 4：让分析任务仓储复用 1100 字内部上限**

把 `AnalysisJobRepository.createOrGet()` 与 `D1AnalysisJobs.normalizeEnqueueInput()` 的硬编码 `1000` 改为 `MAX_ANALYSIS_TEACHER_GUIDANCE_CHARS`。现有 `createAnalyzeRouteHandlers` 的公开 Schema 继续保持 `max(1000)`，防止单篇复核页行为变化。

在 `src/jobs/analysis-jobs.test.ts` 和 `src/cloudflare/d1-analysis-jobs.test.ts` 分别增加：1100 字可由内部任务层接受，1101 字仍拒绝。

在两个 AI adapter 测试中，用格式化后的退回意见调用内容分析，断言最终 system prompt 同时包含退回标签、「与可辨认原文冲突时以原文为准」和「不得虚构关键经历」。已有规则满足时只补回归测试，不重复添加提示文本。

- [ ] **步骤 5：运行共享与任务测试并确认绿灯**

运行：`npm test -- src/reanalysis/contracts.test.ts src/jobs/analysis-jobs.test.ts src/cloudflare/d1-analysis-jobs.test.ts src/ai/composition-review-adapter.test.ts src/ai/openai-review-adapter.test.ts`

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add src/reanalysis/contracts.ts src/reanalysis/contracts.test.ts src/jobs/analysis-job-repository.ts src/jobs/analysis-jobs.test.ts src/cloudflare/d1-analysis-jobs.ts src/cloudflare/d1-analysis-jobs.test.ts src/ai/composition-review-adapter.test.ts src/ai/openai-review-adapter.test.ts
git commit -m "feat(重分析): 建立退回与批量提交契约"
```

## 任务 2：实现 SQLite 重分析仓储与服务

**文件：**
- 创建：`src/reanalysis/reanalysis-repository.ts`
- 创建：`src/reanalysis/reanalysis-repository.test.ts`
- 创建：`src/reanalysis/reanalysis-service.ts`
- 修改：`src/jobs/analysis-worker.ts`
- 修改：`scripts/worker.ts`
- 修改：`src/services/review-service.ts`
- 修改：`src/jobs/analysis-jobs.test.ts`

- [ ] **步骤 1：编写 SQLite 红灯测试**

在 `src/reanalysis/reanalysis-repository.test.ts` 使用真实临时 SQLite，覆盖：

```ts
it("原子创建退回任务并立即撤销审核", () => {
  const result = service.requestRevision(OWNER, "review-1", {
    expectedRevision: 3,
    reason: "人物关系混乱",
    changeRequest: "按原文称呼重排事件",
  });
  expect(result).toMatchObject({ newlyQueued: true, job: { mode: "content_only", status: "queued" } });
  expect(reviewRepository.requireById(OWNER, "review-1")).toMatchObject({
    status: "analyzing",
    analysisRunId: result.job.id,
    teacherReviewedAt: null,
  });
});

it("版本冲突不留下任务或半更新状态", () => {
  expect(() => service.requestRevision(OWNER, "review-1", {
    expectedRevision: 2,
    reason: "原因",
    changeRequest: "修改",
  })).toThrow(expect.objectContaining({ code: "REVISION_CONFLICT" }));
  expect(jobRepository.findLatestByReview(OWNER, "review-1")).toBeNull();
  expect(reviewRepository.requireById(OWNER, "review-1").teacherReviewedAt).not.toBeNull();
});
```

再覆盖：跨 owner 返回未找到、当前 OCR 缺失或过期、已有活动任务、删除中作文、退回意见标签；预览按输入顺序匹配同名最新框架；无框架和不可分析状态进入 `skipped`；批量确认成功项更新完整 config、revision `+1`、清空审核/PDF 并创建任务；旧报告与批注暂时保留但无法导出；一篇冲突不回滚另一篇成功。

- [ ] **步骤 2：运行 SQLite 测试并确认红灯**

运行：`npm test -- src/reanalysis/reanalysis-repository.test.ts`

预期：FAIL，重分析仓储与服务尚不存在。

- [ ] **步骤 3：实现仓储的只读预览**

`ReanalysisRepository.preview(ownerId, reviewIds)` 一次读取当前教师的作文和保存框架，再按原请求顺序组装结果。每篇依次校验：所有权、删除状态、图片数、OCR checkpoint 与 `imageRevision`、活动任务、同名框架。

公共签名固定为：

```ts
export class ReanalysisRepository {
  constructor(private readonly database: AppDatabase, options?: { now?: () => Date; createId?: () => string });

  preview(ownerId: string, reviewIds: string[]): BatchReanalysisPreview;
  requestRevision(ownerId: string, reviewId: string, input: RevisionRequestInput): AnalysisJobRecord;
  commitBatch(ownerId: string, items: BatchReanalysisCommitItem[]): BatchReanalysisCommitResult;
}
```

跨 owner 或不存在作文的跳过项只返回 ID、`REVIEW_NOT_FOUND` 和安全文案，不返回标题与学生姓名。

- [ ] **步骤 4：实现单篇与批量原子写入**

单篇退回在一个 SQLite transaction 内：重新查询 owner/revision/OCR/活动任务，生成 job ID，插入 `analysis_jobs`，更新作文为 `analyzing`，设置 `analysisRunId = jobId`，清空 `teacherReviewedAt` 与 PDF 元数据。条件失败时抛出带稳定 `code` 和 HTTP `status` 的错误，事务整体回滚。

批量确认按 item 循环，每篇开启独立 transaction。单篇事务重新匹配标题并校验 `assignmentId`、`expectedAssignmentUpdatedAt` 和 `expectedRevision`，成功后：

```ts
transaction.update(reviews).set({
  config: assignment.config,
  revision: sql`${reviews.revision} + 1`,
  status: "analyzing",
  analysisRunId: jobId,
  teacherReviewedAt: null,
  pdfFilename: null,
  pdfPath: null,
  pdfRevision: null,
  exportedAt: null,
  updatedAt: now,
});
```

同一事务插入 `mode: "content_only"` 的任务。捕获单篇业务冲突并写入 `skipped`，不要吞掉数据库损坏等未知错误。

- [ ] **步骤 5：实现服务层公共视图**

`ReanalysisService` 只暴露三种方法并把 Date 转为 ISO 字符串，不返回任务 lease、attempt、内部错误或保存框架 config：

```ts
export class ReanalysisService {
  constructor(private readonly repository: ReanalysisRepository) {}
  preview(ownerId: string, reviewIds: string[]): BatchReanalysisPreview;
  requestRevision(ownerId: string, reviewId: string, input: RevisionRequestInput): RevisionRequestResult;
  commitBatch(ownerId: string, items: BatchReanalysisCommitItem[]): BatchReanalysisCommitResult;
}
```

- [ ] **步骤 6：让本机 Worker 复用已入队 run ID**

扩展 `AnalysisExecutionService.prepare` 为 `(ownerId, reviewId, mode, runId)`，`AnalysisWorker` 传入 `claim.id`。`scripts/worker.ts` 把 runId 继续传给 `ReviewService.prepareAnalysis()`；后者使用该 runId 调用 `beginAnalysis`，确保入队时写入的 `analysisRunId` 与实际保存守卫一致。

新增测试断言 queued job ID 最终传入 `prepare`，并且 `content_only` 仍不加载图片。

- [ ] **步骤 7：运行 SQLite 与 Worker 测试并确认绿灯**

运行：`npm test -- src/reanalysis/reanalysis-repository.test.ts src/jobs/analysis-jobs.test.ts src/services/review-service.test.ts`

预期：PASS。

- [ ] **步骤 8：提交**

```bash
git add src/reanalysis/reanalysis-repository.ts src/reanalysis/reanalysis-repository.test.ts src/reanalysis/reanalysis-service.ts src/jobs/analysis-worker.ts scripts/worker.ts src/services/review-service.ts src/jobs/analysis-jobs.test.ts
git commit -m "feat(本机重分析): 实现原子退回与批量入队"
```

## 任务 3：接入本机 API handler

**文件：**
- 修改：`src/runtime/application-services.ts`
- 修改：`src/api/handlers.ts`
- 修改：`src/api/handlers.test.ts`

- [ ] **步骤 1：编写 handler 红灯测试**

在 `src/api/handlers.test.ts` 增加三个 handler 的精确请求测试：

```ts
const revision = createRevisionRequestRouteHandlers({ reanalysisService, ownerId: OWNER_ID });
const response = await revision.POST(jsonRequest(
  "http://localhost/api/reviews/review-1/revision-request",
  "POST",
  { expectedRevision: 3, reason: "人物混乱", changeRequest: "重排事件" },
), { params: Promise.resolve({ id: "review-1" }) });
expect(response.status).toBe(202);

const preview = createBatchReanalysisPreviewRouteHandlers({ reanalysisService, ownerId: OWNER_ID });
expect((await preview.POST(jsonRequest("http://localhost/api/reviews/batch-reanalysis/preview", "POST", {
  reviewIds: ["review-1", "review-2"],
}))).status).toBe(200);
```

另测确认返回 `submitted` 与 `skipped`；字段空白、重复 ID、超过 20、无效时间戳返回 `400`；revision 冲突返回 `409`；未找到返回 `404`。

- [ ] **步骤 2：运行 API 测试并确认红灯**

运行：`npm test -- src/api/handlers.test.ts`

预期：FAIL，三个 handler 工厂尚未导出。

- [ ] **步骤 3：实现 handler 与错误映射**

在 `src/api/handlers.ts` 导出：

```ts
export function createRevisionRequestRouteHandlers(dependencies: {
  reanalysisService: Pick<ReanalysisService, "requestRevision">;
  ownerId: string;
}): { POST(request: Request, context: RouteContext): Promise<Response> };

export function createBatchReanalysisPreviewRouteHandlers(dependencies: {
  reanalysisService: Pick<ReanalysisService, "preview">;
  ownerId: string;
}): { POST(request: Request): Promise<Response> };

export function createBatchReanalysisRouteHandlers(dependencies: {
  reanalysisService: Pick<ReanalysisService, "commitBatch">;
  ownerId: string;
}): { POST(request: Request): Promise<Response> };
```

直接使用任务 1 的共享 Schema，不复制 Zod 定义。单篇成功返回 `202`；预览与确认返回 `200`。`REVISION_CONFLICT`、`OCR_NOT_CURRENT`、`ANALYSIS_ACTIVE`、`REVIEW_NOT_FOUND` 映射为规格约定的安全状态和文案。

- [ ] **步骤 4：装配服务**

在 `ApplicationServices` 增加 `reanalysisService`，复用已经打开的 `database.db`：

```ts
const reanalysisService = new ReanalysisService(new ReanalysisRepository(database.db));
```

不要创建第二个数据库连接，也不要让 handler 直接访问仓储。

- [ ] **步骤 5：运行 API 与装配相关测试并确认绿灯**

运行：`npm test -- src/api/handlers.test.ts src/reanalysis/reanalysis-repository.test.ts`

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add src/runtime/application-services.ts src/api/handlers.ts src/api/handlers.test.ts
git commit -m "feat(重分析接口): 增加本机退回与批量确认处理器"
```

## 任务 4：实现 D1 原子操作与 Worker 路由

**文件：**
- 创建：`src/cloudflare/d1-reanalysis.ts`
- 创建：`src/cloudflare/d1-reanalysis.test.ts`
- 修改：`worker/index.ts`
- 修改：`worker/index.test.ts`

- [ ] **步骤 1：编写 D1 红灯测试**

用记录 SQL 与 bindings 的 D1 fake 覆盖：

```ts
it("退回请求使用 revision 与 owner 守卫原子创建 content_only 任务", async () => {
  const result = await service.requestRevision("teacher-1", "review-1", {
    expectedRevision: 3,
    reason: "人物混乱",
    changeRequest: "按原文重排",
  });
  expect(result.job).toMatchObject({ mode: "content_only", status: "queued" });
  expect(statements.some(({ sql }) => sql.includes("teacher_reviewed_at = NULL"))).toBe(true);
  expect(statements.some(({ sql }) => sql.includes("revision = ?"))).toBe(true);
});

it("批量确认逐篇原子提交并保留另一篇冲突", async () => {
  const result = await service.commitBatch("teacher-1", items);
  expect(result.submitted.map(({ reviewId }) => reviewId)).toEqual(["review-1"]);
  expect(result.skipped).toEqual([expect.objectContaining({ reviewId: "review-2", code: "FRAMEWORK_CHANGED" })]);
});
```

另测预览不执行 `run()` 或 `batch()`；跨 owner 不泄露元数据；OCR `sourceRevision` 必须等于图片 revision；活动任务唯一索引竞态映射为 `ANALYSIS_ACTIVE`；成功批量更新清空审核和全部 PDF 字段。

- [ ] **步骤 2：运行 D1 测试并确认红灯**

运行：`npm test -- src/cloudflare/d1-reanalysis.test.ts`

预期：FAIL，`D1Reanalysis` 尚不存在。

- [ ] **步骤 3：实现 D1 预览和单篇原子退回**

`D1Reanalysis.preview()` 使用 owner 限定查询读取作文和 `saved_assignments`，解析 config 与 OCR JSON 后复用共享匹配和跳过结果。

`requestRevision()` 先读取安全快照，再用单个 `database.batch()` 执行带 owner、revision、OCR、删除状态和无活动任务守卫的作文 UPDATE；第二条语句使用 `INSERT INTO analysis_jobs` 配合 `SELECT`，且只有对应作文的 `analysis_run_id = jobId` 时才产生一行。检查两条 outcome 都恰好修改 1 行，否则重新读取最小状态并返回稳定冲突；不能返回已有任务作为本次成功。

- [ ] **步骤 4：实现逐篇 D1 批量确认**

每个 item 重新读取作文与框架。通过后执行单篇原子 batch：

```sql
UPDATE reviews
SET config = (
      SELECT saved_assignments.config FROM saved_assignments
      WHERE saved_assignments.id = ? AND saved_assignments.owner_id = ?
        AND saved_assignments.updated_at = ?
        AND trim(saved_assignments.title) = trim(json_extract(reviews.config, '$.title'))
    ),
    revision = revision + 1, status = 'analyzing',
    analysis_run_id = ?, teacher_reviewed_at = NULL,
    pdf_filename = NULL, pdf_path = NULL, pdf_revision = NULL,
    exported_at = NULL, updated_at = ?
WHERE id = ? AND owner_id = ? AND revision = ? AND deleting_at IS NULL
  AND json_extract(ocr_checkpoint, '$.sourceRevision') = image_revision
  AND EXISTS (
    SELECT 1 FROM saved_assignments
    WHERE saved_assignments.id = ? AND saved_assignments.owner_id = ?
      AND saved_assignments.updated_at = ?
      AND trim(saved_assignments.title) = trim(json_extract(reviews.config, '$.title'))
  )
  AND NOT EXISTS (
    SELECT 1 FROM analysis_jobs
    WHERE review_id = reviews.id AND status IN ('queued', 'running')
  );
```

作文 UPDATE 不能只信任预查询得到的 config。它必须用 `EXISTS` 子查询再次约束 `saved_assignments.id`、owner、`updated_at` 和去空格后的标题，并通过子查询读取框架 config；这样框架在预查询和 batch 之间更新时，UPDATE 修改 0 行并返回 `FRAMEWORK_CHANGED`。

随后使用条件式 `INSERT INTO analysis_jobs SELECT`，仅从 `analysis_run_id = jobId` 的目标作文创建任务。单篇失败只产生一个 `skipped` 项；未知 D1 故障仍抛出，让整个 HTTP 请求明确失败。

- [ ] **步骤 5：编写 Worker 路由红灯测试**

在 `worker/index.test.ts` 覆盖认证、请求校验、Queue 发送和部分成功：

```ts
expect(await worker.fetch(revisionRequest, env).then((response) => response.status)).toBe(202);
expect(env.ANALYSIS_QUEUE.send).toHaveBeenCalledWith({ jobId: "job-revision" });

const body = await worker.fetch(batchCommitRequest, env).then((response) => response.json());
expect(body.data.submitted).toHaveLength(2);
expect(env.ANALYSIS_QUEUE.sendBatch).toHaveBeenCalledOnce();
expect(env.ANALYSIS_QUEUE.sendBatch.mock.calls[0][0]).toHaveLength(2);
```

确认预览不发送 Queue；提交只为 `submitted` 项发送；无效请求不执行任何数据库写入。

再模拟 `send()` 与 `sendBatch()` 抛错，断言调用 `markDispatchFailed()`、接口返回 `503`，并且响应不包含 Queue 异常文本。

- [ ] **步骤 6：增加 Worker 路由**

在具体作文 GET/PATCH 匹配之前注册：

```text
POST /api/reviews/:id/revision-request
POST /api/reviews/batch-reanalysis/preview
POST /api/reviews/batch-reanalysis
```

路由复用共享 Schema 与 `D1Reanalysis`，所有响应带 `cache-control: no-store`。单篇成功后调用 `env.ANALYSIS_QUEUE.send({ jobId })`，批量确认后使用一次调用投递全部任务：

```ts
await env.ANALYSIS_QUEUE.sendBatch(
  result.submitted.map(({ jobId }) => ({ body: { jobId } })),
);
```

为 `D1Reanalysis` 增加 `markDispatchFailed(ownerId, jobIds)` 补偿方法。Queue 投递抛错时，把仍为 `queued` 的任务标记为 `failed/QUEUE_DISPATCH_FAILED`，并把对应作文设为 `failed`、清空 `analysis_run_id`。随后返回 `503`，前端不取消任何选择；即使 Queue 在抛错前接收了消息，消费者也会因任务不再是 `queued` 而安全 ack。错误响应不得包含 D1 或 Queue 内部信息。

- [ ] **步骤 7：运行 D1 与 Worker 测试并确认绿灯**

运行：`npm test -- src/cloudflare/d1-reanalysis.test.ts worker/index.test.ts src/cloudflare/d1-analysis-jobs.test.ts`

预期：PASS。

- [ ] **步骤 8：提交**

```bash
git add src/cloudflare/d1-reanalysis.ts src/cloudflare/d1-reanalysis.test.ts worker/index.ts worker/index.test.ts
git commit -m "feat(云端重分析): 增加退回与批量框架接口"
```

## 任务 5：实现不合适表单与连续审核切换

**文件：**
- 创建：`app/components/RevisionRequestDialog.tsx`
- 创建：`app/components/RevisionRequestDialog.test.tsx`
- 修改：`app/lib/types.ts`
- 修改：`app/(protected)/reviews/batch/BatchReviewPage.tsx`
- 修改：`app/(protected)/reviews/batch/BatchReviewPage.test.tsx`
- 修改：`app/globals.css`

- [ ] **步骤 1：编写表单组件红灯测试**

```tsx
it("两项都填写后才提交修正请求", async () => {
  const onSubmit = vi.fn();
  render(<RevisionRequestDialog open submitting={false} error="" onClose={vi.fn()} onSubmit={onSubmit} />);
  const submit = screen.getByRole("button", { name: "提交后台修改并继续" });
  expect(submit).toBeDisabled();
  await user.type(screen.getByRole("textbox", { name: "为什么不合适" }), "人物关系混乱");
  await user.type(screen.getByRole("textbox", { name: "应该怎么改" }), "按原文重排事件");
  await user.click(submit);
  expect(onSubmit).toHaveBeenCalledWith({ reason: "人物关系混乱", changeRequest: "按原文重排事件" });
});
```

再测：两个 `maxLength=500`、字符计数、Escape/取消关闭、提交中锁定、`error` 出现后文本仍保留。组件关闭后由父组件决定何时清空，失败时不得重置本地 state。

- [ ] **步骤 2：运行组件测试并确认红灯**

运行：`npm test -- app/components/RevisionRequestDialog.test.tsx`

预期：FAIL，组件尚不存在。

- [ ] **步骤 3：实现可访问表单**

使用带遮罩的 `div role="dialog" aria-modal="true"`，标题为「退回后台修改」。打开时把焦点移到第一个文本域，关闭后把焦点还给「不合适」按钮；Escape 只在未提交时关闭。组件 props 固定为：

```ts
interface RevisionRequestDialogProps {
  open: boolean;
  submitting: boolean;
  error: string;
  onClose(): void;
  onSubmit(input: { reason: string; changeRequest: string }): void;
}
```

桌面样式为居中面板，`@media (max-width: 720px)` 改为贴底面板。两种视口都限制最大高度并让正文滚动；操作区不能覆盖文本域。

- [ ] **步骤 4：编写批量页集成红灯测试**

在 `BatchReviewPage.test.tsx` 增加：

```tsx
it("退回成功后立即使用预取缓存切换下一篇", async () => {
  await user.click(await screen.findByRole("button", { name: "不合适" }));
  await user.type(screen.getByRole("textbox", { name: "为什么不合适" }), "结论不符合原文");
  await user.type(screen.getByRole("textbox", { name: "应该怎么改" }), "只根据 OCR 重写报告");
  await user.click(screen.getByRole("button", { name: "提交后台修改并继续" }));
  expect(await screen.findByRole("heading", { name: "李安然" })).toBeVisible();
  expect(screen.queryByText("正在展开作文与批改报告")).not.toBeInTheDocument();
});
```

再测：请求体含 `expectedRevision`；失败保留当前作文和两个输入；dirty 状态先调用 `window.confirm`；轮询任务成功后重新请求 queue 并把作文放回列表；失败任务不进入队列并显示安全提示。

- [ ] **步骤 5：接入退回、轮询与队列刷新**

在 `BatchReviewPage` 增加 `revisionDialogOpen`、`revisionSubmitting`、`revisionError` 与 `pendingRevisionJobs`。提交调用：

```ts
const result = await apiFetch<RevisionRequestResult>(
  `/api/reviews/${encodeURIComponent(review.id)}/revision-request`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedRevision: review.revision, ...input }),
  },
);
```

成功后复用 `completeReview()` 已有的后继选择算法，但不加入 `reviewed` 或待导出集合。每 2 秒查询现有 `/api/reviews/:id/analyze/status`；只要本会话有任务从活动状态变成 `succeeded`，就刷新 `/api/reviews/review-queue`。刷新时保留当前 activeId，不抢占教师正在审核的作文；当前没有 activeId 时选择新队列第一篇。

- [ ] **步骤 6：运行批量页组件测试并确认绿灯**

运行：`npm test -- app/components/RevisionRequestDialog.test.tsx 'app/(protected)/reviews/batch/BatchReviewPage.test.tsx'`

预期：PASS。

- [ ] **步骤 7：提交**

```bash
git add app/components/RevisionRequestDialog.tsx app/components/RevisionRequestDialog.test.tsx app/lib/types.ts app/'(protected)'/reviews/batch/BatchReviewPage.tsx app/'(protected)'/reviews/batch/BatchReviewPage.test.tsx app/globals.css
git commit -m "feat(批量审核): 增加不合适退回修改流程"
```

## 任务 6：实现首页批量预览与部分成功

**文件：**
- 创建：`app/components/BatchReanalysisDialog.tsx`
- 创建：`app/components/BatchReanalysisDialog.test.tsx`
- 修改：`app/(protected)/page.tsx`
- 修改：`app/(protected)/page.test.tsx`
- 修改：`app/globals.css`

- [ ] **步骤 1：编写预览组件红灯测试**

```tsx
it("按框架分组并列出跳过原因", () => {
  render(<BatchReanalysisDialog open preview={preview} submitting={false} result={null} onClose={vi.fn()} onConfirm={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "为自己鼓掌" })).toBeVisible();
  expect(screen.getByText("将重新分析 2 篇")).toBeVisible();
  expect(screen.getByText("没有找到同名的已保存题目框架")).toBeVisible();
});

it("没有可提交作文时禁用确认", () => {
  render(<BatchReanalysisDialog open preview={{ matched: [], skipped }} submitting={false} result={null} onClose={vi.fn()} onConfirm={vi.fn()} />);
  expect(screen.getByRole("button", { name: "确认重新分析" })).toBeDisabled();
});
```

再测框架更新时间、学生姓名、当前 revision、总选择/可提交/跳过计数、确认中锁定和结果阶段成功/跳过汇总。

- [ ] **步骤 2：运行预览组件测试并确认红灯**

运行：`npm test -- app/components/BatchReanalysisDialog.test.tsx`

预期：FAIL，组件尚不存在。

- [ ] **步骤 3：实现分组预览组件**

组件只接收服务端预览，不自行匹配框架。使用 `Map<assignmentId, matched[]>` 分组，组标题显示框架题目、更新时间和篇数。跳过项使用单独的无框卡片清单，不嵌套卡片。移动端改为全高底部面板，长题目和错误原因允许换行。

固定 props：

```ts
interface BatchReanalysisDialogProps {
  open: boolean;
  preview: BatchReanalysisPreview | null;
  submitting: boolean;
  result: BatchReanalysisCommitResult | null;
  onClose(): void;
  onConfirm(): void;
}
```

- [ ] **步骤 4：编写首页集成红灯测试**

在 `app/(protected)/page.test.tsx` 增加：

```tsx
it("预览隐藏选中项并在部分成功后只取消成功项", async () => {
  await select("review-1");
  await select("review-2");
  await user.type(screen.getByRole("searchbox", { name: "搜索学生姓名" }), "张小明");
  await user.click(screen.getByRole("button", { name: "按最新框架重新分析" }));
  expect(previewRequest).toEqual({ reviewIds: ["review-1", "review-2"] });
  await user.click(screen.getByRole("button", { name: "确认重新分析" }));
  expect(screen.getByRole("checkbox", { name: "选择《跳过作文》" })).toBeChecked();
  expect(screen.getByText("已提交 1 篇，跳过 1 篇")).toBeVisible();
});
```

再测：0 篇禁用；21 篇显示上限且不请求预览；关闭预览不改选择；确认请求只携带服务端返回的 `reviewId`、revision、assignment ID 和时间戳；成功项刷新为「分析中」。

- [ ] **步骤 5：接入首页预览与确认状态**

首页增加 `reanalysisPreview`、`reanalysisResult`、`previewLoading`、`reanalysisSubmitting`。预览请求使用完整 `selectedReviewIds`，不能改用 `visibleReviews`。

确认体从 `preview.matched` 构造：

```ts
const items = preview.matched.map(({ reviewId, expectedRevision, assignmentId, assignmentUpdatedAt }) => ({
  reviewId,
  expectedRevision,
  assignmentId,
  expectedAssignmentUpdatedAt: assignmentUpdatedAt,
}));
```

收到结果后仅删除 `submitted` ID：

```ts
setSelectedReviewIds((current) => {
  const next = new Set(current);
  result.submitted.forEach(({ reviewId }) => next.delete(reviewId));
  return next;
});
await load();
```

跳过项保持选择。确认完成后对话框进入结果阶段，直到教师点击关闭，保证逐篇原因可见。

- [ ] **步骤 6：运行首页与预览组件测试并确认绿灯**

运行：`npm test -- app/components/BatchReanalysisDialog.test.tsx 'app/(protected)/page.test.tsx'`

预期：PASS。

- [ ] **步骤 7：提交**

```bash
git add app/components/BatchReanalysisDialog.tsx app/components/BatchReanalysisDialog.test.tsx app/'(protected)'/page.tsx app/'(protected)'/page.test.tsx app/globals.css
git commit -m "feat(历史记录): 增加按最新框架批量重分析"
```

## 任务 7：完成浏览器验收与发布前验证

**文件：**
- 修改：`e2e/workbench.spec.ts`
- 按验证结果修正：任务 1 至任务 6 涉及的文件

- [ ] **步骤 1：扩展 Playwright mock 状态机**

在 `mockBatchReviewFlow()` 增加 revision request、analysis status、preview 和 commit 路由。mock 必须模拟状态变化：退回后作文从 queue 消失，状态轮询成功后以新 revision 回到 queue；批量确认中一篇 submitted、一篇 skipped。

```ts
if (pathname.endsWith("/revision-request")) {
  pendingJobs.set("job-revision", { reviewId: "review-1", polls: 0 });
  await route.fulfill({ contentType: "application/json", body: json({
    newlyQueued: true,
    job: { id: "job-revision", reviewId: "review-1", mode: "content_only", status: "queued", progressStage: "queued", message: null, createdAt: NOW, finishedAt: null },
  }) });
  return;
}
```

- [ ] **步骤 2：编写桌面与移动端 E2E 场景**

对 1440 x 1000 和 390 x 844 两个视口执行：

1. 进入批量审核，点击「不合适」，填写两项并提交。
2. 断言立即显示下一篇，没有整页加载。
3. 轮询完成后断言原作文重新出现在队列，仍需审核。
4. 返回首页选择含隐藏项的多篇作文，打开预览。
5. 断言框架分组、跳过原因和计数，确认后只保留跳过项选择。
6. 检查 `document.documentElement.scrollWidth <= window.innerWidth`。
7. 保存两个视口截图并附加到 Playwright 报告。

- [ ] **步骤 3：运行新 E2E 并修正红灯**

运行：`npm run test:e2e -- e2e/workbench.spec.ts --project=chromium`

预期：PASS；截图中对话框/底部面板不遮挡输入，最长题目与错误原因不溢出。

- [ ] **步骤 4：运行完整验证**

依次运行：

```bash
npm run lint
npm test
npm run cf:test
npm run build
npm run test:e2e -- --project=chromium
git diff --check
```

预期：全部命令退出码为 0；Vitest 无失败，Next.js 静态导出完成，Playwright 桌面与移动验收通过，`git diff --check` 无输出。

- [ ] **步骤 5：检查浏览器控制台和截图**

确认 E2E 没有未处理的 `console.error`、页面异常请求或横向滚动。人工检查 Playwright 产物中的 1440 x 1000 与 390 x 844 截图，重点核对底部操作区、字符计数、分组预览和跳过原因。

- [ ] **步骤 6：提交验收测试与最终修正**

```bash
git add e2e/workbench.spec.ts app src worker scripts
git commit -m "test(重分析): 补充退回与批量框架浏览器验收"
```

- [ ] **步骤 7：请求代码审查并完成分支**

使用 `superpowers-zh:requesting-code-review` 检查规格覆盖、并发保护、租户隔离和测试缺口。修复必须项后重新执行步骤 4，再使用 `superpowers-zh:verification-before-completion` 和 `superpowers-zh:finishing-a-development-branch` 决定合并、推送与部署方式。没有用户明确授权时，不自动推送 GitHub 或部署 Cloudflare。
