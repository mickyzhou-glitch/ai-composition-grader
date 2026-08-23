# 已复核标记与一键导出实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让教师复核后的作文持久显示为「已复核」，并在历史页和批量审核页一键导出所有尚未导出的已复核作文。

**架构：** 复用现有 `teacherReviewedAt` 与 `status` 字段，在前端增加统一的展示状态和已复核待导出判断。历史页直接从既有 `/api/reviews` 数据筛选；批量审核页初始化时同时读取待审核队列和历史列表，审核结果与导出结果都通过重新读取历史列表保持同步。

**技术栈：** Next.js 16.2 App Router、React 19、TypeScript、Vitest、Testing Library、Playwright、现有 PDF/ZIP 下载服务。

---

## 文件结构

### 修改文件

- `app/lib/review-queue.ts`：增加已复核待导出判断和统一展示状态纯函数。
- `app/lib/review-queue.test.ts`：覆盖已复核、待复核、已导出状态边界。
- `app/components/StatusBadge.tsx`：支持独立的「已复核」展示状态。
- `app/(protected)/reviews/ReviewPage.tsx`：单篇复核详情页使用统一展示状态。
- `app/(protected)/reviews/ReviewPage.test.tsx`：验证详情页显示已复核标记。
- `app/(protected)/page.tsx`：增加已复核统计、标记和一键导出动作。
- `app/(protected)/page.test.tsx`：覆盖历史页状态区分和一键导出筛选。
- `app/(protected)/reviews/batch/BatchReviewPage.tsx`：从持久化历史恢复清单，并增加一键导出已复核。
- `app/(protected)/reviews/batch/BatchReviewPage.test.tsx`：覆盖重新进入、筛选导出和导出后刷新。
- `app/components/ReviewExportList.tsx`：更新清单空状态文案。
- `app/components/ReviewExportList.test.tsx`：覆盖已复核待导出清单展示。
- `app/globals.css`：增加已复核徽标样式、四项统计布局和移动端响应式规则。
- `e2e/workbench.spec.ts`：增加完成审核后离开并重新进入仍能恢复导出清单的验收。

### 不修改文件

服务端路由、数据库 schema、PDF 生成逻辑、导出预检和 `ReviewView` 字段契约不变。现有
`status = "exported"` 作为导出完成后的持久状态继续使用。

---

### 任务 1：建立共享状态判断与徽标展示

**文件：**
- 修改：`app/lib/review-queue.ts`
- 测试：`app/lib/review-queue.test.ts`
- 修改：`app/components/StatusBadge.tsx`
- 修改：`app/(protected)/reviews/ReviewPage.tsx`
- 测试：`app/(protected)/reviews/ReviewPage.test.tsx`

- [ ] **步骤 1：编写失败的纯函数测试**

在 `app/lib/review-queue.test.ts` 增加以下导入和用例，固定「已复核」只代表有复核时间且还没有进入 `exported` 状态：

```ts
import {
  exportEligibility,
  filterReviewsByStudentName,
  isReviewedPendingExport,
  normalizeStudentSearch,
  reviewDisplayStatus,
  reviewPrefetchWindow,
} from "./review-queue";

it("只把已复核且未导出的记录归入已复核状态", () => {
  const reviewed = { status: "ready_for_review" as const, teacherReviewedAt: "2026-08-22T06:00:00.000Z" };
  const pending = { status: "ready_for_review" as const, teacherReviewedAt: null };
  const exported = { status: "exported" as const, teacherReviewedAt: "2026-08-22T06:00:00.000Z" };

  expect(isReviewedPendingExport(reviewed)).toBe(true);
  expect(reviewDisplayStatus(reviewed)).toBe("reviewed");
  expect(isReviewedPendingExport(pending)).toBe(false);
  expect(reviewDisplayStatus(pending)).toBe("ready_for_review");
  expect(isReviewedPendingExport(exported)).toBe(false);
  expect(reviewDisplayStatus(exported)).toBe("exported");
});
```

- [ ] **步骤 2：运行测试确认红灯**

运行：`npm test -- app/lib/review-queue.test.ts`

预期：FAIL，报错指出 `isReviewedPendingExport` 和 `reviewDisplayStatus` 尚未导出；既有搜索、预取和导出资格测试仍被收集。

- [ ] **步骤 3：实现最少的共享判断函数**

在 `app/lib/review-queue.ts` 引入 `ReviewStatus`，增加展示类型和两个纯函数：

