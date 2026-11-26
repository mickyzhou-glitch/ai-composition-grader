import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

const reviewExports = vi.hoisted(() => ({
  single: vi.fn().mockResolvedValue("为自己鼓掌-张小明.pdf"),
  batch: vi.fn().mockResolvedValue("作文批改批量导出.zip"),
  legacy: vi.fn().mockResolvedValue("旧版批改.pdf"),
}));

vi.mock("../lib/review-export", () => ({
  downloadReview: reviewExports.single,
  downloadReviewArchive: reviewExports.batch,
  downloadLegacyCachedPdf: reviewExports.legacy,
}));

import { BATCH_REANALYSIS_LIMIT } from "@/src/reanalysis/contracts";

import Home, { intersectLiveSelectedExportTargets } from "./page";

const review = {
  id: "review-1",
  status: "ready_for_review",
  studentName: "张小明",
  config: { title: "为自己鼓掌" },
  report: {
    themeFit: "fits",
    themeReason: "切题",
    personalizedComment: "真实",
    painPoints: [], commonIssues: [], revisionSuggestions: [], parentFeedbacks: [],
    scores: { themeIntent: 8, contentSelection: 8, structure: 8, languageExpression: 8, writingConventions: 4, total: 36, level: "优秀作文" },
    sampleParagraphs: [{ title: "示范段", text: "示范正文", suggestion: "修改建议" }],
  },
  createdAt: "2026-07-20T08:00:00.000Z",
  updatedAt: "2026-07-20T08:00:00.000Z",
  teacherReviewedAt: null,
  expiresAt: "2026-08-19T08:00:00.000Z",
  hasPdf: false,
  pdfFilename: null,
};

it("combines exact class filtering with student search, including legacy records", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, data: [
    { ...review, id: "class-1", studentName: "张同学", className: "六（1）班" },
    { ...review, id: "class-2", studentName: "张同学", className: "六（2）班" },
    { ...review, id: "legacy", studentName: "李同学" },
  ] }));
  const user = userEvent.setup();
  render(<Home />);
  await screen.findByText("班级：六（1）班");
  await user.selectOptions(screen.getByLabelText("班级筛选"), "class:六（1）班");
  expect(screen.queryByText("班级：六（2）班")).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("搜索学生姓名"), "李");
  expect(screen.queryByText("班级：六（1）班")).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("班级筛选"), "class:");
  expect(screen.getByText("班级：未分类")).toBeInTheDocument();
});

const exportableReview = {
  ...review,
  revision: 1,
  teacherReviewedAt: "2026-08-22T06:00:00.000Z",
  report: {
    version: 2 as const,
    themeFit: "fits" as const,
    themeReason: "切题",
    personalizedComment: "真实",
    painPoints: [], commonIssues: [], revisionSuggestions: [],
    grade: "A-" as const,
    diagnostics: {
      authenticityAndRelevance: { finding: "真实", action: "保留" },
      materialAndDetails: { finding: "具体", action: "保留" },
      structure: { finding: "完整", action: "保留" },
      language: { finding: "通顺", action: "保留" },
    },
    paragraphReviews: [{
      paragraphId: "paragraph-1",
      suggestions: [{ problem: "保留", advice: "保留动作", example: "我攥紧稿纸。" }],
      revisedText: "我攥紧稿纸。",
    }],
    parentFeedbacks: [],
  },
  images: [{ id: 1, position: 0, width: 1200, height: 1600 }],
  ocr: {
    version: 2 as const,
    ocrRevision: 1,
    editedAt: null,
    pages: [{ pageIndex: 0, text: "我攥紧稿纸。", readable: true, warnings: [] }],
    paragraphs: [{
      id: "paragraph-1", paragraphIndex: 0, text: "我攥紧稿纸。",
      segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
    }],
  },
  reportStale: false,
};

