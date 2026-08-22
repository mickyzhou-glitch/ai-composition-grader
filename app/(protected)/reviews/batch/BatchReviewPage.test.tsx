import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  afterEach(() => vi.restoreAllMocks());

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
    expect(screen.getByRole("button", { name: "待导出清单 (1)" })).toBeVisible();
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
});