```ts
export type ReviewDisplayStatus = ReviewStatus | "reviewed";

type ReviewLifecycleFields = Pick<ReviewView, "status" | "teacherReviewedAt">;

export function isReviewedPendingExport(review: ReviewLifecycleFields): boolean {
  return Boolean(review.teacherReviewedAt) && review.status !== "exported";
}

export function reviewDisplayStatus(review: ReviewLifecycleFields): ReviewDisplayStatus {
  return isReviewedPendingExport(review) ? "reviewed" : review.status;
}
```

用 `import type { ReviewView } from "./types"` 和 `import type { ReviewStatus } from "@/src/domain/contracts"`，不引入运行时循环依赖。

- [ ] **步骤 4：运行共享测试确认绿灯**

运行：`npm test -- app/lib/review-queue.test.ts`

预期：PASS，新增状态边界测试和原有测试全部通过。

- [ ] **步骤 5：扩展 StatusBadge 并接入详情页**

将 `StatusBadge` 的 props 改为 `status: ReviewDisplayStatus`，标签映射增加：

```ts
reviewed: "已复核",
```

在 `ReviewPage.tsx` 使用 `reviewDisplayStatus(review)` 传入徽标；详情页未复核和已导出场景继续传出原状态。

- [ ] **步骤 6：增加详情页徽标回归测试并运行**

在 `ReviewPage.test.tsx` 复用现有 `review` 夹具，设置 `teacherReviewedAt` 为非空、保持 `status: "ready_for_review"`，渲染已加载详情后断言：

```ts
expect(screen.getByText("已复核")).toBeInTheDocument();
expect(screen.queryByText("待复核")).not.toBeInTheDocument();
```

运行：`npm test -- "app/(protected)/reviews/ReviewPage.test.tsx" app/lib/review-queue.test.ts`

预期：PASS。

- [ ] **步骤 7：提交共享状态变更**

```bash
git add app/lib/review-queue.ts app/lib/review-queue.test.ts app/components/StatusBadge.tsx "app/(protected)/reviews/ReviewPage.tsx" "app/(protected)/reviews/ReviewPage.test.tsx"
git commit -m "feat(状态): 增加已复核展示状态"
```

### 任务 2：历史页显示已复核并支持一键导出

**文件：**
- 修改：`app/(protected)/page.tsx`
- 测试：`app/(protected)/page.test.tsx`
- 修改：`app/globals.css`

- [ ] **步骤 1：编写历史页失败测试**

扩展历史页测试夹具，加入 `teacherReviewedAt: null`，并新增一条已复核记录和一条已导出记录。添加以下行为测试：

```ts
it("区分待复核、已复核和已导出，并一键导出全部已复核记录", async () => {
  const reviewed = { ...review, id: "review-reviewed", studentName: "李安然", teacherReviewedAt: "2026-08-22T06:00:00.000Z" };
  const exported = { ...reviewed, id: "review-exported", status: "exported" };
  vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => json([review, reviewed, exported]));
  const user = userEvent.setup();

  render(<Home />);

  expect(await screen.findByText("已复核", { selector: ".status-badge" })).toBeInTheDocument();
  expect(screen.getByText("已复核", { selector: "dt" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "一键导出已复核（1）" }));

  await waitFor(() => expect(pdfDownloads.batch).toHaveBeenCalledWith(["review-reviewed"]));
});
```

在同一组测试中补充导出失败用例，断言页面保留「已复核」徽标并显示错误。

- [ ] **步骤 2：运行历史页测试确认红灯**

运行：`npm test -- "app/(protected)/page.test.tsx"`

预期：FAIL，当前统计没有「已复核」，也没有对应一键导出按钮。

- [ ] **步骤 3：实现历史页状态统计和一键导出**

在 `page.tsx` 引入 `isReviewedPendingExport` 与 `reviewDisplayStatus`，将统计改为：

```ts
const reviewedPendingExport = reviews.filter(isReviewedPendingExport);
const stats = {
  draft: reviews.filter(({ status }) => status === "draft").length,
  review: reviews.filter(({ status, teacherReviewedAt }) =>
    !teacherReviewedAt && ["analyzing", "needs_better_images", "ready_for_review", "failed"].includes(status),
  ).length,
  reviewed: reviewedPendingExport.length,
  exported: reviews.filter(({ status }) => status === "exported").length,
};
```

把历史卡片的 `StatusBadge` 改为 `status={reviewDisplayStatus(review)}`，在统计区增加「已复核」，在批量操作区增加：

