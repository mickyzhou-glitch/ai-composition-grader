# 批量教师审核实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 建立可连续预取的批量教师审核工作台，强制人工审核后才能导出，强化作文生活常识与前后逻辑检查，并取消已上传作文的 30 天自动删除。

**架构：** 在现有 `reviews` 记录上增加独立的 `teacherReviewedAt` 审核元数据，本机 SQLite 和 Cloudflare D1 使用相同生命周期规则。新增轻量审核队列和原子教师审核接口；批量页只缓存当前项及后继 2 项的详情与首图，现有单篇复核组件继续作为编辑基础。PDF 生成前同时在浏览器和服务端校验人工审核状态。

**技术栈：** Next.js 16.2 App Router 静态导出、React 19、TypeScript、Vitest、Testing Library、Playwright、Drizzle ORM、SQLite、Cloudflare D1/Workers、jsPDF、JSZip。

---

## 文件结构

### 新建文件

- `migrations/0007_teacher_review_retention.sql`：增加 D1 审核字段并清空历史作文到期时间。
- `app/lib/review-queue.ts`：姓名归一化、审核队列过滤、后继预取窗口和导出资格纯函数。
- `app/lib/review-queue.test.ts`：队列纯函数单元测试。
- `app/(protected)/reviews/batch/page.tsx`：批量审核静态路由入口。
- `app/(protected)/reviews/batch/BatchReviewPage.tsx`：队列加载、详情缓存、编辑、审核切换和导出清单编排。
- `app/(protected)/reviews/batch/BatchReviewPage.test.tsx`：批量审核组件行为测试。
- `app/components/ReviewExportList.tsx`：待导出文章与逻辑修改意见清单。
- `app/components/ReviewExportList.test.tsx`：导出清单资格与跳转测试。

### 修改文件

- `src/db/schema.ts`、`src/db/init.ts`：声明并迁移 `teacher_reviewed_at`，停止写入作文到期时间。
- `src/db/review-repository.ts`：水合审核字段、查询队列、原子教师审核、分析和换图时清空审核。
- `src/db/review-repository.test.ts`、`src/db/client.test.ts`：SQLite 生命周期与迁移覆盖。
- `src/services/review-service.ts`、`src/services/review-service.test.ts`：暴露队列和审核服务，复用文件锁并清理旧 PDF。
- `src/api/handlers.ts`、`src/api/handlers.test.ts`：本机 API 的队列、教师审核和导出资格校验。
- `src/cloudflare/d1-review-reader.ts`、`src/cloudflare/d1-review-reader.test.ts`：D1 审核字段与轻量队列读取。
- `src/cloudflare/d1-review-writer.ts`、`src/cloudflare/d1-review-writer.test.ts`：D1 原子教师审核与导出守卫。
- `src/cloudflare/d1-image-writer.ts`、`src/cloudflare/d1-image-writer.test.ts`：换图不设置到期时间并清空审核。
- `src/cloudflare/d1-analysis-jobs.ts`、`src/cloudflare/d1-analysis-jobs.test.ts`：重新分析时清空审核且不再按作文到期日拒绝任务。
- `worker/index.ts`、`worker/index.test.ts`：Cloudflare 队列、审核和批量导出预检路由。
- `src/pdf/pdf-service.ts`、`src/pdf/pdf-service.test.ts`、`src/pdf/pdf-batch-service.ts`、`src/pdf/pdf-batch-service.test.ts`：本机 PDF 审核状态守卫。
- `app/lib/types.ts`、`app/lib/pdf-download.ts`、`app/lib/pdf-download.test.ts`：前端审核元数据与导出预检。
- `src/retention/retention-service.ts`、`src/retention/retention-service.test.ts`：只自动清理 24 小时空草稿，保留手动删除状态机。
- `src/domain/contracts.ts`、`src/jobs/analysis-job-repository.ts`、`src/jobs/analysis-jobs.test.ts`：移除 30 天作文到期规则和任务到期判断。
- `src/ai/composition-review-adapter.ts`、`src/ai/composition-review-adapter.test.ts`、`src/ai/openai-review-adapter.ts`、`src/ai/openai-review-adapter.test.ts`：所有内容生成入口加入逻辑核查契约。
- `app/components/ReportEditor.tsx`、`app/components/ReportEditor.test.tsx`：更新两项诊断的教师可见标签。
- `app/(protected)/page.tsx`、`app/(protected)/page.test.tsx`：历史姓名搜索和批量审核入口，移除到期倒计时。
- `app/(protected)/new/page.tsx`、`app/(protected)/new/page.test.tsx`、`app/(protected)/reviews/ReviewPage.tsx`、`app/(protected)/reviews/ReviewPage.test.tsx`：移除 30 天文案并展示长期保留说明。
- `app/globals.css`：三栏桌面布局、窄屏侧栏和固定操作区样式。
- `e2e/workbench.spec.ts`：桌面与移动端连续审核和无溢出验收。
- `README.md`、`docs/private-beta-runbook.md`、`test/delivery-security.test.ts`：更新长期保留与容量管理说明。