function json(data: unknown, ok = true) {
  return Promise.resolve(
    new Response(JSON.stringify(ok ? { ok: true, data } : { ok: false, error: data }), {
      status: ok ? 200 : 500,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("历史首页", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  it("加载历史、统计状态并确认删除", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([review]))
      .mockImplementationOnce(() => json({ deleted: true }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();

    render(<Home />);

    expect(await screen.findByRole("heading", { name: "为自己鼓掌" })).toBeInTheDocument();
    expect(screen.getByText("学生：张小明")).toBeInTheDocument();
    expect(screen.getByText("待复核", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText("A- · 已完成四维诊断")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "删除《为自己鼓掌》" }));

    expect(window.confirm).toHaveBeenCalledWith("确认永久删除《为自己鼓掌》？删除后不可恢复。");
    await waitFor(() => expect(screen.queryByText("A- · 已完成四维诊断")).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenLastCalledWith("/api/reviews/review-1", { method: "DELETE" });
  });

  it("历史记录长期保留并提供批量审核入口", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => json([review]));
    render(<Home />);

    expect(await screen.findByText("长期保留，可手动永久删除")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "开始批量审核" })).toHaveAttribute("href", "/reviews/batch");
    expect(screen.queryByText(/30 天|到期|自动永久删除/u)).not.toBeInTheDocument();
  });

  it("区分待复核、已复核和已导出，并一键导出全部已复核记录", async () => {
    const reviewed = {
      ...exportableReview,
      id: "review-reviewed",
      studentName: "李安然",
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
    };
    const exported = { ...reviewed, id: "review-exported", status: "exported" };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([review, reviewed, exported]))
      .mockImplementationOnce(() => json([review, reviewed, { ...exported, status: "exported" }]));
    const user = userEvent.setup();
    render(<Home />);

    expect(await screen.findByText("已复核", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.getByText("已复核", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText("已导出", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.getByText("审核不通过", { selector: "dt" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "导出全部已复核" }));
    await user.click(screen.getByRole("menuitem", { name: "Word (.docx)" }));

    await waitFor(() => expect(reviewExports.batch).toHaveBeenCalledWith(["review-reviewed"], "docx"));
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain("/api/reviews?summary=1");
  });

  it("审核不通过出现在统计和列表中，可筛选且不能导出", async () => {
    const rejected = {
      ...exportableReview,
      id: "review-rejected",
      status: "rejected",
      studentName: "王若宁",
      teacherReviewedAt: null,
      rejectionReason: "完全离题",
      rejectionChangeRequest: "不必再改",
    };
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => json([exportableReview, rejected]));
    const user = userEvent.setup();
    render(<Home />);

    expect(await screen.findByText("审核不通过", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.getByText("审核不通过", { selector: "dt" }).parentElement).toHaveTextContent("1");
    const exportButtons = screen.getAllByRole("button", { name: "导出《为自己鼓掌》" });
    expect(exportButtons[0]).toBeEnabled();
    expect(exportButtons[1]).toBeDisabled();
    expect(screen.getByText("审核不通过的作文不能导出")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("筛选批改状态"), "rejected");
    expect(screen.getByText("学生：王若宁")).toBeInTheDocument();
    expect(screen.queryByText("学生：张小明")).not.toBeInTheDocument();
  });

  it("分析失败的作文归入「审核失败」，不算待复核", async () => {
    const failed = { ...exportableReview, id: "review-failed", status: "failed", studentName: "逯益帆", teacherReviewedAt: null };
    const pending = { ...exportableReview, id: "review-pending", status: "ready_for_review", studentName: "张小明", teacherReviewedAt: null };
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => json([pending, failed]));
    const user = userEvent.setup();
    render(<Home />);
    expect(await screen.findByText("学生：逯益帆")).toBeInTheDocument();
    expect(screen.getByText("审核失败", { selector: "dt" }).parentElement).toHaveTextContent("1");
    expect(screen.getByText("待复核", { selector: "dt" }).parentElement).toHaveTextContent("1");
    await user.selectOptions(screen.getByLabelText("筛选批改状态"), "failed");
    expect(screen.getByText("学生：逯益帆")).toBeInTheDocument();
    expect(screen.queryByText("学生：张小明")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("筛选批改状态"), "review");
    expect(screen.getByText("学生：张小明")).toBeInTheDocument();
    expect(screen.queryByText("学生：逯益帆")).not.toBeInTheDocument();
  });

  it("可直接按学生姓名搜索且不匹配作文题目", async () => {
    const reviews = [
      review,
      { ...review, id: "review-2", studentName: "李安然", config: { title: "张小明的礼物" } },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation(() => json(reviews));
    const user = userEvent.setup();
    render(<Home />);

    await screen.findByText("学生：张小明");
    await user.type(screen.getByRole("searchbox", { name: "搜索学生姓名" }), "李安然");
    expect(screen.getByText("学生：李安然")).toBeVisible();
    expect(screen.queryByText("学生：张小明")).not.toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "搜索学生姓名" }));
    await user.type(screen.getByRole("searchbox", { name: "搜索学生姓名" }), "张小明");
    expect(screen.queryByText("学生：李安然")).not.toBeInTheDocument();
  });

  it("没有记录时显示直接新建的空状态", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => json([]));
    render(<Home />);

    expect(await screen.findByText("还没有作文批改记录")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "新建作文批改" })[0]).toHaveAttribute("href", "/new");
  });

  it("单篇可从菜单直接下载 Word，不打开打印页", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([exportableReview]))
      .mockImplementationOnce(() => json([exportableReview]));
    const open = vi.spyOn(window, "open");
    const user = userEvent.setup();
    render(<Home />);

    await user.click(await screen.findByRole("button", { name: "导出《为自己鼓掌》" }));
    await user.click(screen.getByRole("menuitem", { name: "Word (.docx)" }));

    await waitFor(() => expect(reviewExports.single).toHaveBeenCalledWith("review-1", "docx"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();
  });

  it("可选择多篇批改记录并下载一个 ZIP 压缩包", async () => {
    const secondReview = {
      ...exportableReview,
      id: "review-2",
      studentName: "李羿辰",
      config: { title: "珍贵的礼物" },
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([exportableReview, secondReview]))
      .mockImplementationOnce(() => json([exportableReview, secondReview]));
    const open = vi.spyOn(window, "open");
    const user = userEvent.setup();
    render(<Home />);

    await user.click(await screen.findByRole("checkbox", { name: "选择《为自己鼓掌》" }));
    await user.click(screen.getByRole("checkbox", { name: "选择《珍贵的礼物》" }));
    await user.click(screen.getByRole("button", { name: "导出所选记录" }));
    await user.click(screen.getByRole("menuitem", { name: "PDF" }));

    await waitFor(() => expect(reviewExports.batch).toHaveBeenCalledWith(["review-1", "review-2"], "pdf"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();
  });

  it("预览并按最新框架重新分析，成功项移除选择而跳过项保留", async () => {
    const secondReview = {
      ...review,
      id: "review-2",
      studentName: "李安然",
      config: { title: "我的周末" },
      revision: 3,
    };
    let loadCount = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/reviews?summary=1")) {
        loadCount += 1;
        return json(loadCount === 1 ? [review, secondReview] : [review, secondReview]);
      }
      if (url === "/api/reviews/batch-reanalysis/preview" && init?.method === "POST") {
        return json({
          matched: [{
            reviewId: "review-1",
            studentName: "张小明",
            title: "为自己鼓掌",
            expectedRevision: 1,
            assignmentId: "assignment-1",
            assignmentUpdatedAt: "2026-08-22T09:30:00.000Z",
          }],
          skipped: [{
            reviewId: "review-2",
            studentName: "李安然",
            title: "我的周末",
            code: "FRAMEWORK_NOT_FOUND",
            reason: "没有找到同名的已保存题目框架",
          }],
        });
      }
      if (url === "/api/reviews/batch-reanalysis" && init?.method === "POST") {
        return json({
          submitted: [{ reviewId: "review-1", jobId: "job-1", revision: 2 }],
          skipped: [{
            reviewId: "review-2",
            studentName: "李安然",
            title: "我的周末",
            code: "FRAMEWORK_NOT_FOUND",
            reason: "没有找到同名的已保存题目框架",
          }],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    render(<Home />);

    await screen.findByRole("heading", { name: "为自己鼓掌" });
    await user.click(screen.getByRole("checkbox", { name: "选择《为自己鼓掌》" }));
    await user.click(screen.getByRole("checkbox", { name: "选择《我的周末》" }));
    await user.click(screen.getByRole("button", { name: "按最新框架重新分析" }));

    expect(await screen.findByRole("heading", { name: "按最新框架重新分析" })).toBeVisible();
    expect(screen.getByText("没有找到同名的已保存题目框架")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认重新分析 1 篇" }));

    expect(await screen.findByText((_, element) => element instanceof HTMLElement && element.classList.contains("batch-reanalysis-summary"))).toHaveTextContent("已提交 1 篇重新分析任务，1 篇保留选择");
    expect(screen.getByText("已选择 1 篇")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/reviews/batch-reanalysis", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetchMock.mock.calls.find(([input]) => String(input) === "/api/reviews/batch-reanalysis")?.[1]?.body))).toEqual({
      items: [{ reviewId: "review-1", expectedRevision: 1, assignmentId: "assignment-1", expectedAssignmentUpdatedAt: "2026-08-22T09:30:00.000Z" }],
      applyCurrentFramework: false,
    });
  });

  it("一键导出已复核失败时保留记录并显示错误", async () => {
    const reviewed = {
      ...exportableReview,
      id: "review-reviewed",
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
    };
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => json([reviewed]));
    reviewExports.batch.mockRejectedValueOnce(new Error("导出失败"));
    const user = userEvent.setup();
    render(<Home />);

    await user.click(await screen.findByRole("button", { name: "导出全部已复核" }));
    await user.click(screen.getByRole("menuitem", { name: "PDF" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("导出失败");
    expect(screen.getByText("已复核", { selector: ".status-badge" })).toBeInTheDocument();
  });

  it("旧报告不进入新格式批量导出，有缓存时只显示旧版 PDF 动作", async () => {
    const legacy = { ...review, hasPdf: true, pdfFilename: "旧版批改.pdf" };
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([legacy]));
    const user = userEvent.setup();
    render(<Home />);

    await user.click(await screen.findByRole("button", { name: "下载已生成的旧版 PDF" }));

    expect(reviewExports.legacy).toHaveBeenCalledWith(expect.objectContaining({
      id: legacy.id,
      hasPdf: true,
      pdfFilename: "旧版批改.pdf",
      isLegacyReport: true,
    }));
    expect(screen.getByText("旧版示范段落报告需要完整重新分析后才能导出新格式")).toBeVisible();
  });

  it("一键重新批改当前筛选下的失败作文，并按上限分批显示进度和结果", async () => {
    const failed = Array.from({ length: BATCH_REANALYSIS_LIMIT + 1 }, (_, index) => ({
      ...review,
      id: `failed-${index}`,
      status: "failed",
      report: null,
      className: "六（1）班",
      studentName: `学生${index}`,
      revision: 4,
      config: { title: `失败作文${index}` },
    }));
    const hidden = {
      ...failed[0],
      id: "other-class",
      className: "六（2）班",
      config: { title: "其他班失败" },
    };
    const previews: string[][] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/reviews?summary=1")) return json([...failed, hidden, review]);
      if (url === "/api/reviews/batch-reanalysis/preview" && init?.method === "POST") {
        const reviewIds = (JSON.parse(String(init.body)) as { reviewIds: string[] }).reviewIds;
        previews.push(reviewIds);
        return json({
          matched: reviewIds.map((reviewId) => ({
            reviewId,
            studentName: "学生",
            title: "失败作文",
            expectedRevision: 4,
            assignmentId: "assignment-1",
            assignmentUpdatedAt: "2026-08-22T09:30:00.000Z",
          })),
          skipped: [],
        });
      }
      if (url === "/api/reviews/batch-reanalysis" && init?.method === "POST") {
        const items = (JSON.parse(String(init.body)) as { items: Array<{ reviewId: string }> }).items;
        return json({
          submitted: items.map((item) => ({ reviewId: item.reviewId, jobId: `job-${item.reviewId}`, revision: 5 })),
          skipped: [],
        });
      }
      const statusMatch = /^\/api\/reviews\/([^/]+)\/analyze\/status$/u.exec(url);
      if (statusMatch) {
        return json({
          job: {
            id: `job-${decodeURIComponent(statusMatch[1])}`,
            reviewId: statusMatch[1],
            status: "succeeded",
            progressStage: "saving_result",
            message: null,
            detail: null,
            createdAt: "2026-08-22T09:30:00.000Z",
            finishedAt: "2026-08-22T09:31:00.000Z",
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    render(<Home />);

    await screen.findByRole("button", { name: `一键重新批改失败作文（${BATCH_REANALYSIS_LIMIT + 2}）` });
    await user.selectOptions(screen.getByLabelText("班级筛选"), "class:六（1）班");
    await user.click(screen.getByRole("button", { name: `一键重新批改失败作文（${BATCH_REANALYSIS_LIMIT + 1}）` }));

    expect(await screen.findByText(`重新批改结束：已提交 ${BATCH_REANALYSIS_LIMIT + 1} 篇。`)).toBeVisible();
    expect(previews).toEqual([
      failed.slice(0, BATCH_REANALYSIS_LIMIT).map(({ id }) => id),
      [failed[BATCH_REANALYSIS_LIMIT].id],
    ]);
    expect(previews.flat()).not.toContain("other-class");
    expect(previews.flat()).not.toContain(review.id);
  });

  it("一键重新批改时保留原图缺失的跳过原因", async () => {
    const failed = {
      ...review,
      id: "failed-1",
      status: "failed",
      report: null,
      studentName: "林晓",
      config: { title: "失败作文" },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/reviews?summary=1")) return json([failed]);
      if (url === "/api/reviews/batch-reanalysis/preview" && init?.method === "POST") {
        return json({
          matched: [],
          skipped: [{
            reviewId: "failed-1",
            studentName: "林晓",
            title: "失败作文",
            code: "IMAGES_MISSING",
            reason: "原始图片不存在，无法重新识别",
          }],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    render(<Home />);

    await user.click(await screen.findByRole("button", { name: "一键重新批改失败作文（1）" }));

    expect(await screen.findByText("重新批改结束：已提交 0 篇，跳过 1 篇")).toBeVisible();
    expect(screen.getByText("林晓：原始图片不存在，无法重新识别")).toBeVisible();
  });

  it("失败作文在列表显示中文原因，一键重新批改后汇总这次的失败原因", async () => {
    const failed = {
      ...review,
      id: "failed-1",
      status: "failed",
      report: null,
      studentName: "林晓",
      config: { title: "失败作文" },
      analysisFailure: {
        summary: "模型或代理返回 502，停在「读取图片」，请稍后重新分析",
        detail: "upstream 502",
      },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/api/reviews?summary=1")) return json([failed]);
      if (url === "/api/reviews/batch-reanalysis/preview" && init?.method === "POST") {
        return json({
          matched: [{
            reviewId: "failed-1",
            studentName: "林晓",
            title: "失败作文",
            expectedRevision: 1,
            assignmentId: "assignment-1",
            assignmentUpdatedAt: "2026-08-22T09:30:00.000Z",
          }],
          skipped: [],
        });
      }
      if (url === "/api/reviews/batch-reanalysis" && init?.method === "POST") {
        return json({
          submitted: [{ reviewId: "failed-1", jobId: "job-failed-1", revision: 2 }],
          skipped: [],
        });
      }
      if (url === "/api/reviews/failed-1/analyze/status") {
        return json({
          job: {
            id: "job-failed-1",
            reviewId: "failed-1",
            status: "failed",
            progressStage: "reading_images",
            message: "第 2 张图片读取失败，请重新上传后再分析",
            detail: "image 2 unreadable",
            createdAt: "2026-08-22T09:30:00.000Z",
            finishedAt: "2026-08-22T09:31:00.000Z",
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    render(<Home />);

    expect(await screen.findByText("模型或代理返回 502，停在「读取图片」，请稍后重新分析")).toBeVisible();
    expect(screen.getByText("查看原始信息")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "一键重新批改失败作文（1）" }));

    expect(await screen.findByText("重新批改结束：已提交 1 篇。这次失败 1 篇。")).toBeVisible();
    expect(screen.getByText("林晓：第 2 张图片读取失败，请重新上传后再分析")).toBeVisible();
  });

  it("存在分析中作文时，后台轮询只按 analyzing 的 ID 增量点查并原位合并结果", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const analyzing = {
        ...review,
        id: "review-analyzing",
        status: "analyzing",
        report: null,
        studentName: "周同学",
        config: { title: "成长的一刻" },
      };
      const settled = {
        ...exportableReview,
        id: "review-settled",
        studentName: "陈同学",
        config: { title: "已完成作文" },
      };
      const requestedUrls: string[] = [];
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.startsWith("/api/reviews?summary=1")) {
          return json([analyzing, settled]);
        }
        if (url === "/api/reviews?ids=review-analyzing") {
          return json([{
            ...exportableReview,
            id: "review-analyzing",
            status: "ready_for_review",
            teacherReviewedAt: null,
            studentName: "周同学",
            config: { title: "成长的一刻" },
          }]);
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      render(<Home />);
      expect(await screen.findByText("学生：周同学")).toBeVisible();
      expect(screen.getByText("学生：陈同学")).toBeVisible();

      await vi.advanceTimersByTimeAsync(4_100);

      await waitFor(() => expect(requestedUrls).toContain("/api/reviews?ids=review-analyzing"));
      expect(requestedUrls.filter((url) => url.startsWith("/api/reviews?summary=1"))).toHaveLength(1);
      expect(screen.getByText("学生：陈同学")).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("服务端分页摘要模式下保持跨页选择、隐藏已选计数与全量待导出计数语义不变", async () => {
    const makeSummary = (id: string, title: string, studentName: string, eligible = true) => ({
      id,
      status: "ready_for_review" as const,
      studentName,
      className: "六（1）班",
      config: { title },
      revision: 1,
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T06:00:00.000Z",
      teacherReviewedAt: eligible ? "2026-08-22T06:00:00.000Z" : null,
      hasReport: true,
      isLegacyReport: false,
      grade: "A-",
      hasPdf: false,
      pdfFilename: null,
      exportEligibility: eligible
        ? ({ eligible: true } as const)
        : ({ eligible: false, reason: "尚未经过老师审核" } as const),
    });

    const page1Items = Array.from({ length: 20 }, (_, i) =>
      makeSummary(`p1-${i + 1}`, `第一页作文${i + 1}`, `甲生${i + 1}`, i === 0),
    );
    const page2Items = [
      makeSummary("p2-1", "第二页作文1", "乙生1", true),
      makeSummary("p2-2", "第二页作文2", "乙生2", false),
    ];

    const requestedUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      const parsed = new URL(url, "https://example.test");
      const page = Number(parsed.searchParams.get("page") ?? "1");
      return json({
        items: page === 1 ? page1Items : page2Items,
        page,
        pageSize: 20,
        totalFiltered: 22,
        stats: { total: 22, draft: 0, review: 20, failed: 0, reviewed: 2, exported: 0, rejected: 0 },
        classes: ["六（1）班", "六（2）班"],
        exportableReviewedIds: ["p1-1", "p2-1"],
        matchingFailed: [],
      });
    });

    const user = userEvent.setup();
    render(<Home />);

    // 首屏只加载第 1 页摘要，但顶部统计与一键导出已复核计数覆盖跨页全量（2 篇）
    expect(await screen.findByText("第 1 / 2 页（当前筛选共 22 篇）")).toBeVisible();
    expect(requestedUrls[0]).toBe("/api/reviews?summary=1&page=1&pageSize=20");
    expect(screen.getByText("一键导出已复核（2）")).toBeVisible();

    // 在第 1 页勾选可导出的 p1-1，翻到第 2 页再勾选可导出的 p2-1
    await user.click(screen.getByRole("checkbox", { name: "选择《第一页作文1》" }));
    await user.click(screen.getByRole("button", { name: "下一页" }));

    expect(await screen.findByText("第 2 / 2 页（当前筛选共 22 篇）")).toBeVisible();
    expect(screen.getByText("已选择 1 篇")).toBeVisible();
    expect(screen.getByText("其中 1 篇未显示")).toBeVisible();

    await user.click(screen.getByRole("checkbox", { name: "选择《第二页作文1》" }));
    expect(screen.getByText("已选择 2 篇")).toBeVisible();
    expect(screen.getByText("导出所选（2）")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "导出所选记录" }));
    await user.click(screen.getByRole("menuitem", { name: "PDF" }));

    await waitFor(() => expect(reviewExports.batch).toHaveBeenCalledWith(["p1-1", "p2-1"], "pdf"));
  });

  it("从甲班切到乙班且乙班慢响应或请求失败时，立即隐藏甲班列表并禁用当前筛选批量操作", async () => {
    const classAItem = {
      id: "a-1",
      status: "ready_for_review" as const,
      studentName: "甲班张昊",
      className: "六（1）班",
      config: { title: "甲班作文" },
      revision: 1,
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T06:00:00.000Z",
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
      hasReport: true,
      isLegacyReport: false,
      grade: "A",
      hasPdf: false,
      pdfFilename: null,
      exportEligibility: { eligible: true } as const,
    };
    const classAFailed = {
      ...classAItem,
      id: "a-failed",
      status: "failed" as const,
      studentName: "甲班林晓",
      teacherReviewedAt: null,
      hasReport: false,
      grade: null,
      exportEligibility: { eligible: false, reason: "批改报告尚未完成" } as const,
    };

    let resolveClassB!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const parsed = new URL(String(input), "https://example.test");
      const cls = parsed.searchParams.get("class");
      if (cls === "六（2）班") {
        return new Promise<Response>((resolve) => { resolveClassB = resolve; });
      }
      return json({
        items: [classAItem, classAFailed],
        page: 1,
        pageSize: 20,
        totalFiltered: 2,
        stats: { total: 2, draft: 0, review: 0, failed: 1, reviewed: 1, exported: 0, rejected: 0 },
        classes: ["六（1）班", "六（2）班"],
        exportableReviewedIds: ["a-1"],
        matchingFailed: [{ id: "a-failed", studentName: "甲班林晓" }],
      });
    });

    const user = userEvent.setup();
    render(<Home />);

    await user.selectOptions(await screen.findByLabelText("班级筛选"), "class:六（1）班");
    expect(await screen.findByText("学生：甲班张昊")).toBeVisible();
    expect(screen.getByRole("button", { name: "导出全部已复核" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "一键重新批改失败作文（1）" })).toBeEnabled();

    // 切到乙班（慢响应尚未返回）：甲班卡片必须立即收起，批量操作按钮全部禁用
    await user.selectOptions(screen.getByLabelText("班级筛选"), "class:六（2）班");
    expect(screen.queryByText("学生：甲班张昊")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /全选当前结果/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导出全部已复核" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "一键重新批改失败作文（0）" })).toBeDisabled();

    // 乙班请求返回 500 失败后：仍然保持禁用，绝不允许误导出甲班数据
    resolveClassB(new Response(JSON.stringify({ ok: false, error: { message: "乙班列表加载失败" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }));
    expect(await screen.findByRole("alert")).toHaveTextContent("乙班列表加载失败");
    expect(screen.queryByText("学生：甲班张昊")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /全选当前结果/u })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导出全部已复核" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "一键重新批改失败作文（0）" })).toBeDisabled();
    expect(reviewExports.batch).not.toHaveBeenCalled();
  });

  it("甲班导出进行中切到乙班，旧导出完成后的刷新请求只刷新当前乙班而绝不回盖甲班列表", async () => {
    const classAItem = {
      id: "a-1",
      status: "ready_for_review" as const,
      studentName: "甲班张昊",
      className: "六（1）班",
      config: { title: "甲班作文" },
      revision: 1,
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T06:00:00.000Z",
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
      hasReport: true,
      isLegacyReport: false,
      grade: "A",
      hasPdf: false,
      pdfFilename: null,
      exportEligibility: { eligible: true } as const,
    };
    const classBItem = {
      ...classAItem,
      id: "b-1",
      studentName: "乙班陈悦",
      className: "六（2）班",
      config: { title: "乙班作文" },
    };

    let resolveExport!: (filename: string) => void;
    reviewExports.batch.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolveExport = resolve;
    }));

    const requestedUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      requestedUrls.push(url);
      const parsed = new URL(url, "https://example.test");
      const cls = parsed.searchParams.get("class");
      const isClassB = cls === "六（2）班";
      return json({
        items: isClassB ? [classBItem] : [classAItem],
        page: 1,
        pageSize: 20,
        totalFiltered: 1,
        stats: { total: 2, draft: 0, review: 0, failed: 0, reviewed: 2, exported: 0, rejected: 0 },
        classes: ["六（1）班", "六（2）班"],
        exportableReviewedIds: isClassB ? ["b-1"] : ["a-1"],
        matchingFailed: [],
      });
    });

    const user = userEvent.setup();
    render(<Home />);

    await user.selectOptions(await screen.findByLabelText("班级筛选"), "class:六（1）班");
    expect(await screen.findByText("学生：甲班张昊")).toBeVisible();

    // 在甲班启动批量导出，但导出尚未结束时用户切到乙班且乙班列表已到达
    await user.click(screen.getByRole("button", { name: "导出全部已复核" }));
    await user.click(screen.getByRole("menuitem", { name: "PDF" }));
    await waitFor(() => expect(reviewExports.batch).toHaveBeenCalledWith(["a-1"], "pdf"));

    await user.selectOptions(screen.getByLabelText("班级筛选"), "class:六（2）班");
    expect(await screen.findByText("学生：乙班陈悦")).toBeVisible();

    // 甲班导出晚一步完成：触发的刷新必须针对当前乙班查询，不能把界面盖回甲班
    resolveExport("甲班导出.zip");
    await waitFor(() => expect(screen.getByRole("button", { name: "导出全部已复核" })).toBeEnabled());
    const lastRequestedClass = new URL(requestedUrls.at(-1)!, "https://example.test").searchParams.get("class");
    expect(lastRequestedClass).toBe("六（2）班");
    expect(screen.getByText("学生：乙班陈悦")).toBeVisible();
    expect(screen.queryByText("学生：甲班张昊")).not.toBeInTheDocument();
  });

  it("乙班已成功显示后若甲班先前的导出请求报错，仅展示操作错误提示而保持乙班列表与按钮可用", async () => {
    const classAItem = {
      id: "a-1",
      status: "ready_for_review" as const,
      studentName: "甲班张昊",
      className: "六（1）班",
      config: { title: "甲班作文" },
      revision: 1,
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T06:00:00.000Z",
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
      hasReport: true,
      isLegacyReport: false,
      grade: "A",
      hasPdf: false,
      pdfFilename: null,
      exportEligibility: { eligible: true } as const,
    };
    const classBItem = {
      ...classAItem,
      id: "b-1",
      studentName: "乙班陈悦",
      className: "六（2）班",
      config: { title: "乙班作文" },
    };

    let rejectExport!: (reason?: unknown) => void;
    reviewExports.batch.mockImplementationOnce(() => new Promise<string>((_, reject) => {
      rejectExport = reject;
    }));

    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const parsed = new URL(String(input), "https://example.test");
      const isClassB = parsed.searchParams.get("class") === "六（2）班";
      return json({
        items: isClassB ? [classBItem] : [classAItem],
        page: 1,
        pageSize: 20,
        totalFiltered: 1,
        stats: { total: 2, draft: 0, review: 0, failed: 0, reviewed: 2, exported: 0, rejected: 0 },
        classes: ["六（1）班", "六（2）班"],
        exportableReviewedIds: isClassB ? ["b-1"] : ["a-1"],
        matchingFailed: [],
      });
    });

    const user = userEvent.setup();
    render(<Home />);

    await user.selectOptions(await screen.findByLabelText("班级筛选"), "class:六（1）班");
    expect(await screen.findByText("学生：甲班张昊")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "导出全部已复核" }));
    await user.click(screen.getByRole("menuitem", { name: "PDF" }));
    await waitFor(() => expect(reviewExports.batch).toHaveBeenCalledWith(["a-1"], "pdf"));

    await user.selectOptions(screen.getByLabelText("班级筛选"), "class:六（2）班");
    expect(await screen.findByText("学生：乙班陈悦")).toBeVisible();

    // 甲班导出此时失败：展示错误横幅，但乙班列表绝不消失、批量操作保持可用
    rejectExport(new Error("甲班压缩包生成失败"));
    expect(await screen.findByRole("alert")).toHaveTextContent("甲班压缩包生成失败");
    expect(screen.getByText("学生：乙班陈悦")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /全选当前结果/u })).toBeEnabled();
    expect(screen.getByRole("button", { name: "导出全部已复核" })).toBeEnabled();
  });

  it("服务端分页下 analyzing 轮询迁移为 failed 时自动重取当前查询，移出待复核并同步失败重批计数", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let transitioned = false;
      const analyzingSummary = {
        id: "an-1",
        status: "analyzing" as const,
        studentName: "周虚构",
        className: "六（1）班",
        config: { title: "成长的一刻" },
        revision: 1,
        createdAt: "2026-08-22T01:00:00.000Z",
        updatedAt: "2026-08-22T06:00:00.000Z",
        teacherReviewedAt: null,
        hasReport: false,
        isLegacyReport: false,
        grade: null,
        hasPdf: false,
        pdfFilename: null,
        exportEligibility: { eligible: false, reason: "批改报告尚未完成" } as const,
      };
      const failedSummary = {
        ...analyzingSummary,
        status: "failed" as const,
      };

      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url === "/api/reviews?ids=an-1") {
          transitioned = true;
          return json([{
            ...review,
            id: "an-1",
            status: "failed",
            report: null,
            studentName: "周虚构",
            config: { title: "成长的一刻" },
          }]);
        }
        const parsed = new URL(url, "https://example.test");
        const statusParam = parsed.searchParams.get("status") ?? "";
        const items = !transitioned
          ? (statusParam === "" || statusParam === "review" ? [analyzingSummary] : [])
          : (statusParam === "" || statusParam === "failed" ? [failedSummary] : []);
        return json({
          items,
          page: 1,
          pageSize: 20,
          totalFiltered: items.length,
          stats: {
            total: 1,
            draft: 0,
            review: transitioned ? 0 : 1,
            failed: transitioned ? 1 : 0,
            reviewed: 0,
            exported: 0,
            rejected: 0,
          },
          classes: ["六（1）班"],
          exportableReviewedIds: [],
          matchingFailed: transitioned && (statusParam === "" || statusParam === "failed")
            ? [{ id: "an-1", studentName: "周虚构" }]
            : [],
        });
      });

      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<Home />);

      await user.selectOptions(await screen.findByLabelText("筛选批改状态"), "review");
      expect(await screen.findByText("学生：周虚构")).toBeVisible();

      await vi.advanceTimersByTimeAsync(4_100);

      // 状态变为 failed 后自动重取当前 status=review 查询，失败卡片不再滞留在「待复核」下
      await waitFor(() => expect(screen.queryByText("学生：周虚构")).not.toBeInTheDocument());
      expect(screen.getByText("审核失败", { selector: "dt" }).parentElement).toHaveTextContent("1");

      // 切到「审核失败」筛选时，一键重批清单已同步为 1 篇
      await user.selectOptions(screen.getByLabelText("筛选批改状态"), "failed");
      expect(await screen.findByText("学生：周虚构")).toBeVisible();
      expect(screen.getByRole("button", { name: "一键重新批改失败作文（1）" })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("服务端分页 21 篇时在第 2 页删除唯一一篇，自动采纳校正页码回退第 1 页并保留跨页已勾选记录", async () => {
    const makeItem = (id: string, title: string, studentName: string) => ({
      id,
      status: "ready_for_review" as const,
      studentName,
      className: "六（1）班",
      config: { title },
      revision: 1,
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T06:00:00.000Z",
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
      hasReport: true,
      isLegacyReport: false,
      grade: "A-",
      hasPdf: false,
      pdfFilename: null,
      exportEligibility: { eligible: true } as const,
    });

    const page1Items = Array.from({ length: 20 }, (_, idx) =>
      makeItem(`p1-${idx + 1}`, `甲页作文${idx + 1}`, `甲生${idx + 1}`),
    );
    const solePage2Item = makeItem("p2-1", "乙页唯一作文", "乙生1");
    let deleted = false;

    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/reviews/p2-1" && init?.method === "DELETE") {
        deleted = true;
        return json({ deleted: true });
      }
      const parsed = new URL(url, "https://example.test");
      const requestedPage = Number(parsed.searchParams.get("page") ?? "1");
      const allItems = deleted ? page1Items : [...page1Items, solePage2Item];
      const safePage = Math.min(requestedPage, Math.max(1, Math.ceil(allItems.length / 20)));
      const start = (safePage - 1) * 20;
      return json({
        items: allItems.slice(start, start + 20),
        page: safePage,
        pageSize: 20,
        totalFiltered: allItems.length,
        stats: { total: allItems.length, draft: 0, review: 0, failed: 0, reviewed: allItems.length, exported: 0, rejected: 0 },
        classes: ["六（1）班"],
        exportableReviewedIds: allItems.map(({ id }) => id),
        matchingFailed: [],
      });
    });

    const user = userEvent.setup();
    render(<Home />);

    expect(await screen.findByText("第 1 / 2 页（当前筛选共 21 篇）")).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: "选择《甲页作文1》" }));
    await user.click(screen.getByRole("button", { name: "下一页" }));

    expect(await screen.findByText("学生：乙生1")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "删除《乙页唯一作文》" }));

    // 删除后总数变为 20 篇：自动回到第 1 页显示 20 篇卡片，且第 1 页先前勾选的 p1-1 完好保留
    expect(await screen.findByText("学生：甲生1")).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "批改历史分页" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "选择《甲页作文1》" })).toBeChecked();
    expect(screen.getByText("已选择 1 篇")).toBeVisible();
  });

  it("历史记录尚未完成权威摘要回填（summaryBackfillPending > 0）时禁用导出全部已复核，防止少导", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => json({
      items: [{
        id: "r-1",
        status: "ready_for_review",
        studentName: "甲生",
        className: "六（1）班",
        config: { title: "成长故事" },
        revision: 1,
        createdAt: "2026-08-22T01:00:00.000Z",
        updatedAt: "2026-08-22T06:00:00.000Z",
        teacherReviewedAt: "2026-08-22T06:00:00.000Z",
        hasReport: true,
        isLegacyReport: false,
        grade: "A-",
        hasPdf: false,
        pdfFilename: null,
        exportEligibility: { eligible: true },
      }],
      page: 1,
      pageSize: 20,
      totalFiltered: 25,
      stats: { total: 25, draft: 0, review: 0, failed: 0, reviewed: 25, exported: 0, rejected: 0 },
      classes: ["六（1）班"],
      exportableReviewedIds: ["r-1"],
      matchingFailed: [],
      summaryBackfillPending: 5,
    }));

    render(<Home />);
    expect(await screen.findByText("学生：甲生")).toBeVisible();
    expect(screen.getByText("一键导出已复核（0）")).toBeVisible();
    const exportAllBtn = screen.getByRole("button", { name: "导出全部已复核" });
    expect(exportAllBtn).toBeDisabled();
    expect(screen.getByText("尚有 5 篇历史记录正在同步导出资格，请刷新完成后再一键导出")).toBeVisible();
  });

  it("分页模式下第 1 页选中最初未就绪的 A 后翻到第 2 页（最新响应明确 A、B 均可导出），再选 B 导出所选时完整下载 A 与 B；一键导出若重取异常返回 [] 数组则报错停止绝不下载旧集合", async () => {
    const makeSummary = (id: string, title: string, studentName: string, eligible: boolean) => ({
      id,
      status: "ready_for_review" as const,
      studentName,
      className: "六（1）班",
      config: { title },
      revision: 1,
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T06:00:00.000Z",
      teacherReviewedAt: eligible ? "2026-08-22T06:00:00.000Z" : null,
      hasReport: true,
      isLegacyReport: false,
      grade: "A-",
      hasPdf: false,
      pdfFilename: null,
      exportEligibility: eligible
        ? ({ eligible: true } as const)
        : ({ eligible: false, reason: "尚未经过老师审核" } as const),
    });

    // 第 1 页初次加载时 review-a 尚未审核（eligible: false）；翻到第 2 页时另一标签页已审完 review-a，故第 2 页最新响应返回 exportableReviewedIds: ["review-a", "review-b"]
    const page1InitialItems = [
      makeSummary("review-a", "第一页刚审完作文A", "甲生A", false),
      ...Array.from({ length: 19 }, (_, idx) =>
        makeSummary(`p1-fill-${idx + 2}`, `第一页其余作文${idx + 2}`, `甲生${idx + 2}`, false),
      ),
    ];
    const page2Items = [
      makeSummary("review-b", "第二页可导出作文B", "乙生B", true),
    ];

    let returnLegacyEmptyArrayOnNextFetch = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (returnLegacyEmptyArrayOnNextFetch) {
        return json([]);
      }
      const parsed = new URL(url, "https://example.test");
      const page = Number(parsed.searchParams.get("page") ?? "1");
      if (page === 1) {
        return json({
          items: page1InitialItems,
          page: 1,
          pageSize: 20,
          totalFiltered: 21,
          stats: { total: 21, draft: 0, review: 20, failed: 0, reviewed: 1, exported: 0, rejected: 0 },
          classes: ["六（1）班"],
          exportableReviewedIds: ["review-b"],
          matchingFailed: [],
        });
      }
      return json({
        items: page2Items,
        page: 2,
        pageSize: 20,
        totalFiltered: 21,
        stats: { total: 21, draft: 0, review: 19, failed: 0, reviewed: 2, exported: 0, rejected: 0 },
        classes: ["六（1）班"],
        exportableReviewedIds: ["review-a", "review-b"],
        matchingFailed: [],
      });
    });

    const user = userEvent.setup();
    render(<Home />);

    expect(await screen.findByText("第 1 / 2 页（当前筛选共 21 篇）")).toBeVisible();
    // 1) 在第 1 页先勾选当时仍不可导出的 review-a，随后翻到第 2 页
    await user.click(screen.getByRole("checkbox", { name: "选择《第一页刚审完作文A》" }));
    expect(screen.getByText("导出所选（0）")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("第 2 / 2 页（当前筛选共 21 篇）")).toBeVisible();
    // 第 2 页响应已告知 review-a 在 exportableReviewedIds 中，跨页缓存资格立即更新为 1 篇可导出
    expect(screen.getByText("导出所选（1）")).toBeVisible();

    // 2) 再勾选第 2 页的 review-b，导出所选计数变为 2，点击导出必须完整传入 ["review-a", "review-b"] 而非漏掉 review-a
    await user.click(screen.getByRole("checkbox", { name: "选择《第二页可导出作文B》" }));
    expect(screen.getByText("导出所选（2）")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "导出所选记录" }));
    await user.click(screen.getByRole("menuitem", { name: "PDF" }));

    await waitFor(() => expect(reviewExports.batch).toHaveBeenCalledWith(["review-a", "review-b"], "pdf"));

    // 3) 已处于分页模式时，若点击「导出全部已复核」重取意外返回旧式空数组 []，必须报错中止且下载调用次数保持 0 新增
    reviewExports.batch.mockClear();
    returnLegacyEmptyArrayOnNextFetch = true;
    await user.click(screen.getByRole("button", { name: "导出全部已复核" }));
    await user.click(screen.getByRole("menuitem", { name: "PDF" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("历史分页摘要响应格式异常");
    expect(reviewExports.batch).not.toHaveBeenCalled();
  });

  it("分页首页启动导出所选后全选与单行勾选统一禁用（拒绝核验期误撤选），且归档前与最新勾选集取交集（撤空则归档调用严格为 0 次）", async () => {
    // 1) 纯交集门禁断言：凡已撤选 ID 绝不进入归档；全部撤空时归档候选为空（0 次下载）
    expect(intersectLiveSelectedExportTargets(["synthetic-A", "synthetic-B"], new Set(["synthetic-B"]))).toEqual(["synthetic-B"]);
    expect(intersectLiveSelectedExportTargets(["synthetic-A"], new Set())).toEqual([]);

    // 2) 组件交互断言：选中唯一一篇 synthetic-A 后点击「导出所选记录」并暂停导出前核验，全选框与单行框均已统一禁用，点击全选框不会撤选
    const syntheticA = {
      id: "synthetic-A",
      status: "ready_for_review" as const,
      studentName: "合成甲生",
      className: "六（1）班",
      config: { title: "合成作文A" },
      revision: 1,
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T06:00:00.000Z",
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
      hasReport: true,
      isLegacyReport: false,
      grade: "A-",
      hasPdf: false,
      pdfFilename: null,
      exportEligibility: { eligible: true } as const,
    };

    let fetchCount = 0;
    let resolvePreExportCheck!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      void input;
      fetchCount += 1;
      const pagePayload = {
        items: [syntheticA],
        page: 1,
        pageSize: 20,
        totalFiltered: 1,
        stats: { total: 1, draft: 0, review: 0, failed: 0, reviewed: 1, exported: 0, rejected: 0 },
        classes: ["六（1）班"],
        exportableReviewedIds: ["synthetic-A"],
        matchingFailed: [],
      };
      if (fetchCount === 2) {
        return new Promise<Response>((resolve) => {
          resolvePreExportCheck = resolve;
        });
      }
      return json(pagePayload);
    });

    const user = userEvent.setup();
    render(<Home />);

    const rowCheckbox = await screen.findByRole("checkbox", { name: "选择《合成作文A》" });
    await user.click(rowCheckbox);
    expect(screen.getByText("已选择 1 篇")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "导出所选记录" }));
    await user.click(screen.getByRole("menuitem", { name: "PDF" }));
    await waitFor(() => expect(fetchCount).toBe(2));

    const selectAllCheckbox = screen.getByRole("checkbox", { name: /全选当前结果/u });
    expect(selectAllCheckbox).toBeDisabled();
    expect(rowCheckbox).toBeDisabled();

    // 核验期间尝试点击全选框：由于已禁用，界面保持「已选择 1 篇」而非变为 0 篇
    await user.click(selectAllCheckbox);
    expect(screen.getByText("已选择 1 篇")).toBeVisible();

    await act(async () => {
      resolvePreExportCheck(new Response(JSON.stringify({
        ok: true,
        data: {
          items: [syntheticA],
          page: 1,
          pageSize: 20,
          totalFiltered: 1,
          stats: { total: 1, draft: 0, review: 0, failed: 0, reviewed: 1, exported: 0, rejected: 0 },
          classes: ["六（1）班"],
          exportableReviewedIds: ["synthetic-A"],
          matchingFailed: [],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    });
    await waitFor(() => expect(reviewExports.batch).toHaveBeenCalledWith(["synthetic-A"], "pdf"));
  });

  it("支持按作文题目筛选、录入班级整体名单并直接生成与一键复制未交名单", async () => {
    const itemApplause1 = {
      id: "rev-1",
      status: "ready_for_review" as const,
      studentName: "张小明",
      className: "六（1）班",
      config: { title: "为自己鼓掌" },
      revision: 1,
      createdAt: "2026-11-26T01:00:00.000Z",
      updatedAt: "2026-11-26T02:00:00.000Z",
      teacherReviewedAt: "2026-11-26T02:00:00.000Z",
      hasReport: true,
      isLegacyReport: false,
      grade: "A",
      hasPdf: false,
      pdfFilename: null,
      exportEligibility: { eligible: true } as const,
    };
    const itemSpring1 = {
      ...itemApplause1,
      id: "rev-2",
      studentName: "李安然",
      config: { title: "春游记" },
    };

    let savedRosters: Array<{ className: string; students: string[]; updatedAt: string }> = [];
    const requestedUrls: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(`${init?.method ?? "GET"} ${url}`);

      if (url === "/api/class-rosters" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { className: string; students: string[] };
        savedRosters = [{
          className: body.className,
          students: body.students,
          updatedAt: "2026-11-26T03:00:00.000Z",
        }];
        return json(savedRosters);
      }

      const parsed = new URL(url, "https://example.test");
      const classParam = parsed.searchParams.has("class") ? parsed.searchParams.get("class") : null;
      const titleParam = parsed.searchParams.has("title") ? parsed.searchParams.get("title") : null;
      const allItems = [itemApplause1, itemSpring1];
      const filtered = allItems.filter((item) =>
        (classParam === null || item.className === classParam)
        && (titleParam === null || item.config.title === titleParam),
      );

      return json({
        items: filtered,
        page: 1,
        pageSize: 20,
        totalFiltered: filtered.length,
        stats: { total: 2, draft: 0, review: 0, failed: 0, reviewed: 2, exported: 0, rejected: 0 },
        classes: ["六（1）班"],
        titles: ["为自己鼓掌", "春游记"],
        rosters: savedRosters,
        ...(titleParam ? {
          titleSubmissions: filtered.map((item) => ({
            id: item.id,
            className: item.className,
            studentName: item.studentName,
            status: item.status,
            teacherReviewedAt: item.teacherReviewedAt,
          })),
        } : {}),
        exportableReviewedIds: filtered.map((item) => item.id),
        matchingFailed: [],
      });
    });

    const user = userEvent.setup();
    render(<Home />);

    expect(await screen.findByRole("heading", { name: "为自己鼓掌" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "春游记" })).toBeInTheDocument();

    // 1) 按作文题目筛选为《为自己鼓掌》，《春游记》被过滤掉，请求携带 title=为自己鼓掌
    await user.selectOptions(screen.getByLabelText("作文题目"), "title:为自己鼓掌");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "春游记" })).not.toBeInTheDocument());
    expect(requestedUrls.some((entry) => entry.includes("title=%E4%B8%BA%E8%87%AA%E5%B7%B1%E9%BC%93%E6%8E%8C"))).toBe(true);

    // 2) 选择班级「六（1）班」后提示录入名单，点击录入全班 3 人名单并保存
    await user.selectOptions(screen.getByLabelText("班级筛选"), "class:六（1）班");
    await user.click(await screen.findByRole("button", { name: "录入六（1）班名单" }));

    const rosterTextarea = screen.getByLabelText("本班整体学生名单");
    await user.type(rosterTextarea, "1. 张　小明\n2. 王语桐\n3. 陈子墨");
    await user.click(screen.getByRole("button", { name: "保存本班名单" }));

    // 3) 保存后自动展示交齐统计（应交 3 人 · 已交 1 人 · 未交 2 人）并支持一键复制未交名单
    expect(await screen.findByText("应交 3 人")).toBeInTheDocument();
    expect(screen.getByText("已交 1 人")).toBeInTheDocument();
    expect(screen.getByText("未交 2 人")).toBeInTheDocument();
    expect(screen.getByText("王语桐")).toBeInTheDocument();
    expect(screen.getByText("陈子墨")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "一键复制未交名单" }));
    expect(await screen.findByRole("button", { name: "已复制未交名单 ✓" })).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe("六（1）班《为自己鼓掌》未交名单（2人）：王语桐、陈子墨");
  });
});
