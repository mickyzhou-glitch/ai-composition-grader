# 详情页直接导出 PDF 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让作文详情页一次点击保存当前复核内容、完成教师复核确认并下载 PDF，无需返回批量审核页。

**架构：** 保留 `downloadReviewPdf` 和批量导出的既有资格校验。仅在 `ReviewPage` 的导出编排中，当记录未复核或页面存在未保存修改时，先调用现有教师复核接口并应用返回的最新记录，再调用现有下载函数。

**技术栈：** Next.js 16 Client Component、React 19、TypeScript、Vitest、React Testing Library。

---

## 文件结构

- 修改：`app/(protected)/reviews/ReviewPage.tsx`，编排详情页的保存、复核与 PDF 下载。
- 修改：`app/(protected)/reviews/ReviewPage.test.tsx`，覆盖直接导出、未保存修改和失败保护行为。

### 任务 1：用失败测试定义详情页直接导出

**文件：**
- 测试：`app/(protected)/reviews/ReviewPage.test.tsx`

- [ ] **步骤 1：为未复核记录添加先复核后下载测试**

在现有导出测试附近添加用例：初始记录的 `teacherReviewedAt` 为 `null`；点击「导出 PDF」后，断言先向教师复核接口提交当前内容，再调用 `downloadReviewPdf`。

```tsx
it("未复核记录点击导出时先保存为教师已复核再下载", async () => {
  const reviewed = { ...review, revision: 2, teacherReviewedAt: "2026-08-23T08:00:00.000Z" };
  const fetchMock = vi.spyOn(globalThis, "fetch")
    .mockImplementationOnce(() => json({ ...review, teacherReviewedAt: null }))
    .mockImplementationOnce(() => json({ job: null }))
    .mockImplementationOnce(() => json(reviewed))
    .mockImplementationOnce(() => json({ ...reviewed, status: "exported" }));
  const user = userEvent.setup();
  render(<ReviewPage />);

  await user.click(await screen.findByRole("button", { name: "导出 PDF" }));

  await waitFor(() => expect(pdfDownloads.single).toHaveBeenCalledWith("review-1"));
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/reviews/review-1/teacher-review",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        expectedRevision: 1,
        studentName: "",
        report: review.report,
        annotations: [],
      }),
    }),
  );
});
```

- [ ] **步骤 2：把原有未保存修改测试改成自动保存并导出**

编辑报告后断言按钮仍可用；点击后提交编辑后的报告；下载在教师复核成功后发生。

```tsx
await user.clear(screen.getByLabelText("优点一"));
await user.type(screen.getByLabelText("优点一"), "导出时保存的修改");
expect(exportButton).toBeEnabled();
await user.click(exportButton);
await waitFor(() => expect(pdfDownloads.single).toHaveBeenCalledWith("review-1"));
expect(JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body))).toMatchObject({
  expectedRevision: 1,
  report: { personalizedComment: "导出时保存的修改" },
});
```

- [ ] **步骤 3：添加已复核直下和复核失败保护测试**

已复核且无本地修改时断言没有教师复核请求；教师复核接口返回错误时断言不调用下载、编辑内容仍显示且按钮恢复可用。

```tsx
expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/teacher-review"))).toBe(false);
expect(pdfDownloads.single).toHaveBeenCalledWith("review-1");

await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("保存失败，请重试"));
expect(pdfDownloads.single).not.toHaveBeenCalled();
expect(screen.getByLabelText("优点一")).toHaveValue("需要保留的修改");
expect(screen.getByRole("button", { name: "导出 PDF" })).toBeEnabled();
```

- [ ] **步骤 4：运行测试，确认因现有行为而失败**

运行：

```bash
npm test -- 'app/(protected)/reviews/ReviewPage.test.tsx' -t '导出|未保存修改|未复核|已复核'
```

预期：FAIL。未保存修改时按钮被禁用，且未复核时没有调用教师复核接口。

### 任务 2：实现按需复核后导出

**文件：**
- 修改：`app/(protected)/reviews/ReviewPage.tsx:536`
- 测试：`app/(protected)/reviews/ReviewPage.test.tsx`

- [ ] **步骤 1：在导出函数中校验并按需完成教师复核**

当 `dirty || !review.teacherReviewedAt` 时调用教师复核接口，成功后应用返回记录并清除 `dirty`。

```tsx
async function exportPdf() {
  if (!review || !report || busy) return;
  const validationMessage = reportValidationMessage(report);
  if (validationMessage) {
    setError(validationMessage);
    setNotice("");
    return;
  }
  setBusy("export");
  setError("");
  setNotice("");
  try {
    if (dirty || !review.teacherReviewedAt) {
      const reviewed = await apiFetch<ReviewView>(
        `/api/reviews/${encodeURIComponent(review.id)}/teacher-review`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: review.revision, studentName, report, annotations }),
        },
      );
      applyReview(reviewed);
      setDirty(false);
    }
    await downloadReviewPdf(review.id);
    await loadReview(false);
    setNotice("PDF 已导出并开始下载。");
  } catch (caught) {
    setError(caught instanceof ApiError && caught.status === 409
      ? "内容发生冲突，请刷新后重新检查。"
      : saveErrorMessage(caught));
  } finally {
    setBusy(null);
  }
}
```

- [ ] **步骤 2：允许存在未保存修改时点击导出**

删除按钮的 `dirty` 禁用条件和提示标题：

```tsx
disabled={busy !== null || analysisActive}
```

- [ ] **步骤 3：运行目标测试，确认通过**

```bash
npm test -- 'app/(protected)/reviews/ReviewPage.test.tsx'
```

预期：PASS，详情页测试全部通过。

- [ ] **步骤 4：运行导出相关回归测试**

```bash
npm test -- 'app/(protected)/reviews/ReviewPage.test.tsx' app/lib/pdf-download.test.ts app/lib/review-queue.test.ts 'app/(protected)/reviews/batch/BatchReviewPage.test.tsx'
```

预期：PASS，详情页直接导出和批量审核资格限制同时成立。

- [ ] **步骤 5：提交功能变更**

```bash
git add 'app/(protected)/reviews/ReviewPage.tsx' 'app/(protected)/reviews/ReviewPage.test.tsx'
git commit -m 'fix(导出): 支持详情页保存后直接下载 PDF'
```

### 任务 3：完整验证

**文件：**
- 验证：`app/(protected)/reviews/ReviewPage.tsx`
- 验证：`app/(protected)/reviews/ReviewPage.test.tsx`

- [ ] **步骤 1：运行 lint**

```bash
npm run lint
```

预期：退出码为 0，无 ESLint 错误。

- [ ] **步骤 2：运行完整测试**

```bash
npm test
```

预期：退出码为 0，所有 Vitest 测试通过。

- [ ] **步骤 3：运行生产构建**

```bash
npm run build
```

预期：退出码为 0，Next.js 生产构建成功。

- [ ] **步骤 4：检查最终差异与需求**

```bash
git diff --check HEAD^
git status --short
```

预期：没有空白错误；工作区只保留用户原有的无关改动；详情页导出一次完成保存、复核和下载，批量导出规则未变。