## 任务 1：迁移审核字段并取消作文到期时间

**文件：**
- 创建：`migrations/0007_teacher_review_retention.sql`
- 修改：`src/db/schema.ts`
- 修改：`src/db/init.ts`
- 修改：`src/domain/contracts.ts`
- 测试：`src/db/client.test.ts`

- [ ] **步骤 1：编写失败的迁移测试**

在 `src/db/client.test.ts` 增加断言：新旧数据库初始化后 `reviews` 包含可空的 `teacher_reviewed_at`，历史非删除记录的 `expires_at` 被清空，重复初始化保持幂等。

```ts
expect(reviewColumns).toEqual(expect.arrayContaining([
  expect.objectContaining({ name: "teacher_reviewed_at", notnull: 0 }),
]));
expect(sqlite.prepare("SELECT expires_at FROM reviews WHERE id = ?").get("legacy-review"))
  .toEqual({ expires_at: null });
```

- [ ] **步骤 2：运行测试并确认红灯**

运行：`npm test -- src/db/client.test.ts`

预期：FAIL，缺少 `teacher_reviewed_at`，历史 `expires_at` 仍非空。

- [ ] **步骤 3：实现 SQLite 与 D1 迁移**

在 Drizzle Schema 增加：

```ts
teacherReviewedAt: integer("teacher_reviewed_at", { mode: "timestamp_ms" }),
```

在 `src/db/init.ts` 的列升级清单加入 `teacher_reviewed_at INTEGER`，并在升级事务中执行：

```sql
UPDATE reviews SET expires_at = NULL WHERE deleting_at IS NULL;
```

创建 D1 migration：

```sql
ALTER TABLE reviews ADD COLUMN teacher_reviewed_at INTEGER;
UPDATE reviews SET expires_at = NULL WHERE deleting_at IS NULL;
CREATE INDEX IF NOT EXISTS reviews_owner_teacher_reviewed_idx
  ON reviews(owner_id, teacher_reviewed_at, created_at);
```

从 `src/domain/contracts.ts` 删除 `REVIEW_RETENTION_DAYS`、`REVIEW_RETENTION_MS` 和 `reviewExpiryAt`，保留 `EMPTY_DRAFT_RETENTION_MS`。

- [ ] **步骤 4：运行迁移测试并确认绿灯**

运行：`npm test -- src/db/client.test.ts`

预期：PASS，所有数据库初始化测试通过。

- [ ] **步骤 5：提交**

```bash
git add migrations/0007_teacher_review_retention.sql src/db/schema.ts src/db/init.ts src/domain/contracts.ts src/db/client.test.ts
git commit -m "feat(数据): 增加教师审核状态并取消作文到期"
```

## 任务 2：实现本机审核生命周期与队列

**文件：**
- 修改：`src/db/review-repository.ts`
- 修改：`src/db/review-repository.test.ts`
- 修改：`src/services/review-service.ts`
- 修改：`src/services/review-service.test.ts`

- [ ] **步骤 1：编写仓储红灯测试**

覆盖以下独立行为：

