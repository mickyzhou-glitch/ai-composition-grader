import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const reviewExports = vi.hoisted(() => ({
  batch: vi.fn().mockResolvedValue("作文批改批量导出.zip"),
}));

vi.mock("../../../lib/review-export", () => ({
  downloadReviewArchive: reviewExports.batch,
}));

vi.mock("../../../components/ParagraphCropPreview", () => ({
  ParagraphCropPreview: ({ paragraphNumber }: { paragraphNumber: number }) => (
    <div data-testid={`page-crop-${paragraphNumber}`}>第 {paragraphNumber} 段原文裁图</div>
  ),
}));

import { BatchReviewPage } from "./BatchReviewPage";

const report = {
  themeFit: "fits",
  themeReason: "切题",
  personalizedComment: "选材贴近真实生活\n关键动作描写具体",
  painPoints: ["第三段补充转折原因", "结尾回扣前文行动"],
  commonIssues: [],
  revisionSuggestions: [],
  grade: "B+",
  diagnostics: {
    authenticityAndRelevance: { finding: "事件基本可信。", action: "核对时间顺序。" },
    materialAndDetails: { finding: "动作略少。", action: "补写一个动作。" },
    structure: { finding: "转折略快。", action: "补充前后因果。" },
    language: { finding: "语言通顺。", action: "精简长句。" },
  },
  sampleParagraphs: Array.from({ length: 5 }, (_, index) => ({
    title: `第 ${index + 1} 段`,
    text: "我".repeat(120),
    suggestion: "补充动作",
  })),
  parentFeedbacks: [],
};

const paragraphReport = {
  version: 2 as const,
  themeFit: "fits" as const,
  themeReason: "切题",
  personalizedComment: "选材贴近真实生活",
  painPoints: [],
  commonIssues: [],
  revisionSuggestions: [],
  grade: "A-" as const,
  diagnostics: report.diagnostics,
  paragraphReviews: [{
    paragraphId: "paragraph-1",
    suggestions: [{ problem: "描写普通", advice: "补充听觉", example: "我听见了呼吸声。" }],
    revisedText: "我走上台。",
  }],
  parentFeedbacks: [],
};

function detail(
  id: string,
  studentName: string,
  revision: number,
  currentReport: typeof report | typeof paragraphReport = report,
) {
  const ocr = "paragraphReviews" in currentReport ? {
    version: 2 as const,
    ocrRevision: 1,
    editedAt: null,
    pages: [{ pageIndex: 0, text: `${studentName}的作文原文`, readable: true, warnings: [] }],
    paragraphs: [{
      id: "paragraph-1",
      paragraphIndex: 0,
      text: "我走上台。",
      segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
    }],
  } : {
    version: 1 as const,
    ocrRevision: 1,
    editedAt: null,
    pages: [{ pageIndex: 0, text: `${studentName}的作文原文`, readable: true, warnings: [] }],
  };
  return {
    id, studentName, revision, status: "ready_for_review", teacherReviewedAt: null,
    config: { title: `作文${id.at(-1)}`, grade: "六年级", writingRequirements: "叙事", targetCharacters: 600, structureRequirements: "完整", scoringFocus: "细节", templateType: "custom" },
    report: currentReport, createdAt: "2026-08-22T01:00:00.000Z", updatedAt: "2026-08-22T01:00:00.000Z",
    images: [{ id: revision, position: 0, originalName: "作文.jpg", mimeType: "image/jpeg", width: 1200, height: 1600, rotation: 0, crop: null }],
    annotations: [], ocr, reportStale: false, hasPdf: false, pdfFilename: null,
  };
}

function queueItem(id: string, studentName: string, revision: number) {
  return {
    id,
    studentName,
    title: `作文${id.at(-1)}`,
    status: "ready_for_review",
    revision,
    createdAt: "2026-08-22T01:00:00.000Z",
  };
}

