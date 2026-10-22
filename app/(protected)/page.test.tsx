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

import { BATCH_REANALYSIS_LIMIT } from "@/src/reanalysis/contracts";

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
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/reviews");
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
      if (url === "/api/reviews") return json([...failed, hidden, review]);
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
      if (url === "/api/reviews") return json([failed]);
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
      if (url === "/api/reviews") return json([failed]);
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
});