```ts
it("只按创建时间列出可复核且未审核的作文", () => {
  expect(repository.listTeacherReviewQueue(OWNER).map(({ id }) => id))
    .toEqual(["old-ready", "new-ready"]);
});

it("原子保存教师修改并标记审核", () => {
  const saved = repository.completeTeacherReview(OWNER, "review-1", {
    expectedRevision: 1,
    studentName: "张小明",
    report,
    annotations: [],
  });
  expect(saved.teacherReviewedAt).toEqual(NOW);
  expect(saved.revision).toBe(2);
});

it("版本冲突时不保存修改也不标记审核", () => {
  expect(() => repository.completeTeacherReview(OWNER, "review-1", {
    expectedRevision: 0,
    report,
  })).toThrow(RevisionConflictError);
  expect(repository.requireById(OWNER, "review-1").teacherReviewedAt).toBeNull();
});
```

另测：普通 `updateTeacherEdits` 保留审核时间；开始分析、修改配置和替换图片清空审核时间；新上传图片的 `expiresAt` 保持 `null`。

- [ ] **步骤 2：运行仓储测试并确认红灯**

运行：`npm test -- src/db/review-repository.test.ts src/services/review-service.test.ts`

预期：FAIL，`ReviewRecord` 和仓储尚无教师审核 API。

- [ ] **步骤 3：实现仓储方法与字段水合**

扩展 `ReviewRecord`：

```ts
teacherReviewedAt: Date | null;
```

新增方法：

```ts
listTeacherReviewQueue(ownerId: string): ReviewRecord[];
completeTeacherReview(ownerId: string, id: string, input: TeacherReviewEdits): ReviewRecord;
```

队列查询条件固定为：owner 匹配、`deletingAt IS NULL`、`teacherReviewedAt IS NULL`、`report IS NOT NULL`、`status IN ('ready_for_review', 'exported')`、报告 OCR revision 未过期，按 `createdAt ASC`。

`completeTeacherReview` 在一个 SQLite transaction 内完成 report/annotations 校验、条件更新、revision 推进、PDF 元数据清空和审核时间写入。版本条件失败抛出 `RevisionConflictError`。

- [ ] **步骤 4：实现服务层锁与旧 PDF 清理**

在 `ReviewService` 增加：

```ts
listTeacherReviewQueue(ownerId: string) {
  return this.repository.listTeacherReviewQueue(ownerId);
}

async completeTeacherReview(ownerId: string, id: string, input: TeacherReviewEdits) {
  return this.lock.runExclusive(id, () =>
    this.fileStore.withReviewLock(ownerId, id, async () => {
      const current = this.get(ownerId, id);
      const saved = this.repository.completeTeacherReview(ownerId, id, input);
      if (current.pdfFilename) {
        await this.fileStore.queuePdfCleanup(ownerId, id, [current.pdfFilename]);
      }
      return saved;
    }),
  );
}
```

PDF 清理保持 best-effort 语义，与现有普通编辑一致。

- [ ] **步骤 5：运行测试并确认绿灯**

运行：`npm test -- src/db/review-repository.test.ts src/services/review-service.test.ts`

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add src/db/review-repository.ts src/db/review-repository.test.ts src/services/review-service.ts src/services/review-service.test.ts
git commit -m "feat(审核): 实现教师审核生命周期和待审核队列"
```

## 任务 3：实现 D1 生命周期与 Cloudflare API

**文件：**
- 修改：`src/cloudflare/d1-review-reader.ts`
- 修改：`src/cloudflare/d1-review-reader.test.ts`
- 修改：`src/cloudflare/d1-review-writer.ts`
- 修改：`src/cloudflare/d1-review-writer.test.ts`
- 修改：`src/cloudflare/d1-image-writer.ts`
- 修改：`src/cloudflare/d1-image-writer.test.ts`
- 修改：`src/cloudflare/d1-analysis-jobs.ts`
- 修改：`src/cloudflare/d1-analysis-jobs.test.ts`
- 修改：`worker/index.ts`
- 修改：`worker/index.test.ts`

- [ ] **步骤 1：编写 D1 红灯测试**

新增测试证明：

```ts
expect(await reader.queue("teacher-1")).toEqual([
  expect.objectContaining({ id: "ready-old", teacherReviewedAt: null }),
]);