```tsx
<button
  className="button button--primary"
  type="button"
  disabled={reviewedPendingExport.length === 0 || batchExporting || exporting !== null || reanalysisBusy}
  onClick={() => void exportReviewedPdfs()}
>
  {batchExporting ? "正在打包导出…" : `一键导出已复核（${reviewedPendingExport.length}）`}
</button>
```

`exportReviewedPdfs` 只把 `reviewedPendingExport.map(({ id }) => id)` 传给 `downloadReviewPdfArchive`，成功后调用既有 `load()`，失败时走既有 `setError(errorMessage(caught))`。

- [ ] **步骤 4：运行历史页测试确认绿灯**

运行：`npm test -- "app/(protected)/page.test.tsx"`

预期：PASS，既有选择导出、删除、搜索和重新分析测试不回归；新测试证明未复核和已导出记录没有进入一键导出参数。

- [ ] **步骤 5：调整统计和徽标响应式样式**

在 `app/globals.css`：

```css
.stats-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.status-badge--reviewed { background: #e5eef5; color: #2f5d78; }
```

在 `@media (max-width: 768px)` 将统计区改为两列，在既有 `@media (max-width: 560px)` 保持一列；保留已有按钮换行规则，确保中文按钮完整显示。

- [ ] **步骤 6：提交历史页变更**

```bash
git add "app/(protected)/page.tsx" "app/(protected)/page.test.tsx" app/globals.css
git commit -m "feat(历史): 支持一键导出已复核作文"
```

### 任务 3：批量审核页恢复持久化清单并支持一键导出

**文件：**
- 修改：`app/(protected)/reviews/batch/BatchReviewPage.tsx`
- 测试：`app/(protected)/reviews/batch/BatchReviewPage.test.tsx`
- 修改：`app/components/ReviewExportList.tsx`
- 测试：`app/components/ReviewExportList.test.tsx`

- [ ] **步骤 1：先增加重新进入和导出后的失败测试**

在 `BatchReviewPage.test.tsx` 的 fetch 夹具中增加 `/api/reviews` 响应，并新增测试数据：一条 `teacherReviewedAt` 非空且 `status: "ready_for_review"` 的记录，以及一条未复核记录。新增测试：

```ts
it("重新进入页面时从历史接口恢复已复核待导出清单", async () => {
  const queue = [queueItem("review-2", "李安然", 2)];
  const reviewed = detail("review-1", "张小明", 1);
  reviewed.teacherReviewedAt = "2026-08-22T06:00:00.000Z";
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: queue });
    if (url === "/api/reviews") return Response.json({ ok: true, data: [reviewed, detail("review-2", "李安然", 2)] });
    if (url === "/api/reviews/review-2") return Response.json({ ok: true, data: detail("review-2", "李安然", 2) });
    throw new Error(`Unexpected request: ${url}`);
  });

  render(<BatchReviewPage />);
  await userEvent.setup().click(await screen.findByRole("button", { name: "已复核待导出清单 (1)" }));

  expect(screen.getByRole("heading", { name: "张小明" })).toBeVisible();
  expect(fetchMock).toHaveBeenCalledWith("/api/reviews");
});
```

另测点击「一键导出已复核（1）」后，下载函数收到已复核 ID；历史接口返回 `status: "exported"` 后，清单计数变为 0 且显示空状态。

- [ ] **步骤 2：运行批量页和清单测试确认红灯**

运行：`npm test -- "app/(protected)/reviews/batch/BatchReviewPage.test.tsx" app/components/ReviewExportList.test.tsx`

预期：FAIL，批量页当前不会请求 `/api/reviews`，也没有持久化清单入口和一键导出按钮。

- [ ] **步骤 3：实现批量页初始化历史加载**

在批量页引入 `isReviewedPendingExport`。初始化 effect 使用 `Promise.all` 同时读取：

```ts
const [loadedQueue, loadedReviews] = await Promise.all([
  apiFetch<ReviewQueueItemView[]>("/api/reviews/review-queue"),
  apiFetch<ReviewView[]>("/api/reviews"),
]);
setQueue(loadedQueue);
setReviewed(loadedReviews.filter(isReviewedPendingExport));
setActiveId(loadedQueue[0]?.id ?? null);
```

保留现有取消请求、错误提示和详情预取行为；只有待审核队列决定当前连续审核文章，历史列表只负责导出清单恢复。

- [ ] **步骤 4：抽取批量导出并实现一键导出**

