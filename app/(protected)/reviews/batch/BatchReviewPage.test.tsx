import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParagraphEvaluationReport } from "../../../../src/domain/contracts";

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

const paragraphReport: ParagraphEvaluationReport = {
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

function isPendingExportUrl(url: string): boolean {
  return (
    url === "/api/reviews"
    || url === "/api/reviews?scope=pending-export"
    || url === "/api/reviews?summary=1&scope=pending-export"
  );
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
    {
      ...detail(item.id, item.studentName, item.revision, options.currentReport),
      ...(item.className !== undefined ? { className: item.className } : {}),
    },
  ]));
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: queue });
    if (isPendingExportUrl(url)) return Response.json({ ok: true, data: [...details.values()] });
    if (url === "/api/grading-opinions") return Response.json({ ok: true, data: [] });
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
  it("退回弹窗仅追加同题已通过规则，保留原文并可手改", async () => {
    const fetchMock = mockReviewApi([queueItem("review-1", "张小明", 1)]);
    const originalFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => String(input) === "/api/grading-opinions"
      ? Promise.resolve(Response.json({ ok: true, data: [
        { text: "开头点题。\n保留  停顿！", scope: "standing", sourceTitle: "作文1" },
        { text: "开头点题。\n保留  停顿！", scope: "standing", sourceTitle: "作文1" },
        { text: "别的题目的规则", scope: "standing", sourceTitle: "作文2" },
        { text: "只用于本篇的建议", scope: "essay", sourceTitle: "作文1" },
      ] })) : originalFetch(input, init));
    const user = userEvent.setup();
    render(<BatchReviewPage />);
    await screen.findByRole("heading", { name: "张小明" });
    await user.click(screen.getByRole("button", { name: "不合适" }));
    const rules = await screen.findByRole("group", { name: "已通过的长期规则" });
    expect(within(rules).getAllByRole("button")).toHaveLength(1);
    await user.click(within(rules).getByRole("button"));
    const common = screen.getByRole("textbox", { name: "结构问题 / 共性问题（仅同名作文）" });
    expect(common).toHaveValue("开头点题。\n保留  停顿！");
    await user.type(common, "\n手改补充");
    expect(common).toHaveValue("开头点题。\n保留  停顿！\n手改补充");
    expect(screen.getByRole("textbox", { name: "内容建议（仅当前文章）" })).toHaveValue("");
  });

  it("关闭后切换作文，忽略上一轮迟到的规则响应", async () => {
    const fetchMock = mockReviewApi([queueItem("review-1", "张小明", 1), queueItem("review-2", "李安然", 2)]);
    const originalFetch = fetchMock.getMockImplementation()!;
    let resolveOld!: (response: Response) => void;
    let oldSignal: AbortSignal | null | undefined;
    let ruleRequests = 0;
    fetchMock.mockImplementation((input, init) => {
      if (String(input) !== "/api/grading-opinions") return originalFetch(input, init);
      ruleRequests += 1;
      if (ruleRequests === 1) {
        oldSignal = init?.signal;
        return new Promise<Response>((resolve) => { resolveOld = resolve; });
      }
      return Promise.resolve(Response.json({ ok: true, data: [{ text: "作文二的规则", scope: "standing", sourceTitle: "作文2" }] }));
    });
    const user = userEvent.setup();
    render(<BatchReviewPage />);
    await screen.findByRole("heading", { name: "张小明" });
    await user.click(screen.getByRole("button", { name: "不合适" }));
    await user.type(screen.getByRole("textbox", { name: "内容建议（仅当前文章）" }), "加载期间也能输入");
    await user.click(screen.getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("button", { name: /李安然/ }));
    await screen.findByRole("heading", { name: "李安然" });
    await user.click(screen.getByRole("button", { name: "不合适" }));
    await screen.findByRole("button", { name: "追加规则：作文二的规则" });
    await act(async () => {
      resolveOld(Response.json({ ok: true, data: [{ text: "迟到的作文一规则", scope: "standing", sourceTitle: "作文1" }] }));
    });
    expect(oldSignal?.aborted).toBe(true);
    expect(screen.queryByRole("button", { name: "追加规则：迟到的作文一规则" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "追加规则：作文二的规则" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "内容建议（仅当前文章）" })).toHaveValue("");
  });

  it("审核操作栏在三栏上方，底部不再有重复按钮", async () => {
    mockReviewApi([queueItem("review-1", "张小明", 1)], { currentReport: paragraphReport });
    const { container } = render(<BatchReviewPage />);
    await screen.findByRole("textbox", { name: "第 1 段改后全段" });
    const toolbar = screen.getByRole("toolbar", { name: "审核操作" });
    expect(toolbar).toHaveClass("batch-review-actionbar");
    expect(toolbar).toHaveTextContent("修改将在审核确认时保存");
    expect(screen.getAllByRole("button", { name: "不合适" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "审核通过并进入下一篇" })).toHaveLength(1);
    expect(toolbar).toContainElement(screen.getByRole("button", { name: "不合适" }));
    expect(toolbar).toContainElement(screen.getByRole("button", { name: "审核通过并进入下一篇" }));
    const layout = container.querySelector(".batch-review-layout")!;
    const essayPane = layout.querySelector(".batch-essay-pane")!;
    expect(toolbar.compareDocumentPosition(essayPane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector("footer.batch-review-footer, .batch-review-footer")).toBeNull();
  });

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
    reviewExports.batch.mockClear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("逐段报告可编辑修改动作与改后全段并完成批量审核，不受示范段数门禁影响", async () => {
    const fetchMock = mockReviewApi([queueItem("review-1", "张小明", 1)], {
      currentReport: paragraphReport,
    });
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    expect(await screen.findByRole("heading", { name: "修改动作与改后全段" })).toBeVisible();
    expect(screen.queryByTestId("page-crop-1")).not.toBeInTheDocument();
    expect(screen.getByText("【修改动作】")).toBeInTheDocument();
    expect(screen.getByLabelText("第 1 段修改动作")).toBeInTheDocument();
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

  it("冲突旧稿必须先明确选择保留版本再审核", async () => {
    const fetchMock = mockReviewApi([queueItem("review-1", "张小明", 1)], {
      currentReport: { ...paragraphReport, rewrittenEssay: ["旧范文里的第一段。"] } as typeof paragraphReport,
    });
    const user = userEvent.setup();
    render(<BatchReviewPage />);
    expect(await screen.findByLabelText("第 1 段改后全段")).toHaveValue("我走上台。");
    expect(screen.getByLabelText("第 1 段改后全段")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "保留逐段稿（1 段）" }));
    await user.click(screen.getByRole("button", { name: "审核通过并进入下一篇" }));
    const teacherCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/reviews/review-1/teacher-review");
    const submittedReport = JSON.parse(String(teacherCall?.[1]?.body)).report;
    expect(submittedReport.paragraphReviews[0].revisedText).toBe("我走上台。");
    expect(submittedReport.rewrittenEssay).toEqual(["我走上台。"]);
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
      if (isPendingExportUrl(url)) return Response.json({ ok: true, data: [groupedDetail] });
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
    expect(screen.getAllByRole("textbox", { name: /修改动作/u })).toHaveLength(2);
    const essayParagraph = screen.getByLabelText("完整范文第 2 段");
    await user.clear(essayParagraph);
    await user.type(essayParagraph, "结尾改过。");
    expect(screen.getByLabelText("第 2 段改后全段")).toHaveValue("结尾改过。");
    expect(screen.queryByText("与逐段不一致")).not.toBeInTheDocument();
    const revised = screen.getByLabelText("第 1 段改后全段");
    await user.clear(revised);
    await user.type(revised, "我听见呼吸声，走上了台。天很蓝。");
    expect(screen.getByLabelText("完整范文第 1 段")).toHaveValue("我听见呼吸声，走上了台。天很蓝。");
    expect(screen.getByLabelText("第 1 段改后全段")).toHaveValue("我听见呼吸声，走上了台。天很蓝。");
    expect(screen.getByLabelText("第 2 段改后全段")).toHaveValue("结尾改过。");
    expect(screen.queryByText("与逐段不一致")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "审核通过并进入下一篇" }));

    const teacherCall = fetchMock.mock.calls.find(([input]) => (
      String(input) === "/api/reviews/review-1/teacher-review"
    ));
    expect(screen.queryByRole("textbox", { name: /第 \d+ 段第 \d+ 条修改动作/u })).not.toBeInTheDocument();
    expect(JSON.parse(String(teacherCall?.[1]?.body)).report).toMatchObject({
      rewrittenEssay: ["我听见呼吸声，走上了台。天很蓝。", "结尾改过。"],
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
          revisedText: "结尾改过。",
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
      if (isPendingExportUrl(url)) return Response.json({ ok: true, data: [...details.values()] });
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
    await user.type(screen.getByRole("textbox", { name: "结构问题 / 共性问题（仅同名作文）" }), "批改没有回应题目要求");
    await user.type(screen.getByRole("textbox", { name: "内容建议（仅当前文章）" }), "请围绕题目重写批改");
    await user.click(screen.getByRole("button", { name: "提交后台修改并继续" }));

    expect(revisionBody).toEqual({
      expectedRevision: 7,
      commonIssue: "批改没有回应题目要求",
      contentSuggestion: "请围绕题目重写批改",
    });
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
      if (isPendingExportUrl(url)) return Response.json({ ok: true, data: [...details.values()] });
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
    await user.type(screen.getByRole("textbox", { name: "结构问题 / 共性问题（仅同名作文）" }), "离题");
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
      if (isPendingExportUrl(url)) return Response.json({ ok: true, data: [detail("review-1", "张小明", 2)] });
      if (url === "/api/reviews/review-1") return Response.json({ ok: true, data: detail("review-1", "张小明", 2) });
      if (url === "/api/reviews/review-1/revision-request" && init?.method === "POST") return Response.json({ ok: false, error: { message: "退回失败，请重试" } }, { status: 500 });
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    expect(await screen.findByRole("heading", { name: "张小明" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "不合适" }));
    await user.type(screen.getByRole("textbox", { name: "结构问题 / 共性问题（仅同名作文）" }), "原因保留");
    await user.type(screen.getByRole("textbox", { name: "内容建议（仅当前文章）" }), "要求保留");
    await user.click(screen.getByRole("button", { name: "提交后台修改并继续" }));

    expect(await screen.findByText("退回失败，请重试")).toBeVisible();
    expect(screen.getByRole("heading", { name: "张小明" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "结构问题 / 共性问题（仅同名作文）" })).toHaveValue("原因保留");
    expect(screen.getByRole("textbox", { name: "内容建议（仅当前文章）" })).toHaveValue("要求保留");
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
      if (isPendingExportUrl(url)) return Response.json({ ok: true, data: [detail("review-1", "张小明", 1)] });
      if (url === "/api/reviews/review-1") return Response.json({ ok: true, data: detail("review-1", "张小明", 1) });
      if (url === "/api/reviews/review-1/revision-request" && init?.method === "POST") return Response.json({ ok: true, data: { newlyQueued: true, job: { id: "job-1", reviewId: "review-1", mode: "content_only", status: "queued", progressStage: "queued", message: null, createdAt: "2026-08-22T06:00:00.000Z", finishedAt: null } } }, { status: 202 });
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    await screen.findByRole("heading", { name: "张小明" });
    await user.click(screen.getByRole("button", { name: "不合适" }));
    await user.type(screen.getByRole("textbox", { name: "结构问题 / 共性问题（仅同名作文）" }), "原因");
    await user.type(screen.getByRole("textbox", { name: "内容建议（仅当前文章）" }), "要求");
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
      if (isPendingExportUrl(url)) return Response.json({ ok: true, data: [...details.values()] });
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
    await user.type(screen.getByRole("textbox", { name: "结构问题 / 共性问题（仅同名作文）" }), "原因");
    await user.type(screen.getByRole("textbox", { name: "内容建议（仅当前文章）" }), "要求");
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
      if (isPendingExportUrl(url)) return Response.json({ ok: true, data: [detail("review-1", "张小明", 1)] });
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
    await user.type(screen.getByRole("textbox", { name: "结构问题 / 共性问题（仅同名作文）" }), "原因");
    await user.type(screen.getByRole("textbox", { name: "内容建议（仅当前文章）" }), "要求");
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
      if (isPendingExportUrl(url)) return Response.json({ ok: true, data: [...details.values()] });
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

  it("重新进入页面时从待导出摘要接口恢复已复核待导出清单，不拉取全量历史或待导出大正文，点返回修改才按需拉详情", async () => {
    const queue = [queueItem("review-2", "李安然", 2)];
    const reviewedDetail = { ...detail("review-1", "张小明", 1, paragraphReport), teacherReviewedAt: "2026-08-22T06:00:00.000Z" };
    const reviewedSummary = {
      id: "review-1",
      status: "ready_for_review" as const,
      studentName: "张小明",
      className: "六（1）班",
      config: { title: "作文1" },
      revision: 1,
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T06:00:00.000Z",
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
      hasReport: true,
      isLegacyReport: false,
      grade: "A-",
      diagnostics: {
        authenticityAndRelevance: paragraphReport.diagnostics!.authenticityAndRelevance,
        structure: paragraphReport.diagnostics!.structure,
      },
      hasPdf: false,
      pdfFilename: null,
      exportEligibility: { eligible: true } as const,
    };
    const pending = detail("review-2", "李安然", 2, paragraphReport);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: queue });
      if (url === "/api/reviews?summary=1&scope=pending-export") return Response.json({ ok: true, data: [reviewedSummary] });
      if (url === "/api/reviews/review-2") return Response.json({ ok: true, data: pending });
      if (url === "/api/reviews/review-1") return Response.json({ ok: true, data: reviewedDetail });
      throw new Error(`Unexpected request: ${url}`);
    });
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    await user.click(await screen.findByRole("button", { name: "已复核待导出清单 (1)" }));

    expect(screen.getByRole("heading", { name: "张小明" })).toBeVisible();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/reviews?summary=1&scope=pending-export")).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/reviews")).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/reviews/review-1")).toBe(false);

    // 点击「返回修改」时才按需拉取 review-1 单篇完整详情
    await user.click(screen.getByRole("button", { name: "返回修改" }));
    expect(await screen.findByRole("heading", { name: "张小明" })).toBeVisible();
    expect(await screen.findByLabelText("第 1 段改后全段")).toHaveValue("我走上台。");
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/reviews/review-1")).toBe(true);

    // 修改标线后未点「审核通过」直接切回待导出清单时，弹窗拦截防止误导出旧标线
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    await user.click(screen.getByRole("button", { name: "第 1 段清空全段标线" }));
    await user.click(screen.getByRole("button", { name: "已复核待导出清单 (1)" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("第 1 段改后全段")).toBeVisible();

    // 确认放弃修改后才切回待导出清单，且丢弃未保存本地草稿
    await user.click(screen.getByRole("button", { name: "已复核待导出清单 (1)" }));
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("button", { name: "返回修改" })).toBeVisible();
  });

  it("一键导出已复核成功后重新读取历史并移除已导出记录", async () => {
    const queue = [queueItem("review-2", "李安然", 2)];
    const reviewed = { ...detail("review-1", "张小明", 1, paragraphReport), teacherReviewedAt: "2026-08-22T06:00:00.000Z" };
    const pending = detail("review-2", "李安然", 2, paragraphReport);
    let exported = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: queue });
      if (url === "/api/reviews?summary=1&scope=pending-export") return Response.json({ ok: true, data: exported ? [] : [reviewed] });
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
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/reviews?summary=1&scope=pending-export").length).toBeGreaterThanOrEqual(3);
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
      if (isPendingExportUrl(url)) return Response.json({ ok: true, data: [reviewed] });
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

  it("切换至未预读的第 4 篇且详情慢响应时，立即收起旧编辑器并禁用通过/退回，绝不误审第 1 篇", async () => {
    const queue = [
      queueItem("review-1", "虚构一", 1),
      queueItem("review-2", "虚构二", 2),
      queueItem("review-3", "虚构三", 3),
      queueItem("review-4", "虚构四", 4),
    ];
    const details = new Map(queue.map((item) => [
      item.id,
      detail(item.id, item.studentName, item.revision, paragraphReport),
    ]));
    let resolveFourth!: (response: Response) => void;
    const teacherCalls: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Promise.resolve(Response.json({ ok: true, data: queue }));
      if (isPendingExportUrl(url)) return Promise.resolve(Response.json({ ok: true, data: [] }));
      const teacherMatch = /^\/api\/reviews\/(review-\d)\/teacher-review$/u.exec(url);
      if (teacherMatch && init?.method === "POST") {
        teacherCalls.push(teacherMatch[1]!);
        const current = details.get(teacherMatch[1]!)!;
        return Promise.resolve(Response.json({
          ok: true,
          data: { ...current, revision: current.revision + 1, teacherReviewedAt: "2026-08-22T06:00:00.000Z" },
        }));
      }
      if (url === "/api/reviews/review-4") {
        return new Promise<Response>((resolve) => { resolveFourth = resolve; });
      }
      const detailMatch = /^\/api\/reviews\/(review-\d)$/u.exec(url);
      if (detailMatch) return Promise.resolve(Response.json({ ok: true, data: details.get(detailMatch[1]!) }));
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<BatchReviewPage />);

    // 第 1 篇已打开并显示编辑器
    expect(await screen.findByRole("heading", { name: "虚构一" })).toBeVisible();
    expect(screen.getByLabelText("第 1 段改后全段")).toBeInTheDocument();

    // 点击尚未缓存的第 4 篇（在预读窗口 1~3 之外）
    await user.click(screen.getByRole("button", { name: /虚构四/u }));

    // 旧学生标题与编辑器立即消失，通过与退回按钮均禁用
    expect(screen.queryByRole("heading", { name: "虚构一" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("第 1 段改后全段")).not.toBeInTheDocument();
    const approveBtn = screen.getByRole("button", { name: "审核通过并进入下一篇" });
    const rejectBtn = screen.getByRole("button", { name: "不合适" });
    expect(approveBtn).toBeDisabled();
    expect(rejectBtn).toBeDisabled();

    await user.click(approveBtn);
    expect(teacherCalls).toEqual([]);

    // 待第 4 篇详情返回后，审核提交的目标必须是 review-4
    await act(async () => {
      resolveFourth(Response.json({ ok: true, data: details.get("review-4") }));
    });
    expect(await screen.findByRole("heading", { name: "虚构四" })).toBeVisible();
    expect(approveBtn).toBeEnabled();
    await user.click(approveBtn);
    expect(teacherCalls).toEqual(["review-4"]);
  });

  it("切换至第 4 篇但详情请求失败时，保持审核按钮禁用且绝不提交上一位学生", async () => {
    const queue = [
      queueItem("review-1", "虚构一", 1),
      queueItem("review-2", "虚构二", 2),
      queueItem("review-3", "虚构三", 3),
      queueItem("review-4", "虚构四", 4),
    ];
    const details = new Map(queue.map((item) => [
      item.id,
      detail(item.id, item.studentName, item.revision, paragraphReport),
    ]));
    const teacherCalls: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: queue });
      if (isPendingExportUrl(url)) return Response.json({ ok: true, data: [] });
      const teacherMatch = /^\/api\/reviews\/(review-\d)\/teacher-review$/u.exec(url);
      if (teacherMatch && init?.method === "POST") {
        teacherCalls.push(teacherMatch[1]!);
        return Response.json({ ok: true, data: details.get(teacherMatch[1]!) });
      }
      if (url === "/api/reviews/review-4") {
        return Response.json({ ok: false, error: { message: "读取第 4 篇详情失败" } }, { status: 500 });
      }
      const detailMatch = /^\/api\/reviews\/(review-\d)$/u.exec(url);
      if (detailMatch) return Response.json({ ok: true, data: details.get(detailMatch[1]!) });
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<BatchReviewPage />);

    expect(await screen.findByRole("heading", { name: "虚构一" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /虚构四/u }));

    expect(await screen.findByRole("alert")).toHaveTextContent("读取第 4 篇详情失败");
    expect(screen.queryByRole("heading", { name: "虚构一" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("第 1 段改后全段")).not.toBeInTheDocument();
    const approveBtn = screen.getByRole("button", { name: "审核通过并进入下一篇" });
    const rejectBtn = screen.getByRole("button", { name: "不合适" });
    expect(approveBtn).toBeDisabled();
    expect(rejectBtn).toBeDisabled();

    await user.click(approveBtn);
    expect(teacherCalls).toEqual([]);
  });

  it("另一标签页更新版本导致详情 revision 高于旧队列时，按实际版本缓存并刷新队列对齐后正常审核", async () => {
    let queueCalls = 0;
    const updatedReport = {
      ...paragraphReport,
      paragraphReviews: [{
        ...paragraphReport.paragraphReviews[0]!,
        revisedText: "另一标签页已保存的最新改后全段。",
      }],
    };
    const updatedDetail = detail("review-1", "虚构一", 8, updatedReport);
    const secondDetail = detail("review-2", "虚构二", 2, paragraphReport);
    let submittedBody: unknown = null;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") {
        queueCalls += 1;
        return Response.json({
          ok: true,
          data: [
            queueItem("review-1", "虚构一", queueCalls === 1 ? 7 : 8),
            queueItem("review-2", "虚构二", 2),
          ],
        });
      }
      if (isPendingExportUrl(url)) return Response.json({ ok: true, data: [] });
      if (url === "/api/reviews/review-1") return Response.json({ ok: true, data: updatedDetail });
      if (url === "/api/reviews/review-2") return Response.json({ ok: true, data: secondDetail });
      if (url === "/api/reviews/review-1/teacher-review" && init?.method === "POST") {
        submittedBody = JSON.parse(String(init.body));
        return Response.json({
          ok: true,
          data: { ...updatedDetail, revision: 9, teacherReviewedAt: "2026-08-22T06:00:00.000Z" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<BatchReviewPage />);

    // 自动刷新队列将 review-1 对齐到 revision 8，编辑器成功渲染新版内容而非卡死在空白门禁
    expect(await screen.findByDisplayValue("另一标签页已保存的最新改后全段。")).toBeVisible();
    expect(queueCalls).toBe(2);

    const approveBtn = screen.getByRole("button", { name: "审核通过并进入下一篇" });
    expect(approveBtn).toBeEnabled();
    await user.click(approveBtn);

    expect(submittedBody).toMatchObject({
      expectedRevision: 8,
      studentName: "虚构一",
    });
    expect(await screen.findByRole("heading", { name: "虚构二" })).toBeVisible();
  });

  it("单学生详情首次请求失败后，再次点击左侧同一学生可重新发起 GET 请求并恢复审核", async () => {
    const queue = [queueItem("review-1", "虚构一", 3)];
    const targetDetail = detail("review-1", "虚构一", 3, paragraphReport);
    let detailCalls = 0;
    const teacherCalls: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: queue });
      if (isPendingExportUrl(url)) return Response.json({ ok: true, data: [] });
      if (url === "/api/reviews/review-1") {
        detailCalls += 1;
        if (detailCalls === 1) {
          return Response.json({ ok: false, error: { message: "网络波动，详情读取失败" } }, { status: 500 });
        }
        return Response.json({ ok: true, data: targetDetail });
      }
      if (url === "/api/reviews/review-1/teacher-review" && init?.method === "POST") {
        teacherCalls.push("review-1");
        return Response.json({
          ok: true,
          data: { ...targetDetail, revision: 4, teacherReviewedAt: "2026-08-22T06:00:00.000Z" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<BatchReviewPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("网络波动，详情读取失败");
    expect(detailCalls).toBe(1);
    const approveBtn = screen.getByRole("button", { name: "审核通过并进入下一篇" });
    expect(approveBtn).toBeDisabled();

    // 按页面提示重新点击左侧同一学生按钮，必须重新发起 GET 请求并恢复
    await user.click(screen.getByRole("button", { name: /虚构一/u }));

    expect(await screen.findByRole("heading", { name: "虚构一" })).toBeVisible();
    expect(detailCalls).toBe(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(approveBtn).toBeEnabled();

    await user.click(approveBtn);
    expect(teacherCalls).toEqual(["review-1"]);
  });

  it("筛选乙班时另一标签页已审完当前乙二学生，队列刷新后严格切到乙三而非全队列首篇甲一，绝不跨班误审", async () => {
    const initialQueue = [
      { ...queueItem("review-1", "甲一", 1), className: "六（1）班" },
      { ...queueItem("review-2", "甲二", 2), className: "六（1）班" },
      { ...queueItem("review-3", "甲三", 3), className: "六（1）班" },
      { ...queueItem("review-4", "乙二", 4), className: "六（2）班" },
      { ...queueItem("review-5", "乙三", 5), className: "六（2）班" },
    ];
    let queueCalls = 0;
    const details = new Map(initialQueue.map((item) => [
      item.id,
      { ...detail(item.id, item.studentName, item.revision, paragraphReport), className: item.className },
    ]));
    // 另一标签页已将 review-4（乙二）审核通过并出队
    const reviewedYi2 = {
      ...details.get("review-4")!,
      revision: 5,
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
    };
    const teacherCalls: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") {
        queueCalls += 1;
        return Response.json({
          ok: true,
          data: queueCalls === 1
            ? initialQueue
            : initialQueue.filter(({ id }) => id !== "review-4"),
        });
      }
      if (isPendingExportUrl(url)) return Response.json({ ok: true, data: [] });
      if (url === "/api/reviews/review-4") return Response.json({ ok: true, data: reviewedYi2 });
      const teacherMatch = /^\/api\/reviews\/(review-\d)\/teacher-review$/u.exec(url);
      if (teacherMatch && init?.method === "POST") {
        teacherCalls.push(teacherMatch[1]!);
        const current = details.get(teacherMatch[1]!)!;
        return Response.json({
          ok: true,
          data: { ...current, revision: current.revision + 1, teacherReviewedAt: "2026-08-22T06:10:00.000Z" },
        });
      }
      const detailMatch = /^\/api\/reviews\/(review-\d)$/u.exec(url);
      if (detailMatch) return Response.json({ ok: true, data: details.get(detailMatch[1]!) });
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<BatchReviewPage />);

    expect(await screen.findByRole("heading", { name: "甲一" })).toBeVisible();

    // 切换到乙班（六（2）班）：乙二已在另一标签页审完出队，必须自动回退到同属乙班的「乙三」，绝不能跳回全队列首篇「甲一」
    await user.selectOptions(screen.getByLabelText("班级筛选"), "class:六（2）班");

    expect(await screen.findByRole("heading", { name: "乙三" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "甲一" })).not.toBeInTheDocument();
    expect(queueCalls).toBe(2);

    // 点击「审核通过并进入下一篇」：提交目标必须是 review-5（乙三），且乙班无剩余待审后清空右侧并禁用按钮（尽管甲班仍有 3 篇）
    const approveBtn = screen.getByRole("button", { name: "审核通过并进入下一篇" });
    await user.click(approveBtn);

    expect(teacherCalls).toEqual(["review-5"]);
    expect(await screen.findByRole("heading", { name: "待审核队列已完成" })).toBeVisible();
    expect(approveBtn).toBeDisabled();
    expect(screen.getByRole("button", { name: "不合适" })).toBeDisabled();
  });

  it("筛选甲班时从待导出清单点返回修改，若另一标签页已将该生转入乙班，立即退出编辑并刷新双清单，绝不跨班误审", async () => {
    const queue = [{ ...queueItem("review-2", "甲二待审", 2), className: "六（1）班" }];
    // 当前标签页先审核或加载过的旧摘要仍显示张小明属于甲班（六（1）班）
    const staleSummary = {
      id: "review-1",
      status: "ready_for_review" as const,
      studentName: "张小明",
      className: "六（1）班",
      config: { title: "作文1" },
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
    // 另一标签页已把张小明转入乙班（六（2）班），revision 升至 2
    const transferredDetail = {
      ...detail("review-1", "张小明", 2, paragraphReport),
      className: "六（2）班",
      teacherReviewedAt: "2026-08-22T06:05:00.000Z",
    };
    const refreshedSummary = { ...staleSummary, className: "六（2）班", revision: 2 };
    const jia2Detail = { ...detail("review-2", "甲二待审", 2, paragraphReport), className: "六（1）班" };
    let pendingCalls = 0;
    const teacherCalls: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: queue });
      if (url === "/api/reviews?summary=1&scope=pending-export") {
        pendingCalls += 1;
        return Response.json({ ok: true, data: pendingCalls <= 2 ? [staleSummary] : [refreshedSummary] });
      }
      if (url === "/api/reviews/review-1") return Response.json({ ok: true, data: transferredDetail });
      if (url === "/api/reviews/review-2") return Response.json({ ok: true, data: jia2Detail });
      const teacherMatch = /^\/api\/reviews\/(review-\d)\/teacher-review$/u.exec(url);
      if (teacherMatch && init?.method === "POST") {
        teacherCalls.push(teacherMatch[1]!);
        return Response.json({
          ok: true,
          data: { ...jia2Detail, revision: 3, teacherReviewedAt: "2026-08-22T06:10:00.000Z" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<BatchReviewPage />);

    // 锁定筛选为甲班（六（1）班），切到待导出清单点击张小明的「返回修改」
    await user.selectOptions(await screen.findByLabelText("班级筛选"), "class:六（1）班");
    await user.click(screen.getByRole("button", { name: "已复核待导出清单 (1)" }));
    await user.click(screen.getByRole("button", { name: "返回修改" }));

    // 发现服务端张小明已转入乙班后，绝不允许展示乙班张小明的编辑器，而是回退到甲班可见队列中的「甲二待审」
    expect(await screen.findByRole("heading", { name: "甲二待审" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "张小明" })).not.toBeInTheDocument();
    expect(pendingCalls).toBe(3);

    // 此时点击「审核通过并进入下一篇」，提交目标只能是甲班的 review-2，绝不误审乙班的 review-1
    await user.click(screen.getByRole("button", { name: "审核通过并进入下一篇" }));
    expect(teacherCalls).toEqual(["review-2"]);
  });

  it("退回重分析任务完成后即便 review-queue 响应存在网络延迟，也不会因提前清理轮询导致新作文丢回队列", async () => {
    let requeued = false;
    const initialItem = queueItem("review-1", "张小明", 1);
    const returnedItem = queueItem("review-1", "张小明", 2);
    const initialDetail = detail("review-1", "张小明", 1, paragraphReport);
    const returnedDetail = detail("review-1", "张小明", 2, paragraphReport);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") {
        if (requeued) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return Response.json({ ok: true, data: [returnedItem] });
        }
        return Response.json({ ok: true, data: [initialItem] });
      }
      if (isPendingExportUrl(url)) return Response.json({ ok: true, data: [] });
      if (url === "/api/reviews/review-1") {
        return Response.json({ ok: true, data: requeued ? returnedDetail : initialDetail });
      }
      if (url === "/api/reviews/review-1/revision-request" && init?.method === "POST") {
        return Response.json({
          ok: true,
          data: {
            newlyQueued: true,
            job: {
              id: "job-1",
              reviewId: "review-1",
              mode: "content_only",
              status: "queued",
              progressStage: "queued",
              message: null,
              detail: null,
              createdAt: "2026-08-22T06:00:00.000Z",
              finishedAt: null,
            },
          },
        }, { status: 202 });
      }
      if (url === "/api/reviews/review-1/analyze/status") {
        requeued = true;
        return Response.json({
          ok: true,
          data: {
            job: {
              id: "job-1",
              reviewId: "review-1",
              mode: "content_only",
              status: "succeeded",
              progressStage: "saving_result",
              message: null,
              detail: null,
              createdAt: "2026-08-22T06:00:00.000Z",
              finishedAt: "2026-08-22T06:00:30.000Z",
            },
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<BatchReviewPage />);

    expect(await screen.findByRole("heading", { name: "张小明" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "不合适" }));
    await user.type(screen.getByRole("textbox", { name: "结构问题 / 共性问题（仅同名作文）" }), "补充细节");
    await user.click(screen.getByRole("button", { name: "提交后台修改并继续" }));

    // 延迟 60ms 返回的 review-queue 响应不会被 effect cleanup 丢弃，张小明重新回到左侧队列与右侧审核面板
    expect(await screen.findByRole("heading", { name: "张小明" })).toBeVisible();
    expect(screen.getByRole("button", { name: /张小明/u })).toBeVisible();
  });

  it("待导出清单中仍有历史记录正在同步摘要（summarySyncPending）时禁用一键导出全部已复核，避免漏导", async () => {
    const readySummary = {
      id: "review-1",
      status: "ready_for_review" as const,
      studentName: "张小明",
      className: "六（1）班",
      config: { title: "作文1" },
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
    const syncingSummary = {
      ...readySummary,
      id: "review-2",
      studentName: "李待同步",
      exportEligibility: { eligible: false, reason: "历史批改摘要正在同步导出资格，请稍后刷新再导出" } as const,
      summarySyncPending: true,
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: [] });
      if (url === "/api/reviews?summary=1&scope=pending-export") {
        return Response.json({ ok: true, data: [readySummary, syncingSummary] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<BatchReviewPage />);
    await user.click(await screen.findByRole("button", { name: "已复核待导出清单 (2)" }));

    expect(screen.getByText("一键导出已复核（0）")).toBeVisible();
    const exportAllBtn = screen.getByRole("button", { name: "导出全部已复核" });
    expect(exportAllBtn).toBeDisabled();
    expect(screen.getByText("历史批改摘要正在同步导出资格，请刷新页面后再一键导出")).toBeVisible();
  });

  it("合法点击同班待导出作文的返回修改并编辑正文后，重渲染绝不覆盖草稿或清掉未保存标记，提交包含最新修订", async () => {
    const reviewedSummary = {
      id: "review-1",
      status: "ready_for_review" as const,
      studentName: "张小明",
      className: "六（1）班",
      config: { title: "作文1" },
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
    const reviewedDetail = {
      ...detail("review-1", "张小明", 1, paragraphReport),
      className: "六（1）班",
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
    };
    let submittedReportText = "";

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: [] });
      if (url === "/api/reviews?summary=1&scope=pending-export") return Response.json({ ok: true, data: [reviewedSummary] });
      if (url === "/api/reviews/review-1") return Response.json({ ok: true, data: reviewedDetail });
      if (url === "/api/reviews/review-1/teacher-review" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { report: { paragraphReviews: Array<{ revisedText: string }> } };
        submittedReportText = body.report.paragraphReviews[0]!.revisedText;
        return Response.json({
          ok: true,
          data: {
            ...reviewedDetail,
            revision: 2,
            report: body.report,
            teacherReviewedAt: "2026-08-22T06:15:00.000Z",
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<BatchReviewPage />);

    await user.selectOptions(await screen.findByLabelText("班级筛选"), "class:六（1）班");
    await user.click(screen.getByRole("button", { name: "已复核待导出清单 (1)" }));
    await user.click(screen.getByRole("button", { name: "返回修改" }));

    const editor = await screen.findByLabelText("第 1 段改后全段");
    expect(editor).toHaveValue("我走上台。");
    await user.type(editor, "留住本次修订");

    // 主动等待多轮微任务与重渲染，确认缓存旧报告不会覆盖新草稿，且未保存标记仍在
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(screen.getByLabelText("第 1 段改后全段")).toHaveValue("我走上台。留住本次修订");
    expect(screen.getByRole("toolbar", { name: "审核操作" })).toHaveTextContent("有未确认的修改");

    await user.click(screen.getByRole("button", { name: "审核通过并进入下一篇" }));
    expect(submittedReportText).toBe("我走上台。留住本次修订");
  });

  it("提交甲一保存响应返回前切换到乙班，甲一保存完成后绝不覆盖已在展示的乙一详情", async () => {
    const queue = [
      { ...queueItem("review-1", "甲一", 1), className: "六（1）班" },
      { ...queueItem("review-2", "乙一", 2), className: "六（2）班" },
    ];
    const jia1Detail = { ...detail("review-1", "甲一", 1, paragraphReport), className: "六（1）班" };
    const yi1Detail = { ...detail("review-2", "乙一", 2, paragraphReport), className: "六（2）班" };
    let resolveSaveJia1!: (response: Response) => void;

    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Promise.resolve(Response.json({ ok: true, data: queue }));
      if (isPendingExportUrl(url)) return Promise.resolve(Response.json({ ok: true, data: [] }));
      if (url === "/api/reviews/review-1") return Promise.resolve(Response.json({ ok: true, data: jia1Detail }));
      if (url === "/api/reviews/review-2") return Promise.resolve(Response.json({ ok: true, data: yi1Detail }));
      if (url === "/api/reviews/review-1/teacher-review" && init?.method === "POST") {
        return new Promise<Response>((resolve) => { resolveSaveJia1 = resolve; });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<BatchReviewPage />);

    expect(await screen.findByRole("heading", { name: "甲一" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "审核通过并进入下一篇" }));

    // 甲一保存请求尚未返回前，教师切换班级筛选至乙班，乙一立即显示
    await user.selectOptions(screen.getByLabelText("班级筛选"), "class:六（2）班");
    expect(await screen.findByRole("heading", { name: "乙一" })).toBeVisible();

    // 甲一保存完成返回，绝不能把右侧已显示的乙一打成“当前作文详情尚未加载成功”
    await act(async () => {
      resolveSaveJia1(Response.json({
        ok: true,
        data: { ...jia1Detail, revision: 2, teacherReviewedAt: "2026-08-22T06:20:00.000Z" },
      }));
    });

    expect(screen.getByRole("heading", { name: "乙一" })).toBeVisible();
    expect(screen.queryByText("当前作文详情尚未加载成功")).not.toBeInTheDocument();
    expect(screen.getByLabelText("第 1 段改后全段")).toHaveValue("我走上台。");
    expect(screen.getByRole("button", { name: "审核通过并进入下一篇" })).toBeEnabled();
  });

  it("首次返回修改详情慢响应未结束时切回待导出清单再次点击返回修改，强制中断旧请求并发起第 2 次最新 GET，过时响应不覆盖新结果", async () => {
    const reviewedSummary = {
      id: "review-1",
      status: "ready_for_review" as const,
      studentName: "张小明",
      className: "六（1）班",
      config: { title: "作文1" },
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
    const staleFirstDetail = {
      ...detail("review-1", "张小明", 1, {
        ...paragraphReport,
        paragraphReviews: [{ ...paragraphReport.paragraphReviews[0]!, revisedText: "过时的第一次响应正文。" }],
      }),
      className: "六（1）班",
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
    };
    const freshSecondDetail = {
      ...detail("review-1", "张小明", 1, {
        ...paragraphReport,
        paragraphReviews: [{ ...paragraphReport.paragraphReviews[0]!, revisedText: "第二次重新核验的最新正文。" }],
      }),
      className: "六（1）班",
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
    };

    let detailGetCount = 0;
    let firstSignal: AbortSignal | null | undefined;
    let resolveFirstGet!: (response: Response) => void;
    let resolveSecondGet!: (response: Response) => void;

    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Promise.resolve(Response.json({ ok: true, data: [] }));
      if (url === "/api/reviews?summary=1&scope=pending-export") {
        return Promise.resolve(Response.json({ ok: true, data: [reviewedSummary] }));
      }
      if (url === "/api/reviews/review-1") {
        detailGetCount += 1;
        if (detailGetCount === 1) {
          firstSignal = init?.signal;
          return new Promise<Response>((resolve) => { resolveFirstGet = resolve; });
        }
        return new Promise<Response>((resolve) => { resolveSecondGet = resolve; });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<BatchReviewPage />);

    // 第一次点击「返回修改」，GET #1 挂起在途
    await user.click(await screen.findByRole("button", { name: "已复核待导出清单 (1)" }));
    await user.click(screen.getByRole("button", { name: "返回修改" }));
    expect(detailGetCount).toBe(1);

    // 切回「已复核待导出清单」再次点击同一篇「返回修改」：必须中断 GET #1 并真正发出第 2 次 GET
    await user.click(screen.getByRole("button", { name: "已复核待导出清单 (1)" }));
    await user.click(screen.getByRole("button", { name: "返回修改" }));
    expect(detailGetCount).toBe(2);
    expect(firstSignal?.aborted).toBe(true);

    // 即便旧响应与新响应先后返回，页面也只采纳第 2 次请求的新结果
    await act(async () => {
      resolveFirstGet(Response.json({ ok: true, data: staleFirstDetail }));
      resolveSecondGet(Response.json({ ok: true, data: freshSecondDetail }));
    });

    expect(await screen.findByLabelText("第 1 段改后全段")).toHaveValue("第二次重新核验的最新正文。");
  });

  it("另一标签页已完成当前作文审核时，自动切到下一位学生并同步刷新已复核待导出清单，一键导出不漏篇", async () => {
    const initialQueue = [
      { ...queueItem("review-1", "张小明", 1), className: "六（1）班" },
      { ...queueItem("review-2", "李安然", 2), className: "六（1）班" },
    ];
    // 另一标签页已将 review-1 审核通过（teacherReviewedAt 非空，进入 pending-export 清单）
    const externallyApprovedDetail = {
      ...detail("review-1", "张小明", 2, paragraphReport),
      className: "六（1）班",
      teacherReviewedAt: "2026-08-22T06:10:00.000Z",
    };
    const externallyApprovedSummary = {
      id: "review-1",
      status: "ready_for_review" as const,
      studentName: "张小明",
      className: "六（1）班",
      config: { title: "作文1" },
      revision: 2,
      createdAt: "2026-08-22T01:00:00.000Z",
      updatedAt: "2026-08-22T06:10:00.000Z",
      teacherReviewedAt: "2026-08-22T06:10:00.000Z",
      hasReport: true,
      isLegacyReport: false,
      grade: "A-",
      hasPdf: false,
      pdfFilename: null,
      exportEligibility: { eligible: true } as const,
    };
    const secondDetail = { ...detail("review-2", "李安然", 2, paragraphReport), className: "六（1）班" };
    let queueCalls = 0;
    let pendingCalls = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") {
        queueCalls += 1;
        return Response.json({ ok: true, data: queueCalls === 1 ? initialQueue : [initialQueue[1]!] });
      }
      if (url === "/api/reviews?summary=1&scope=pending-export") {
        pendingCalls += 1;
        return Response.json({ ok: true, data: pendingCalls === 1 ? [] : [externallyApprovedSummary] });
      }
      if (url === "/api/reviews/review-1") return Response.json({ ok: true, data: externallyApprovedDetail });
      if (url === "/api/reviews/review-2") return Response.json({ ok: true, data: secondDetail });
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<BatchReviewPage />);

    // 自动切到下一位学生李安然，同时顶部已复核待导出清单计数已从 0 更新为 1
    expect(await screen.findByRole("heading", { name: "李安然" })).toBeVisible();
    const exportTabBtn = await screen.findByRole("button", { name: "已复核待导出清单 (1)" });
    await user.click(exportTabBtn);

    expect(screen.getByRole("heading", { name: "张小明" })).toBeVisible();
    expect(screen.getByText("一键导出已复核（1）")).toBeVisible();
  });

  it("本页已打开第 2 篇后另一标签页将其审完，直接切待导出清单并一键导出时先拉取最新集合（包含两篇），刷新失败则绝不下载旧集合", async () => {
    const queue = [{ ...queueItem("review-2", "李安然", 2), className: "六（1）班" }];
    const secondDetail = { ...detail("review-2", "李安然", 2, paragraphReport), className: "六（1）班" };
    const summary1 = {
      id: "review-1",
      status: "ready_for_review" as const,
      studentName: "张小明",
      className: "六（1）班",
      config: { title: "作文1" },
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
    const summary2 = {
      ...summary1,
      id: "review-2",
      studentName: "李安然",
      config: { title: "作文2" },
      revision: 3,
      teacherReviewedAt: "2026-08-22T06:05:00.000Z",
    };

    let otherTabApprovedSecond = false;
    let failNextPendingRefresh = false;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: queue });
      if (url === "/api/reviews/review-2") return Response.json({ ok: true, data: secondDetail });
      if (url === "/api/reviews?summary=1&scope=pending-export") {
        if (failNextPendingRefresh) {
          return Response.json({ ok: false, error: { message: "待导出集合刷新失败" } }, { status: 500 });
        }
        return Response.json({
          ok: true,
          data: otherTabApprovedSecond ? [summary1, summary2] : [summary1],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<BatchReviewPage />);

    // 1) 本页先打开并显示第 2 篇（此时本页缓存的 reviewed 只有 review-1）
    expect(await screen.findByRole("heading", { name: "李安然" })).toBeVisible();
    expect(screen.getByRole("button", { name: "已复核待导出清单 (1)" })).toBeVisible();

    // 2) 切到待导出清单后，另一标签页审完第 2 篇；先验证一键导出前若刷新失败，绝不下载旧集合 ["review-1"]
    await user.click(screen.getByRole("button", { name: "已复核待导出清单 (1)" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导出全部已复核" })).toBeEnabled());
    otherTabApprovedSecond = true;
    failNextPendingRefresh = true;

    await user.click(screen.getByRole("button", { name: "导出全部已复核" }));
    await user.click(screen.getByRole("menuitem", { name: "PDF" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("待导出集合刷新失败");
    expect(reviewExports.batch).not.toHaveBeenCalled();

    // 3) 网络恢复后点击一键导出：必须先拿到最新集合 ["review-1", "review-2"] 再下载，绝不漏掉 review-2
    failNextPendingRefresh = false;
    await user.click(screen.getByRole("button", { name: "导出全部已复核" }));
    await user.click(screen.getByRole("menuitem", { name: "PDF" }));

    await waitFor(() => expect(reviewExports.batch).toHaveBeenCalledWith(["review-1", "review-2"], "pdf"));
  });

  it("待导出清单多次刷新响应乱序到达时，导出完成后的新空列表 (0) 绝不被较早发出的迟到响应盖回 (1)", async () => {
    const queue = [queueItem("review-2", "李安然", 2)];
    const pendingDetail = detail("review-2", "李安然", 2, paragraphReport);
    const summary1 = {
      id: "review-1",
      status: "ready_for_review" as const,
      studentName: "张小明",
      className: "六（1）班",
      config: { title: "作文1" },
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

    let pendingExportCalls = 0;
    let resolveDelayedTabRefresh!: (response: Response) => void;
    let resolveArchiveDownload!: (filename: string) => void;

    reviewExports.batch.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolveArchiveDownload = resolve;
    }));

    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Promise.resolve(Response.json({ ok: true, data: queue }));
      if (url === "/api/reviews/review-2") return Promise.resolve(Response.json({ ok: true, data: pendingDetail }));
      if (url === "/api/reviews?summary=1&scope=pending-export") {
        pendingExportCalls += 1;
        // 第 1 次（挂载）、第 2 次（首次打开清单）、第 3 次（导出前核验）正常返回 [summary1]
        if (pendingExportCalls <= 3) {
          return Promise.resolve(Response.json({ ok: true, data: [summary1] }));
        }
        // 第 4 次（打包下载期间点击清单标签页发出的较早请求，读取到旧快照 [summary1]，但网络延迟后到）
        if (pendingExportCalls === 4) {
          return new Promise<Response>((resolve) => {
            resolveDelayedTabRefresh = resolve;
          });
        }
        // 第 5 次（导出完成后的最新刷新，返回已清空的 []）
        return Promise.resolve(Response.json({ ok: true, data: [] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const user = userEvent.setup();
    render(<BatchReviewPage />);

    await user.click(await screen.findByRole("button", { name: "已复核待导出清单 (1)" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "导出全部已复核" })).toBeEnabled());

    // 启动一键导出（第 3 次请求核验通过后进入 downloadReviewArchive 等待）
    await user.click(screen.getByRole("button", { name: "导出全部已复核" }));
    await user.click(screen.getByRole("menuitem", { name: "PDF" }));
    await waitFor(() => expect(reviewExports.batch).toHaveBeenCalledWith(["review-1"], "pdf"));

    // 导出尚未完成时点击顶部清单标签触发第 4 次请求（慢响应），随后导出完成触发第 5 次请求并立即返回 []
    await user.click(screen.getByRole("button", { name: "已复核待导出清单 (1)" }));
    await act(async () => {
      resolveArchiveDownload("批量导出.zip");
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "已复核待导出清单 (0)" })).toBeVisible());
    expect(screen.getByText("还没有已复核待导出作文")).toBeVisible();

    // 此时较早发出的第 4 次请求迟到返回旧的 [summary1]：必须被序号门禁丢弃，计数绝不跳回 (1)
    await act(async () => {
      resolveDelayedTabRefresh(Response.json({ ok: true, data: [summary1] }));
    });
    expect(screen.getByRole("button", { name: "已复核待导出清单 (0)" })).toBeVisible();
    expect(screen.getByText("还没有已复核待导出作文")).toBeVisible();
  });

  it("一键导出已复核与导出所选在导出前核验暂停期间若清单已被刷新为 (0)，释放迟到的旧 [A] 响应时均立即中止，归档调用严格为 0 次", async () => {
    const queue = [queueItem("review-2", "李安然", 2)];
    const pendingDetail = detail("review-2", "李安然", 2, paragraphReport);
    const summaryA = {
      id: "review-a",
      status: "ready_for_review" as const,
      studentName: "张小明",
      className: "六（1）班",
      config: { title: "作文A" },
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

    // 分别覆盖「导出全部已复核」与「导出所选作文」两个独立入口
    for (const mode of ["all", "selected"] as const) {
      let pendingCalls = 0;
      let resolveStalePreExportCheck!: (response: Response) => void;

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = String(input);
        if (url === "/api/reviews/review-queue") return Promise.resolve(Response.json({ ok: true, data: queue }));
        if (url === "/api/reviews/review-2") return Promise.resolve(Response.json({ ok: true, data: pendingDetail }));
        if (url === "/api/reviews?summary=1&scope=pending-export") {
          pendingCalls += 1;
          // 第 1 次（挂载）、第 2 次（进入待导出清单）返回 [summaryA]
          if (pendingCalls <= 2) {
            return Promise.resolve(Response.json({ ok: true, data: [summaryA] }));
          }
          // 第 3 次（导出前核验请求）：挂起模拟慢响应
          if (pendingCalls === 3) {
            return new Promise<Response>((resolve) => {
              resolveStalePreExportCheck = resolve;
            });
          }
          // 第 4 次（点击清单标签页重新刷新）：已变为空清单 []
          return Promise.resolve(Response.json({ ok: true, data: [] }));
        }
        throw new Error(`Unexpected request: ${url}`);
      });

      const user = userEvent.setup();
      const view = render(<BatchReviewPage />);

      await user.click(await screen.findByRole("button", { name: "已复核待导出清单 (1)" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "导出全部已复核" })).toBeEnabled());

      if (mode === "selected") {
        await user.click(screen.getByRole("checkbox", { name: "选择张小明的作文导出" }));
        await user.click(screen.getByRole("button", { name: "导出所选作文" }));
      } else {
        await user.click(screen.getByRole("button", { name: "导出全部已复核" }));
      }
      await user.click(screen.getByRole("menuitem", { name: "PDF" }));
      await waitFor(() => expect(pendingCalls).toBe(3));

      // 导出前核验尚未返回时刷新清单，界面明确显示 (0)
      await user.click(screen.getByRole("button", { name: "已复核待导出清单 (1)" }));
      await waitFor(() => expect(screen.getByRole("button", { name: "已复核待导出清单 (0)" })).toBeVisible());

      // 释放迟到的旧 [summaryA] 核验响应：必须因序号过期立即中止，归档函数调用严格为 0 次
      await act(async () => {
        resolveStalePreExportCheck(Response.json({ ok: true, data: [summaryA] }));
      });
      expect(reviewExports.batch).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "已复核待导出清单 (0)" })).toBeVisible();

      view.unmount();
      fetchSpy.mockRestore();
    }
  });
});