await writer.completeTeacherReview("teacher-1", "review-1", {
  expectedRevision: 2,
  studentName: "张小明",
  report,
  annotations: [],
});
expect(updateSql).toContain("teacher_reviewed_at = ?");
expect(updateSql).toContain("revision = ?");
```

另测：D1 换图 SQL 设置 `teacher_reviewed_at = NULL` 且不再写 `expires_at`；分析入队清空审核且不根据 `expires_at` 拒绝；标记导出要求审核时间非空。

- [ ] **步骤 2：运行 D1 测试并确认红灯**

运行：`npm test -- src/cloudflare/d1-review-reader.test.ts src/cloudflare/d1-review-writer.test.ts src/cloudflare/d1-image-writer.test.ts src/cloudflare/d1-analysis-jobs.test.ts worker/index.test.ts`

预期：FAIL，SQL 与路由尚未包含审核字段。

- [ ] **步骤 3：实现 D1 reader 与 writer**

所有作文 SELECT 加入 `teacher_reviewed_at` 并水合为 ISO 字符串或 `null`。新增：

```ts
async queue(ownerId: string): Promise<unknown[]>;
async completeTeacherReview(ownerId: string, reviewId: string, input: unknown): Promise<boolean>;
```

writer 使用 `database.batch()`：第一条带 owner、revision、状态和报告条件的 UPDATE；后续 annotations DELETE/INSERT 都通过 `EXISTS` 绑定更新后的 revision 与同一 `teacher_reviewed_at` 时间戳。检查第一条 outcome 的 `meta.changes === 1`，否则返回版本冲突，确保失败更新不会触及批注。

- [ ] **步骤 4：增加 Worker 路由**

新增：

```text
GET  /api/reviews/review-queue
POST /api/reviews/:id/teacher-review
POST /api/reviews/export-check
```

队列响应使用 `cache-control: no-store`。审核路由把 Zod 校验错误映射为 `400`、revision 冲突映射为 `409`、跨 owner 映射为 `404`。导出预检接收去重后的 1..20 个 `{id, revision}`，只在全部记录属于当前 owner、已审核、报告非空、报告未过期且 revision 一致时返回成功。

- [ ] **步骤 5：运行 D1 与 Worker 测试并确认绿灯**

运行：`npm test -- src/cloudflare/d1-review-reader.test.ts src/cloudflare/d1-review-writer.test.ts src/cloudflare/d1-image-writer.test.ts src/cloudflare/d1-analysis-jobs.test.ts worker/index.test.ts`

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add src/cloudflare/d1-review-reader.ts src/cloudflare/d1-review-reader.test.ts src/cloudflare/d1-review-writer.ts src/cloudflare/d1-review-writer.test.ts src/cloudflare/d1-image-writer.ts src/cloudflare/d1-image-writer.test.ts src/cloudflare/d1-analysis-jobs.ts src/cloudflare/d1-analysis-jobs.test.ts worker/index.ts worker/index.test.ts
git commit -m "feat(云端审核): 增加审核队列和原子确认接口"
```

## 任务 4：收紧 PDF 导出并完成保留策略改造

**文件：**
- 修改：`src/pdf/pdf-service.ts`
- 修改：`src/pdf/pdf-service.test.ts`
- 修改：`src/pdf/pdf-batch-service.ts`
- 修改：`src/pdf/pdf-batch-service.test.ts`
- 修改：`src/api/handlers.ts`
- 修改：`src/api/handlers.test.ts`
- 修改：`app/lib/types.ts`
- 修改：`app/lib/pdf-download.ts`
- 修改：`app/lib/pdf-download.test.ts`
- 修改：`src/retention/retention-service.ts`
- 修改：`src/retention/retention-service.test.ts`
- 修改：`src/jobs/analysis-job-repository.ts`
- 修改：`src/jobs/analysis-jobs.test.ts`

- [ ] **步骤 1：编写导出与保留红灯测试**

```ts
it("拒绝导出未经过教师审核的作文", async () => {
  const { service } = harness({ current: review({ teacherReviewedAt: null }) });
  await expect(service.getOrCreate(OWNER_ID, "review-1"))
    .rejects.toMatchObject({ code: "TEACHER_REVIEW_REQUIRED" });
});

it("30 天后仍保留已上传作文，只清理超时空草稿", async () => {
  now = new Date(START.valueOf() + 31 * DAY_MS);
  await expect(service.run()).resolves.toMatchObject({ deleted: 0 });
});
```

前端测试断言 `downloadReviewPdfArchive` 在创建任一 PDF 前先调用 `/api/reviews/export-check`，并把每篇 revision 一并提交。