function mockReviewApi(
  queue: (ReturnType<typeof queueItem> & { className?: string })[],
  options: {
    rejectTeacherReview?: boolean;
    currentReport?: typeof report | typeof paragraphReport;
  } = {},
) {
  const details = new Map(queue.map((item) => [
    item.id,
    detail(item.id, item.studentName, item.revision, options.currentReport),
  ]));
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: queue });
    if (url === "/api/reviews") return Response.json({ ok: true, data: [...details.values()] });
    const teacherMatch = /^\/api\/reviews\/(review-\d)\/teacher-review$/u.exec(url);
    if (teacherMatch && init?.method === "POST") {
      if (options.rejectTeacherReview) {
        return Response.json({ ok: false, error: { message: "保存失败，请重试" } }, { status: 500 });
      }
      const current = details.get(teacherMatch[1])!;
      return Response.json({
        ok: true,
        data: {
          ...current,
          revision: current.revision + 1,
          teacherReviewedAt: "2026-08-22T06:00:00.000Z",
        },
      });
    }
    const detailMatch = /^\/api\/reviews\/(review-\d)$/u.exec(url);
    if (detailMatch) return Response.json({ ok: true, data: details.get(detailMatch[1]) });
    throw new Error(`Unexpected request: ${url}`);
  });
}