将当前 `exportSelected` 的下载逻辑抽取为接受 ID 数组的函数，成功后重新读取 `/api/reviews` 并重新过滤：

```ts
async function exportReviewIds(ids: string[]) {
  if (ids.length === 0 || exporting) return;
  setExporting(true);
  setError("");
  try {
    await downloadReviewPdfArchive(ids);
    const latest = await apiFetch<ReviewView[]>("/api/reviews");
    setReviewed(latest.filter(isReviewedPendingExport));
    setSelectedExportIds(new Set());
  } catch (caught) {
    setError(errorMessage(caught));
  } finally {
    setExporting(false);
  }
}
```

保留现有选中导出按钮，新增「一键导出已复核（N）」按钮调用 `exportReviewIds(reviewed.map(({ id }) => id))`；审核通过后的 `setReviewed` 和自动选择行为继续保留。

- [ ] **步骤 5：更新清单文案和测试夹具**

将顶部按钮文案改为 `已复核待导出清单 (N)`，空状态改为「还没有已复核待导出作文」。所有已有批量审核测试的 fetch mock 都返回 `/api/reviews`，并保留原有队列与详情响应。

运行：`npm test -- "app/(protected)/reviews/batch/BatchReviewPage.test.tsx" app/components/ReviewExportList.test.tsx`

预期：PASS，覆盖连续审核、退回重分析、预取、持久化清单和一键导出。

- [ ] **步骤 6：提交批量审核页变更**

```bash
git add "app/(protected)/reviews/batch/BatchReviewPage.tsx" "app/(protected)/reviews/batch/BatchReviewPage.test.tsx" app/components/ReviewExportList.tsx app/components/ReviewExportList.test.tsx
git commit -m "feat(批量审核): 恢复已复核导出清单"
```

### 任务 4：补充浏览器回归验收

**文件：**
- 修改：`e2e/workbench.spec.ts`

- [ ] **步骤 1：增加离开后恢复清单的浏览器场景**

在现有 `mockBatchReviewFlow` 场景中，完成一篇审核后点击「返回历史」，再次点击「开始批量审核」，验证：

```ts
await expect(page.getByRole("button", { name: "已复核待导出清单 (1)" })).toBeVisible();
await page.getByRole("button", { name: "已复核待导出清单 (1)" }).click();
await expect(page.getByRole("heading", { name: "张小明" })).toBeVisible();
```

复用现有 `Map` mock 使教师审核结果保留在第二次导航的 `/api/reviews` 响应中；不在该场景重复执行真实 PDF 生成，PDF 导出行为由组件测试覆盖。

- [ ] **步骤 2：运行浏览器测试确认通过**

运行：`npm run test:e2e -- e2e/workbench.spec.ts`

预期：该文件的桌面和移动端场景通过，页面宽度断言仍为 `document.documentElement.scrollWidth <= window.innerWidth`。

- [ ] **步骤 3：提交浏览器验收变更**

```bash
git add e2e/workbench.spec.ts
git commit -m "test(批量审核): 覆盖已复核清单恢复"
```

### 任务 5：完成前全量验证

**文件：**
- 检查：本计划涉及的全部修改文件

- [ ] **步骤 1：运行相关单元与组件测试**

运行：

```bash
npm test -- app/lib/review-queue.test.ts "app/(protected)/page.test.tsx" "app/(protected)/reviews/ReviewPage.test.tsx" "app/(protected)/reviews/batch/BatchReviewPage.test.tsx" app/components/ReviewExportList.test.tsx
```

预期：所有列出的 Vitest 测试通过，退出码为 0。

- [ ] **步骤 2：运行静态检查与构建**

运行：`npm run lint && npm run build`

预期：ESLint 无 error，Next.js 构建退出码为 0；不产生需要提交的构建产物或配置噪音。

- [ ] **步骤 3：运行完整测试套件**

运行：`npm test`

预期：Vitest 全部通过，退出码为 0。

- [ ] **步骤 4：检查需求核对表和工作区**

运行：`git diff --check && git status --short`

逐项确认：

- 未复核作文仍显示待复核或其他原有状态。
- 已复核未导出作文在历史页和批量审核页显示已复核。
- 两个页面的一键导出只传已复核未导出 ID。
- 导出成功后记录变为已导出并从清单移除。
- 既有审核、重新分析、手动导出和租户隔离测试没有回归。

- [ ] **步骤 5：记录验证结果**

只在实际读取到所有命令退出码和测试结果后报告完成；若某个命令失败，保留失败输出并继续定位，不把未验证的状态称为已完成。