- [ ] **步骤 2：运行测试并确认红灯**

运行：`npm test -- src/pdf/pdf-service.test.ts src/pdf/pdf-batch-service.test.ts src/api/handlers.test.ts app/lib/pdf-download.test.ts src/retention/retention-service.test.ts src/jobs/analysis-jobs.test.ts`

预期：FAIL，未审核 PDF 仍可生成，保留服务仍处理 `expiresAt`。

- [ ] **步骤 3：实现导出守卫**

`PdfService.getOrCreate` 和 `PdfBatchService.exportBatch` 在任何浏览器渲染或文件读取前要求 `teacherReviewedAt !== null`。本机 API 增加与 Worker 相同的审核路由和批量预检 Schema。`ReviewView` 增加：

```ts
teacherReviewedAt: string | null;
```

`app/lib/pdf-download.ts` 先取得全部 review、验证本地字段，再调用：

```ts
await apiFetch("/api/reviews/export-check", {
  method: "POST",
  body: JSON.stringify({ reviews: reviews.map(({ id, revision }) => ({ id, revision })) }),
});
```

只有预检成功才生成 Blob 和触发下载。

- [ ] **步骤 4：移除作文自动到期清理**

`RetentionService.run()` 只处理两类候选：`deletingAt !== null` 的未完成删除，以及严格超过 24 小时且没有图片的空草稿。删除仓储和任务领取中基于 `expiresAt <= now` 的作文不可用条件；保留会话、登录挑战、打印 Token 和分析任务租约各自的 `expires_at`。

- [ ] **步骤 5：运行测试并确认绿灯**

运行：`npm test -- src/pdf/pdf-service.test.ts src/pdf/pdf-batch-service.test.ts src/api/handlers.test.ts app/lib/pdf-download.test.ts src/retention/retention-service.test.ts src/jobs/analysis-jobs.test.ts`

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add src/pdf src/api/handlers.ts src/api/handlers.test.ts app/lib/types.ts app/lib/pdf-download.ts app/lib/pdf-download.test.ts src/retention src/jobs/analysis-job-repository.ts src/jobs/analysis-jobs.test.ts
git commit -m "feat(导出): 仅允许已审核作文导出"
```

## 任务 5：强化 AI 生活常识与前后逻辑规则

**文件：**
- 修改：`src/ai/composition-review-adapter.ts`
- 修改：`src/ai/composition-review-adapter.test.ts`
- 修改：`src/ai/openai-review-adapter.ts`
- 修改：`src/ai/openai-review-adapter.test.ts`
- 修改：`app/components/ReportEditor.tsx`
- 修改：`app/components/ReportEditor.test.tsx`

- [ ] **步骤 1：编写提示词红灯测试**

对主生成、修复、单段重写和整篇重写请求逐一断言包含以下业务契约：

```ts
for (const phrase of [
  "少见但可能",
  "时间、地点和行动",
  "人物年龄、身份、关系与行为能力",
  "物品归属与状态",
  "原因是否足以推出结果",
  "请向学生核实",
  "不得虚构关键经历",
]) {
  expect(prompt).toContain(phrase);
}
```

另测核心事件因严重逻辑矛盾无法成立时提示要求 `grade=C`，诊断标签显示「生活常识与真实度」「前后逻辑与结构」。

- [ ] **步骤 2：运行测试并确认红灯**

运行：`npm test -- src/ai/composition-review-adapter.test.ts src/ai/openai-review-adapter.test.ts app/components/ReportEditor.test.tsx`

预期：FAIL，提示词和标签缺少完整规则。

- [ ] **步骤 3：提取并应用统一逻辑核查规则**

在两个适配器各自的提示构造边界定义固定规则文本：

```ts
const LIFE_LOGIC_REVIEW_RULE = [
  "先核对时间、地点和行动能否同时成立。",
  "核对人物年龄、身份、关系与行为能力是否符合日常生活。",
  "核对人物称呼、物品归属与状态、事件顺序和因果链是否一致。",
  "必须区分少见但可能与明显矛盾；没有原文证据时不得判错。",
  "无法确认时 action 写明请向学生核实，不得虚构关键经历。",
  "严重矛盾导致核心事件无法成立时 grade 必须为 C。",
].join("\n");
```

把规则加入内容模型主提示、继续提示、修复提示、单段重写和整篇重写。不要改变报告 Schema。

- [ ] **步骤 4：更新教师可见诊断标签**

只修改显示文案，不改字段名：

```ts
authenticityAndRelevance: "生活常识与真实度",
structure: "前后逻辑与结构",
```

- [ ] **步骤 5：运行测试并确认绿灯**

运行：`npm test -- src/ai/composition-review-adapter.test.ts src/ai/openai-review-adapter.test.ts app/components/ReportEditor.test.tsx`

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add src/ai/composition-review-adapter.ts src/ai/composition-review-adapter.test.ts src/ai/openai-review-adapter.ts src/ai/openai-review-adapter.test.ts app/components/ReportEditor.tsx app/components/ReportEditor.test.tsx
git commit -m "feat(AI): 强化生活常识与前后逻辑核查"
```