describe("BatchReviewPage", () => {
  it("preserves unsaved edits when class filtering keeps the current review visible", async () => {
    mockReviewApi([
      { ...queueItem("review-1", "张小明", 1), className: "六（1）班" },
      { ...queueItem("review-2", "李安然", 2), className: "六（2）班" },
    ], { currentReport: paragraphReport });
    const user = userEvent.setup();
    render(<BatchReviewPage />);
    const revised = await screen.findByRole("textbox", { name: "第 1 段改后全段" });
    expect(screen.queryByRole("textbox", { name: "第 1 段第 1 条修改动作" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "第 1 段第 1 条问题描述" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除第 1 段第 1 条建议" })).not.toBeInTheDocument();
    await user.clear(revised);
    await user.type(revised, "需要补充声音描写");
    await user.selectOptions(screen.getByLabelText("班级筛选"), "class:六（1）班");
    expect(screen.getByRole("textbox", { name: "第 1 段改后全段" })).toHaveValue("需要补充声音描写");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.selectOptions(screen.getByLabelText("班级筛选"), "class:六（2）班");
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByLabelText("班级筛选")).toHaveValue("class:六（1）班");
  });
  it("filters the review queue by class and keeps the selection after name search", async () => {
    mockReviewApi([
      { ...queueItem("review-1", "张小明", 1), className: "六（1）班" },
      { ...queueItem("review-2", "李安然", 2), className: "六（2）班" },
    ]);
    const user = userEvent.setup();
    render(<BatchReviewPage />);
    await screen.findByRole("heading", { name: "张小明" });
    await user.selectOptions(screen.getByLabelText("班级筛选"), "class:六（2）班");
    expect(await screen.findByRole("heading", { name: "李安然" })).toBeVisible();
    expect(screen.queryByRole("button", { name: /张小明/ })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("搜索待审核学生姓名"), "张");
    expect(screen.getByLabelText("班级筛选")).toHaveValue("class:六（2）班");
    expect(screen.queryByRole("button", { name: /张小明|李安然/ })).not.toBeInTheDocument();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("逐段报告可编辑并完成批量审核，不受示范段数门禁影响", async () => {
    const fetchMock = mockReviewApi([queueItem("review-1", "张小明", 1)], {
      currentReport: paragraphReport,
    });
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    expect(await screen.findByRole("heading", { name: "修改动作与改后全段" })).toBeVisible();
    expect(screen.queryByTestId("page-crop-1")).not.toBeInTheDocument();
    expect(screen.queryByText("【修改动作】")).not.toBeInTheDocument();
    expect(screen.queryByText("【修改建议】")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /删除第 \d+ 段第 \d+ 条建议/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /新增第 \d+ 段建议/u })).not.toBeInTheDocument();
    const revised = screen.getByLabelText("第 1 段改后全段");
    await user.clear(revised);
    await user.type(revised, "我听见急促的呼吸声，终于走上台。");
    await user.click(screen.getByRole("button", { name: "审核通过并进入下一篇" }));

    const teacherCall = fetchMock.mock.calls.find(([input]) => (
      String(input) === "/api/reviews/review-1/teacher-review"
    ));
    expect(teacherCall).toBeDefined();
    expect(JSON.parse(String(teacherCall?.[1]?.body))).toMatchObject({
      report: {
        version: 2,
        paragraphReviews: [{
          suggestions: paragraphReport.paragraphReviews[0].suggestions,
          revisedText: "我听见急促的呼吸声，终于走上台。",
        }],
      },
    });
  });

  it("同段多条建议时批量审核仍是一段一个框", async () => {
    const multiAdvice = {
      ...paragraphReport,
      paragraphReviews: [{
        ...paragraphReport.paragraphReviews[0],
        suggestions: [
          { advice: "补听觉" },
          { advice: "补动作" },
          { advice: "收束主题" },
        ],
      }],
    };
    mockReviewApi([queueItem("review-1", "张小明", 1)], { currentReport: multiAdvice });
    render(<BatchReviewPage />);

    expect(await screen.findByRole("heading", { name: "第 1 段" })).toBeVisible();
    expect(screen.getAllByRole("textbox", { name: /第 \d+ 段改后全段/u })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "第 2 段" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /第 \d+ 段第 \d+ 条修改动作/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /新增第 \d+ 段建议/u })).not.toBeInTheDocument();
  });

  it("老师指定结构段时按组展示改后全段，并标出对应原文范围", async () => {
    const essay = ["我走上台。天很蓝。", "我终于明白了。"];
    const groupedReport = {
      ...paragraphReport,
      rewrittenEssay: essay,
      paragraphReviews: [
        {
          paragraphId: "paragraph-1",
          sourceParagraphStart: 1,
          sourceParagraphEnd: 2,
          suggestions: [{ advice: "合并前两段。" }],
          revisedText: essay[0],
        },
        {
          paragraphId: "paragraph-3",
          sourceParagraphStart: 3,
          sourceParagraphEnd: 3,
          suggestions: [{ advice: "收束主题。" }],
          revisedText: essay[1],
        },
      ],
    };
    const groupedDetail = {
      ...detail("review-1", "张小明", 1, groupedReport),
      ocr: {
        version: 2 as const,
        ocrRevision: 1,
        editedAt: null,
        pages: [{ pageIndex: 0, text: "张小明的作文原文", readable: true, warnings: [] }],
        paragraphs: [
          {
            id: "paragraph-1",
            paragraphIndex: 0,
            text: "我走上台。",
            segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
          },
          {
            id: "paragraph-2",
            paragraphIndex: 1,
            text: "天很蓝。",
            segments: [{ pageIndex: 0, x: 0.1, y: 0.4, width: 0.5, height: 0.1 }],
          },
          {
            id: "paragraph-3",
            paragraphIndex: 2,
            text: "我终于明白了。",
            segments: [{ pageIndex: 0, x: 0.1, y: 0.6, width: 0.5, height: 0.1 }],
          },
        ],
      },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") {
        return Response.json({ ok: true, data: [queueItem("review-1", "张小明", 1)] });
      }
      if (url === "/api/reviews") return Response.json({ ok: true, data: [groupedDetail] });
      if (url === "/api/reviews/review-1/teacher-review" && init?.method === "POST") {
        return Response.json({
          ok: true,
          data: { ...groupedDetail, revision: 2, teacherReviewedAt: "2026-08-22T06:00:00.000Z" },
        });
      }
      if (url === "/api/reviews/review-1") return Response.json({ ok: true, data: groupedDetail });
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    expect(await screen.findByText("对应原文第 1–2 段")).toBeVisible();
    expect(screen.getByText("对应原文第 3 段")).toBeVisible();
    expect(screen.getAllByRole("textbox", { name: /第 \d+ 段改后全段/u })).toHaveLength(2);
    expect(screen.queryByLabelText("第 3 段改后全段")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /修改动作/u })).not.toBeInTheDocument();
    const revised = screen.getByLabelText("第 1 段改后全段");
    await user.clear(revised);
    await user.type(revised, "我听见呼吸声，走上了台。天很蓝。");
    await user.click(screen.getByRole("button", { name: "审核通过并进入下一篇" }));

    const teacherCall = fetchMock.mock.calls.find(([input]) => (
      String(input) === "/api/reviews/review-1/teacher-review"
    ));
    expect(screen.queryByRole("textbox", { name: /第 \d+ 段第 \d+ 条修改动作/u })).not.toBeInTheDocument();
    expect(JSON.parse(String(teacherCall?.[1]?.body)).report).toMatchObject({
      rewrittenEssay: essay,
      paragraphReviews: [
        {
          paragraphId: "paragraph-1",
          sourceParagraphStart: 1,
          sourceParagraphEnd: 2,
          revisedText: "我听见呼吸声，走上了台。天很蓝。",
        },
        {
          paragraphId: "paragraph-3",
          sourceParagraphStart: 3,
          sourceParagraphEnd: 3,
          revisedText: essay[1],
        },
      ],
    });
  });

  it("returns an unsuitable review with the revision guard and immediately opens a prefetched successor", async () => {
    const queue = [
      queueItem("review-1", "张小明", 7),
      queueItem("review-2", "李安然", 3),
    ];
    const details = new Map(queue.map((item) => [item.id, detail(item.id, item.studentName, item.revision)]));
    let revisionBody: unknown;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: queue });
      if (url === "/api/reviews") return Response.json({ ok: true, data: [...details.values()] });
      const revisionMatch = /^\/api\/reviews\/(review-\d)\/revision-request$/u.exec(url);
      if (revisionMatch && init?.method === "POST") {
        revisionBody = JSON.parse(String(init.body));
        queue.splice(0, 1);
        return Response.json({ ok: true, data: { newlyQueued: true, job: {
          id: "job-1", reviewId: "review-1", mode: "content_only", status: "queued", progressStage: "queued",
          message: null, createdAt: "2026-08-22T06:00:00.000Z", finishedAt: null,
        } } }, { status: 202 });
      }
      const detailMatch = /^\/api\/reviews\/(review-\d)$/u.exec(url);
      if (detailMatch) return Response.json({ ok: true, data: details.get(detailMatch[1]) });
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    expect(await screen.findByRole("heading", { name: "张小明" })).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/reviews/review-2", expect.anything()));
    await user.click(screen.getByRole("button", { name: "不合适" }));
    await user.type(screen.getByRole("textbox", { name: "为什么不合适" }), "批改没有回应题目要求");
    await user.type(screen.getByRole("textbox", { name: "应该怎么改" }), "请围绕题目重写批改");
    await user.click(screen.getByRole("button", { name: "提交后台修改并继续" }));

    expect(revisionBody).toEqual({ expectedRevision: 7, reason: "批改没有回应题目要求", changeRequest: "请围绕题目重写批改" });
    expect(await screen.findByRole("heading", { name: "李安然" })).toBeVisible();
    expect(screen.queryByText("正在展开作文与批改报告")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /张小明/u })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "已复核待导出清单 (0)" })).toBeVisible();
  });

  it("完全不能用直接标为审核不通过并进入下一篇，不触发重新分析", async () => {
    const queue = [
      queueItem("review-1", "张小明", 7),
      queueItem("review-2", "李安然", 3),
    ];
    const details = new Map(queue.map((item) => [item.id, detail(item.id, item.studentName, item.revision)]));
    let rejectBody: unknown;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: queue });
      if (url === "/api/reviews") return Response.json({ ok: true, data: [...details.values()] });
      if (url === "/api/reviews/review-1/reject" && init?.method === "POST") {
        rejectBody = JSON.parse(String(init.body));
        queue.splice(0, 1);
        return Response.json({ ok: true, data: {
          id: "review-1", status: "rejected", revision: 8, rejectionReason: "离题", rejectionChangeRequest: null,
        } });
      }
      const detailMatch = /^\/api\/reviews\/(review-\d)$/u.exec(url);
      if (detailMatch) return Response.json({ ok: true, data: details.get(detailMatch[1]) });
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    expect(await screen.findByRole("heading", { name: "张小明" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "不合适" }));
    await user.type(screen.getByRole("textbox", { name: "为什么不合适" }), "离题");
    await user.click(screen.getByRole("button", { name: "完全不能用" }));

    expect(rejectBody).toEqual({ expectedRevision: 7, reason: "离题", changeRequest: "" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("revision-request"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/analyze"))).toBe(false);
    expect(await screen.findByRole("heading", { name: "李安然" })).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /张小明/u })).not.toBeInTheDocument();
  });

  it("keeps the current essay, dialog, and fields when revision request fails", async () => {
    mockReviewApi([queueItem("review-1", "张小明", 2)]);
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: [queueItem("review-1", "张小明", 2)] });
      if (url === "/api/reviews") return Response.json({ ok: true, data: [detail("review-1", "张小明", 2)] });
      if (url === "/api/reviews/review-1") return Response.json({ ok: true, data: detail("review-1", "张小明", 2) });
      if (url === "/api/reviews/review-1/revision-request" && init?.method === "POST") return Response.json({ ok: false, error: { message: "退回失败，请重试" } }, { status: 500 });
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    expect(await screen.findByRole("heading", { name: "张小明" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "不合适" }));
    await user.type(screen.getByRole("textbox", { name: "为什么不合适" }), "原因保留");
    await user.type(screen.getByRole("textbox", { name: "应该怎么改" }), "要求保留");
    await user.click(screen.getByRole("button", { name: "提交后台修改并继续" }));

    expect(await screen.findByText("退回失败，请重试")).toBeVisible();
    expect(screen.getByRole("heading", { name: "张小明" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "为什么不合适" })).toHaveValue("原因保留");
    expect(screen.getByRole("textbox", { name: "应该怎么改" })).toHaveValue("要求保留");
  });

  it("confirms before opening the unsuitable dialog when the current review is dirty", async () => {
    mockReviewApi([queueItem("review-1", "张小明", 1), queueItem("review-2", "李安然", 2)]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    const suggestion = (await screen.findAllByRole("textbox", { name: "修改意见" }))[0];
    await user.type(suggestion, "补充听觉细节");
    await user.click(screen.getByRole("button", { name: "不合适" }));

    expect(confirm).toHaveBeenCalledWith("当前修改尚未审核保存，确认切换作文？");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "张小明" })).toBeVisible();
    expect(suggestion).toHaveValue("补充动作补充听觉细节");
  });

  it("does not add a successfully returned review to reviewed or export collections", async () => {
    const queue = [queueItem("review-1", "张小明", 1)];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: queue });
      if (url === "/api/reviews") return Response.json({ ok: true, data: [detail("review-1", "张小明", 1)] });
      if (url === "/api/reviews/review-1") return Response.json({ ok: true, data: detail("review-1", "张小明", 1) });
      if (url === "/api/reviews/review-1/revision-request" && init?.method === "POST") return Response.json({ ok: true, data: { newlyQueued: true, job: { id: "job-1", reviewId: "review-1", mode: "content_only", status: "queued", progressStage: "queued", message: null, createdAt: "2026-08-22T06:00:00.000Z", finishedAt: null } } }, { status: 202 });
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    await screen.findByRole("heading", { name: "张小明" });
    await user.click(screen.getByRole("button", { name: "不合适" }));
    await user.type(screen.getByRole("textbox", { name: "为什么不合适" }), "原因");
    await user.type(screen.getByRole("textbox", { name: "应该怎么改" }), "要求");
    await user.click(screen.getByRole("button", { name: "提交后台修改并继续" }));

    expect(await screen.findByRole("heading", { name: "待审核队列已完成" })).toBeVisible();
    expect(screen.getByRole("button", { name: "已复核待导出清单 (0)" })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith("/api/reviews/review-1/revision-request", expect.objectContaining({ method: "POST" }));
  });

  it("polls revision jobs every two seconds and refreshes the queue without stealing the active review", async () => {
    const queue = [queueItem("review-1", "张小明", 1), queueItem("review-2", "李安然", 2)];
    const details = new Map(queue.map((item) => [item.id, detail(item.id, item.studentName, item.revision)]));
    let statusCalls = 0;
    let queueCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") {
        queueCalls += 1;
        return Response.json({ ok: true, data: queueCalls === 1 ? queue : [queue[1]] });
      }
      if (url === "/api/reviews") return Response.json({ ok: true, data: [...details.values()] });
      if (url === "/api/reviews/review-1") return Response.json({ ok: true, data: details.get("review-1") });
      if (url === "/api/reviews/review-2") return Response.json({ ok: true, data: details.get("review-2") });
      if (url === "/api/reviews/review-1/revision-request" && init?.method === "POST") return Response.json({ ok: true, data: { newlyQueued: true, job: { id: "job-1", reviewId: "review-1", mode: "content_only", status: "queued", progressStage: "queued", message: null, createdAt: "2026-08-22T06:00:00.000Z", finishedAt: null } } }, { status: 202 });
      if (url === "/api/reviews/review-1/analyze/status") {
        statusCalls += 1;
        return Response.json({ ok: true, data: { job: { id: "job-1", reviewId: "review-1", mode: "content_only", status: statusCalls === 1 ? "queued" : "succeeded", progressStage: statusCalls === 1 ? "queued" : "saving_result", message: null, createdAt: "2026-08-22T06:00:00.000Z", finishedAt: statusCalls === 1 ? null : "2026-08-22T06:01:00.000Z" } } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<BatchReviewPage />);

    expect(await screen.findByRole("heading", { name: "张小明" })).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/reviews/review-2", expect.anything()));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "不合适" }));
    await user.type(screen.getByRole("textbox", { name: "为什么不合适" }), "原因");
    await user.type(screen.getByRole("textbox", { name: "应该怎么改" }), "要求");
    await user.click(screen.getByRole("button", { name: "提交后台修改并继续" }));
    expect(await screen.findByRole("heading", { name: "李安然" })).toBeVisible();

    await waitFor(() => expect(statusCalls).toBeGreaterThan(0), { timeout: 3_000 });
    await waitFor(() => expect(statusCalls).toBeGreaterThan(1), { timeout: 3_000 });
    await waitFor(() => expect(queueCalls).toBeGreaterThan(1), { timeout: 3_000 });
    expect(screen.getByRole("heading", { name: "李安然" })).toBeVisible();
  }, 12_000);

  it("immediately shows a safe failure notice and never requeues a failed revision job", async () => {
    const queue = [queueItem("review-1", "张小明", 1)];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: queue });
      if (url === "/api/reviews") return Response.json({ ok: true, data: [detail("review-1", "张小明", 1)] });
      if (url === "/api/reviews/review-1") return Response.json({ ok: true, data: detail("review-1", "张小明", 1) });
      if (url === "/api/reviews/review-1/revision-request" && init?.method === "POST") return Response.json({ ok: true, data: { newlyQueued: true, job: { id: "job-1", reviewId: "review-1", mode: "content_only", status: "queued", progressStage: "queued", message: null, createdAt: "2026-08-22T06:00:00.000Z", finishedAt: null } } }, { status: 202 });
      if (url === "/api/reviews/review-1/analyze/status") {
        return Response.json({ ok: true, data: { job: { id: "job-1", reviewId: "review-1", mode: "content_only", status: "failed", progressStage: "saving_result", message: "internal details", createdAt: "2026-08-22T06:00:00.000Z", finishedAt: "2026-08-22T06:01:00.000Z" } } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<BatchReviewPage />);
    await screen.findByRole("heading", { name: "张小明" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "不合适" }));
    await user.type(screen.getByRole("textbox", { name: "为什么不合适" }), "原因");
    await user.type(screen.getByRole("textbox", { name: "应该怎么改" }), "要求");
    await user.click(screen.getByRole("button", { name: "提交后台修改并继续" }));
    await screen.findByRole("heading", { name: "待审核队列已完成" });

    expect(await screen.findByRole("status")).toHaveTextContent("退回后的重新分析失败，作文未加入待审核队列。");
    expect(screen.queryByRole("button", { name: /张小明/u })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/reviews/review-1/analyze/status", undefined);
  }, 7_000);

  it("prefetches two successors and switches immediately after atomic teacher review", async () => {
    const queue = [
      { id: "review-1", studentName: "张小明", title: "作文1", status: "ready_for_review", revision: 1, createdAt: "2026-08-22T01:00:00.000Z" },
      { id: "review-2", studentName: "李安然", title: "作文2", status: "ready_for_review", revision: 2, createdAt: "2026-08-22T02:00:00.000Z" },
      { id: "review-3", studentName: "王若宁", title: "作文3", status: "ready_for_review", revision: 3, createdAt: "2026-08-22T03:00:00.000Z" },
    ];
    const details = new Map([
      ["review-1", detail("review-1", "张小明", 1)],
      ["review-2", detail("review-2", "李安然", 2)],
      ["review-3", detail("review-3", "王若宁", 3)],
    ]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: queue });
      if (url === "/api/reviews") return Response.json({ ok: true, data: [...details.values()] });
      const teacherMatch = /^\/api\/reviews\/(review-\d)\/teacher-review$/u.exec(url);
      if (teacherMatch && init?.method === "POST") {
        const current = details.get(teacherMatch[1])!;
        return Response.json({ ok: true, data: { ...current, revision: current.revision + 1, teacherReviewedAt: "2026-08-22T06:00:00.000Z" } });
      }
      const detailMatch = /^\/api\/reviews\/(review-\d)$/u.exec(url);
      if (detailMatch) return Response.json({ ok: true, data: details.get(detailMatch[1]) });
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    expect(await screen.findByRole("heading", { name: "张小明" })).toBeVisible();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/reviews/review-2", expect.anything());
      expect(fetchMock).toHaveBeenCalledWith("/api/reviews/review-3", expect.anything());
    });
    await user.click(screen.getByRole("button", { name: "审核通过并进入下一篇" }));
    expect(await screen.findByRole("heading", { name: "李安然" })).toBeVisible();
    expect(screen.queryByText("正在展开作文与批改报告")).not.toBeInTheDocument();
  });

  it("keeps the current edits when teacher review saving fails", async () => {
    mockReviewApi([queueItem("review-1", "张小明", 1)], { rejectTeacherReview: true });
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    const suggestion = (await screen.findAllByRole("textbox", { name: "修改意见" }))[0];
    await user.clear(suggestion);
    await user.type(suggestion, "补充听觉细节");
    await user.click(screen.getByRole("button", { name: "审核通过并进入下一篇" }));

    expect(await screen.findByText("保存失败，请重试")).toBeVisible();
    expect(suggestion).toHaveValue("补充听觉细节");
    expect(screen.getByRole("heading", { name: "张小明" })).toBeVisible();
  });

  it("asks for confirmation before switching away from unsaved edits", async () => {
    mockReviewApi([
      queueItem("review-1", "张小明", 1),
      queueItem("review-2", "李安然", 2),
    ]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    const suggestion = (await screen.findAllByRole("textbox", { name: "修改意见" }))[0];
    await user.type(suggestion, "补充听觉细节");
    await user.click(screen.getByRole("button", { name: /李安然/u }));

    expect(confirm).toHaveBeenCalledWith("当前修改尚未审核保存，确认切换作文？");
    expect(screen.getByRole("heading", { name: "张小明" })).toBeVisible();
    expect(suggestion).toHaveValue("补充动作补充听觉细节");
  });

  it("continues within the student-name search results after review", async () => {
    mockReviewApi([
      queueItem("review-1", "张小明", 1),
      queueItem("review-2", "李安然", 2),
      queueItem("review-3", "张晓雨", 3),
    ]);
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    await screen.findByRole("heading", { name: "张小明" });
    await user.type(screen.getByRole("searchbox", { name: "搜索待审核学生姓名" }), "张");
    expect(screen.queryByRole("button", { name: /李安然/u })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "审核通过并进入下一篇" }));

    expect(await screen.findByRole("heading", { name: "张晓雨" })).toBeVisible();
  });

  it("shows the completed state after the last queued review", async () => {
    mockReviewApi([queueItem("review-1", "张小明", 1)]);
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    await screen.findByRole("heading", { name: "张小明" });
    await user.click(screen.getByRole("button", { name: "审核通过并进入下一篇" }));

    expect(await screen.findByRole("heading", { name: "待审核队列已完成" })).toBeVisible();
    expect(screen.getByRole("button", { name: "已复核待导出清单 (1)" })).toBeVisible();
  });

  it("历史段落数不符合题目配置时引导到单篇复核且禁止审核", async () => {
    mockReviewApi([queueItem("review-1", "张小明", 1)], {
      currentReport: {
        ...report,
        sampleParagraphs: report.sampleParagraphs.slice(0, 3),
      },
    });
    render(<BatchReviewPage />);

    await screen.findByRole("heading", { name: "张小明" });
    expect(screen.getByText("示范作文段落数不符合题目要求。")).toBeVisible();
    expect(screen.getByRole("button", { name: "审核通过并进入下一篇" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "前往单篇复核" })).toHaveAttribute(
      "href",
      "/reviews?id=review-1",
    );
  });

  it("重新进入页面时从历史接口恢复已复核待导出清单", async () => {
    const queue = [queueItem("review-2", "李安然", 2)];
    const reviewed = { ...detail("review-1", "张小明", 1, paragraphReport), teacherReviewedAt: "2026-08-22T06:00:00.000Z" };
    const pending = detail("review-2", "李安然", 2, paragraphReport);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: queue });
      if (url === "/api/reviews") return Response.json({ ok: true, data: [reviewed, pending] });
      if (url === "/api/reviews/review-2") return Response.json({ ok: true, data: pending });
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    await user.click(await screen.findByRole("button", { name: "已复核待导出清单 (1)" }));

    expect(screen.getByRole("heading", { name: "张小明" })).toBeVisible();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/reviews")).toBe(true);
  });

  it("一键导出已复核成功后重新读取历史并移除已导出记录", async () => {
    const queue = [queueItem("review-2", "李安然", 2)];
    const reviewed = { ...detail("review-1", "张小明", 1, paragraphReport), teacherReviewedAt: "2026-08-22T06:00:00.000Z" };
    const pending = detail("review-2", "李安然", 2, paragraphReport);
    let exported = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: queue });
      if (url === "/api/reviews") return Response.json({ ok: true, data: [exported ? { ...reviewed, status: "exported" } : reviewed, pending] });
      if (url === "/api/reviews/review-2") return Response.json({ ok: true, data: pending });
      throw new Error(`Unexpected request: ${url}`);
    });
    reviewExports.batch.mockImplementationOnce(async () => {
      exported = true;
      return "作文批改批量导出.zip";
    });
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    await user.click(await screen.findByRole("button", { name: "已复核待导出清单 (1)" }));
    await user.click(screen.getByRole("button", { name: "导出全部已复核" }));
    await user.click(screen.getByRole("menuitem", { name: "Word (.docx)" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "已复核待导出清单 (0)" })).toBeVisible());
    expect(screen.getByText("还没有已复核待导出作文")).toBeVisible();
    expect(reviewExports.batch).toHaveBeenCalledWith(["review-1"], "docx");
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/reviews").length).toBe(2);
  });

  it("批量导出失败时保留全部选择", async () => {
    const queue = [queueItem("review-2", "李安然", 2)];
    const reviewed = {
      ...detail("review-1", "张小明", 1, paragraphReport),
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: queue });
      if (url === "/api/reviews") return Response.json({ ok: true, data: [reviewed] });
      if (url === "/api/reviews/review-2") return Response.json({ ok: true, data: detail("review-2", "李安然", 2, paragraphReport) });
      throw new Error(`Unexpected request: ${url}`);
    });
    reviewExports.batch.mockRejectedValueOnce(new Error("导出失败"));
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    await user.click(await screen.findByRole("button", { name: "已复核待导出清单 (1)" }));
    await user.click(screen.getByRole("checkbox", { name: "选择张小明的作文导出" }));
    await user.click(screen.getByRole("button", { name: "导出所选作文" }));
    await user.click(screen.getByRole("menuitem", { name: "PDF" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("导出失败");
    expect(screen.getByRole("checkbox", { name: "选择张小明的作文导出" })).toBeChecked();
    expect(reviewExports.batch).toHaveBeenCalledWith(["review-1"], "pdf");
  });
});
