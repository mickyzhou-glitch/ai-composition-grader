import { render, screen, waitFor } from "@testing-library/react";
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

import Home from "./page";

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
    await user.click(screen.getByRole("button", { name: "导出全部已复核" }));
    await user.click(screen.getByRole("menuitem", { name: "Word (.docx)" }));

    await waitFor(() => expect(reviewExports.batch).toHaveBeenCalledWith(["review-reviewed"], "docx"));
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/reviews");
  });

  it("可直接按学生姓名搜索且不匹配作文题目", async () => {
    const reviews = [
      review,
      { ...review, id: "review-2", studentName: "李安然", config: { title: "张小明的礼物" } },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => json(reviews));
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
      if (url === "/api/reviews") {
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

    expect(reviewExports.legacy).toHaveBeenCalledWith(legacy);
    expect(screen.getByText("旧版示范段落报告需要完整重新分析后才能导出新格式")).toBeVisible();
  });
});