## 任务 6：增加历史姓名搜索与长期保留文案

**文件：**
- 创建：`app/lib/review-queue.ts`
- 创建：`app/lib/review-queue.test.ts`
- 修改：`app/(protected)/page.tsx`
- 修改：`app/(protected)/page.test.tsx`
- 修改：`app/(protected)/new/page.tsx`
- 修改：`app/(protected)/new/page.test.tsx`
- 修改：`app/(protected)/reviews/ReviewPage.tsx`
- 修改：`app/(protected)/reviews/ReviewPage.test.tsx`

- [ ] **步骤 1：编写搜索与文案红灯测试**

```ts
expect(filterReviewsByStudentName(reviews, "  zHANG ").map(({ id }) => id))
  .toEqual(["review-zhang"]);

await user.type(screen.getByRole("searchbox", { name: "搜索学生姓名" }), "李安然");
expect(screen.getByText("李安然")).toBeVisible();
expect(screen.queryByText("张小明")).not.toBeInTheDocument();
expect(screen.getByRole("link", { name: "开始批量审核" })).toHaveAttribute("href", "/reviews/batch");
```

页面测试同时断言不再出现「30 天」「到期」「自动永久删除」，上传说明改为长期保留并可手动删除。

- [ ] **步骤 2：运行测试并确认红灯**

运行：`npm test -- app/lib/review-queue.test.ts 'app/(protected)/page.test.tsx' 'app/(protected)/new/page.test.tsx' 'app/(protected)/reviews/ReviewPage.test.tsx'`

预期：FAIL，搜索栏和新文案不存在。

- [ ] **步骤 3：实现纯函数与首页搜索**

```ts
export function normalizeStudentSearch(value: string) {
  return value.trim().toLocaleLowerCase("zh-CN");
}

export function filterReviewsByStudentName<T extends { studentName: string }>(items: T[], query: string): T[] {
  const normalized = normalizeStudentSearch(query);
  return normalized ? items.filter(({ studentName }) => normalizeStudentSearch(studentName).includes(normalized)) : items;
}
```

首页以 `type="search"` 输入过滤可见列表，统计仍基于全部 reviews。全选只选择当前可见项，并明确显示隐藏选中项数量，避免搜索后误取消其他选择。

- [ ] **步骤 4：移除页面到期倒计时**

删除首页和单篇复核页的 `expiryNotice`、`expiresSoon` 及到期样式分支。上传确认文案改为：「作文图片与批改文件会长期保留，老师可在历史记录中手动永久删除；第三方 AI 服务的数据处理以其自身规则为准。」

- [ ] **步骤 5：运行测试并确认绿灯**

