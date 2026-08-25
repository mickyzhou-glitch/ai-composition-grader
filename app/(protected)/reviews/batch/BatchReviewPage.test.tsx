import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const pdfDownloads = vi.hoisted(() => ({
  batch: vi.fn().mockResolvedValue("作文批改批量导出.zip"),
}));

vi.mock("../../../lib/pdf-download", () => ({
  downloadReviewPdfArchive: pdfDownloads.batch,
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

function detail(id: string, studentName: string, revision: number, currentReport = report) {
  return {
    id, studentName, revision, status: "ready_for_review", teacherReviewedAt: null,
    config: { title: `作文${id.at(-1)}`, grade: "六年级", writingRequirements: "叙事", targetCharacters: 600, structureRequirements: "完整", scoringFocus: "细节", templateType: "custom" },
    report: currentReport, createdAt: "2026-08-22T01:00:00.000Z", updatedAt: "2026-08-22T01:00:00.000Z",
    images: [{ id: revision, position: 0, originalName: "作文.jpg", mimeType: "image/jpeg", width: 1200, height: 1600, rotation: 0, crop: null }],
    annotations: [], ocr: { ocrRevision: 1, editedAt: null, pages: [{ pageIndex: 0, text: `${studentName}的作文原文`, readable: true, warnings: [] }] }, reportStale: false, hasPdf: false, pdfFilename: null,
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
  queue: ReturnType<typeof queueItem>[],
  options: { rejectTeacherReview?: boolean; currentReport?: typeof report } = {},
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
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
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

    const name = await screen.findByRole("textbox", { name: "学生姓名" });
    await user.type(name, "同学");
    await user.click(screen.getByRole("button", { name: "不合适" }));

    expect(confirm).toHaveBeenCalledWith("当前修改尚未审核保存，确认切换作文？");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "张小明同学" })).toBeVisible();
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

    const name = await screen.findByRole("textbox", { name: "学生姓名" });
    await user.clear(name);
    await user.type(name, "张小明（六班）");
    await user.click(screen.getByRole("button", { name: "审核通过并进入下一篇" }));

    expect(await screen.findByText("保存失败，请重试")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "学生姓名" })).toHaveValue("张小明（六班）");
    expect(screen.getByRole("heading", { name: "张小明（六班）" })).toBeVisible();
  });

  it("asks for confirmation before switching away from unsaved edits", async () => {
    mockReviewApi([
      queueItem("review-1", "张小明", 1),
      queueItem("review-2", "李安然", 2),
    ]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    const name = await screen.findByRole("textbox", { name: "学生姓名" });
    await user.type(name, "同学");
    await user.click(screen.getByRole("button", { name: /李安然/u }));

    expect(confirm).toHaveBeenCalledWith("当前修改尚未审核保存，确认切换作文？");
    expect(screen.getByRole("heading", { name: "张小明同学" })).toBeVisible();
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
    expect(screen.getByText("当前为 3 段，题目要求 5 段，请先使用 AI 全文重新生成。")).toBeVisible();
    expect(screen.getByRole("button", { name: "审核通过并进入下一篇" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "前往单篇复核" })).toHaveAttribute(
      "href",
      "/reviews?id=review-1",
    );
  });

  it("重新进入页面时从历史接口恢复已复核待导出清单", async () => {
    const queue = [queueItem("review-2", "李安然", 2)];
    const reviewed = { ...detail("review-1", "张小明", 1), teacherReviewedAt: "2026-08-22T06:00:00.000Z" };
    const pending = detail("review-2", "李安然", 2);
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
    const reviewed = { ...detail("review-1", "张小明", 1), teacherReviewedAt: "2026-08-22T06:00:00.000Z" };
    const pending = detail("review-2", "李安然", 2);
    let exported = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/reviews/review-queue") return Response.json({ ok: true, data: queue });
      if (url === "/api/reviews") return Response.json({ ok: true, data: [exported ? { ...reviewed, status: "exported" } : reviewed, pending] });
      if (url === "/api/reviews/review-2") return Response.json({ ok: true, data: pending });
      throw new Error(`Unexpected request: ${url}`);
    });
    pdfDownloads.batch.mockImplementationOnce(async () => {
      exported = true;
      return "作文批改批量导出.zip";
    });
    const user = userEvent.setup();
    render(<BatchReviewPage />);

    await user.click(await screen.findByRole("button", { name: "已复核待导出清单 (1)" }));
    await user.click(screen.getByRole("button", { name: "一键导出已复核（1）" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "已复核待导出清单 (0)" })).toBeVisible());
    expect(screen.getByText("还没有已复核待导出作文")).toBeVisible();
    expect(pdfDownloads.batch).toHaveBeenCalledWith(["review-1"]);
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/reviews").length).toBe(2);
  });
});