运行：`npm test -- app/lib/review-queue.test.ts 'app/(protected)/page.test.tsx' 'app/(protected)/new/page.test.tsx' 'app/(protected)/reviews/ReviewPage.test.tsx'`

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add app/lib/review-queue.ts app/lib/review-queue.test.ts app/'(protected)'/page.tsx app/'(protected)'/page.test.tsx app/'(protected)'/new/page.tsx app/'(protected)'/new/page.test.tsx app/'(protected)'/reviews/ReviewPage.tsx app/'(protected)'/reviews/ReviewPage.test.tsx
git commit -m "feat(历史记录): 增加学生姓名搜索"
```

## 任务 7：实现三栏批量审核与后继预取

**文件：**
- 创建：`app/(protected)/reviews/batch/page.tsx`
- 创建：`app/(protected)/reviews/batch/BatchReviewPage.tsx`
- 创建：`app/(protected)/reviews/batch/BatchReviewPage.test.tsx`
- 创建：`app/components/ReviewExportList.tsx`
- 创建：`app/components/ReviewExportList.test.tsx`
- 修改：`app/lib/review-queue.ts`
- 修改：`app/lib/review-queue.test.ts`
- 修改：`app/globals.css`
- 修改：`app/lib/types.ts`

- [ ] **步骤 1：编写队列与预取红灯测试**

组件测试使用 3 篇队列夹具，断言初次当前详情完成后自动请求后面 2 篇，审核成功后直接显示下一篇且不出现整页 loading：

```ts
expect(fetchMock).toHaveBeenCalledWith("/api/reviews/review-2", expect.anything());
expect(fetchMock).toHaveBeenCalledWith("/api/reviews/review-3", expect.anything());

await user.click(screen.getByRole("button", { name: "审核通过并进入下一篇" }));
expect(await screen.findByRole("heading", { name: "李安然" })).toBeVisible();
expect(screen.queryByText("正在展开作文与批改报告")).not.toBeInTheDocument();
```

另测：审核失败停留当前并保留编辑；搜索重建可见队列；未保存时切换要求确认；窄屏页签可用；队列完成显示完成状态。

- [ ] **步骤 2：运行组件测试并确认红灯**

运行：`npm test -- 'app/(protected)/reviews/batch/BatchReviewPage.test.tsx' app/components/ReviewExportList.test.tsx app/lib/review-queue.test.ts`

预期：FAIL，新页面与组件不存在。

- [ ] **步骤 3：实现路由与缓存编排**

`page.tsx` 只渲染客户端组件。`BatchReviewPage` 维护：

```ts
export interface ReviewQueueItemView {
  id: string;
  studentName: string;
  title: string;
  status: ReviewStatus;
  revision: number;
  createdAt: string;
}

const [queue, setQueue] = useState<ReviewQueueItemView[]>([]);
const [activeId, setActiveId] = useState<string | null>(null);
const cacheRef = useRef(new Map<string, ReviewView>());
const requestControllersRef = useRef(new Map<string, AbortController>());
```

每次 active/过滤队列变化，计算当前项后面 2 个 ID；并行 `apiFetch<ReviewView>`，缓存键使用 `${id}:${revision}`。详情成功后预加载首图：

```ts
const image = new Image();
image.src = `/api/reviews/${encodeURIComponent(review.id)}/files?imageId=${review.images[0].id}&variant=annotation`;
```

组件卸载或队列变化时 abort 已失效请求。审核成功后先把响应写入已审核清单，再从队列删除当前项并同步切换缓存中的下一篇。

- [ ] **步骤 4：复用现有编辑组件完成三栏 UI**

左栏使用真实 button 列表而非卡片嵌套；中栏复用 `PhotoAnnotationEditor` 和 OCR 只读/编辑页签；右栏复用 `ReportEditor`、`ParentFeedbackEditor`。底部操作固定高度，主内容使用 `minmax(0, 1fr)` 和显式 overflow，避免动态文本改变网格尺寸。

- [ ] **步骤 5：实现待导出清单**

`ReviewExportList` 接收 `ReviewView[]`，逐篇显示学生、题目、审核时间、grade、`authenticityAndRelevance` 与 `structure` 的 finding/action。未审核或无报告项禁用选择并显示原因；「返回修改」调用 `onReturnToReview(id)`。

- [ ] **步骤 6：实现响应式 CSS**

桌面使用：

```css
.batch-review-layout {
  display: grid;
  grid-template-columns: minmax(180px, 240px) minmax(360px, 1.15fr) minmax(340px, .85fr);
  min-height: calc(100dvh - var(--app-header-height));
}
```

在 `max-width: 900px` 下把队列改为可展开侧栏，正文和报告使用同级 tabpanel；底部操作区允许换行并为正文增加等高 padding。不得缩放字体随 viewport 变化。

- [ ] **步骤 7：运行组件测试并确认绿灯**

运行：`npm test -- 'app/(protected)/reviews/batch/BatchReviewPage.test.tsx' app/components/ReviewExportList.test.tsx app/lib/review-queue.test.ts`

预期：PASS。

- [ ] **步骤 8：提交**

```bash
git add app/'(protected)'/reviews/batch app/components/ReviewExportList.tsx app/components/ReviewExportList.test.tsx app/lib/review-queue.ts app/lib/review-queue.test.ts app/lib/types.ts app/globals.css
git commit -m "feat(批量审核): 增加三栏连续审核工作台"
```

## 任务 8：更新运维文档并完成浏览器验收

**文件：**
- 修改：`README.md`
- 修改：`docs/private-beta-runbook.md`
- 修改：`test/delivery-security.test.ts`
- 修改：`e2e/workbench.spec.ts`

- [ ] **步骤 1：编写文档与 E2E 红灯测试**

`test/delivery-security.test.ts` 改为断言 README 不再承诺 30 天自动删除，并包含「长期保留」「手动永久删除」「存储容量」。

在 `e2e/workbench.spec.ts` 增加桌面 1440×1000 和移动 390×844 两组流程：姓名搜索、进入批量审核、预取 3 篇、确认第 1 篇、立即显示第 2 篇、查看待导出清单。每组末尾断言：

```ts
expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
await expect(page.getByRole("button", { name: "审核通过并进入下一篇" })).toBeVisible();
```

- [ ] **步骤 2：运行测试并确认红灯**

运行：`npm test -- test/delivery-security.test.ts && npm run test:e2e -- e2e/workbench.spec.ts`

预期：FAIL，文档和 E2E mock 尚未更新。

- [ ] **步骤 3：更新文档与浏览器 mock**

README 明确：作文长期保留；教师可手动永久删除；部署方需要监控 D1/R2 或本机磁盘容量并制定备份策略。运行手册删除定期清理到期作文的操作，只保留空草稿清理和手动删除恢复检查。

E2E mock 实现 queue、详情、首图、teacher-review 和 export-check 路由，审核响应把 `teacherReviewedAt` 写为固定时间并推进 revision。

- [ ] **步骤 4：运行文档测试与 E2E**

运行：`npm test -- test/delivery-security.test.ts && npm run test:e2e -- e2e/workbench.spec.ts`

预期：PASS。

- [ ] **步骤 5：启动开发服务器并截图验收**

运行：`npm run dev`

若 `3001` 已占用，运行：`npx next dev --hostname 127.0.0.1 --port 3002`。

使用 Playwright 分别截取 1440×1000 与 390×844 的批量审核页。检查三栏/页签切换、正文不被固定栏遮挡、最长学生姓名和修改意见不溢出、首图非空且没有无意义重叠。

- [ ] **步骤 6：提交**

```bash
git add README.md docs/private-beta-runbook.md test/delivery-security.test.ts e2e/workbench.spec.ts
git commit -m "docs(数据保留): 更新长期保留与验收说明"
```

## 任务 9：完整回归与构建验证

**文件：**
- 验证：全部变更文件

- [ ] **步骤 1：运行格式与静态检查**

运行：`npm run lint`

预期：退出码 0，无 ESLint error。

- [ ] **步骤 2：运行完整单元与组件测试**

运行：`npm test`

预期：所有测试文件通过，0 failed。

- [ ] **步骤 3：运行 Cloudflare 专项测试**

运行：`npm run cf:test`

预期：全部 `src/cloudflare` 测试通过。

- [ ] **步骤 4：运行生产构建**

运行：`npm run build`

预期：Next.js 16.2 静态导出成功，`out/reviews/batch.html` 或等价导出页面存在，没有动态 Route Handler。

- [ ] **步骤 5：运行关键 E2E**

运行：`npm run test:e2e -- e2e/workbench.spec.ts`

预期：桌面与移动端流程全部通过。

- [ ] **步骤 6：检查迁移与变更完整性**

运行：

```bash
git diff --check main...HEAD
git status --short
git log --oneline main..HEAD
```

预期：无空白错误、工作树干净、提交按任务分层。

- [ ] **步骤 7：处理验证结果**

如果任何命令失败，先为实际失败行为增加或收紧对应测试，再只修改该测试指向的实现文件；重复步骤 1 至步骤 6，直到全部命令退出码为 0。没有失败时不创建额外提交。
