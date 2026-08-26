import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  reviewId: "review-1",
  router: { replace: vi.fn(), refresh: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: navigation.reviewId }),
  useRouter: () => navigation.router,
}));

const pdfDownloads = vi.hoisted(() => ({
  single: vi.fn().mockResolvedValue("为自己鼓掌-张小明.pdf"),
}));
const browserWindow: Window = window;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");

vi.mock("../../lib/pdf-download", () => ({
  downloadReviewPdf: pdfDownloads.single,
}));

import ReviewPage from "./ReviewPage";

const parentFeedbacks = [
  { style: "warm" as const, title: "亲切详细", content: "家长您好，孩子这次作文选材真实，第三段可以补清事情的起因。" },
  { style: "professional" as const, title: "专业清晰", content: "家长您好，本次作文选材切题；建议第三段补足冲突起因。" },
  { style: "concise" as const, title: "简短微信版", content: "家长您好，作文选材真实，第三段再补清事情起因。" },
];

const review = {
  id: "review-1",
  status: "ready_for_review",
  revision: 1,
  teacherReviewedAt: null,
  studentName: "",
  config: { title: "为自己鼓掌", templateType: "custom" },
  images: [{ id: 1, position: 0, originalName: "作文.jpg", mimeType: "image/jpeg", width: 100, height: 100, rotation: 0, crop: null }],
  annotations: [],
  report: {
    themeFit: "fits",
    themeReason: "切题",
    personalizedComment: "真诚",
    painPoints: ["结尾快"], commonIssues: ["句式单一"], revisionSuggestions: ["补感受"],
    scores: { themeIntent: 8, contentSelection: 8, structure: 7, languageExpression: 7, writingConventions: 3, total: 33, level: "二类作文" },
    sampleParagraphs: [{ title: "示范段", text: "示范正文", suggestion: "修改建议" }],
    parentFeedbacks,
  },
  ocr: {
    ocrRevision: 1,
    editedAt: null,
    pages: [{ pageIndex: 0, text: "我为自己鼓掌。", readable: true, warnings: [] }],
  },
  reportStale: false,
  hasPdf: false,
  pdfFilename: null,
  expiresAt: "2026-08-19T08:00:00.000Z",
};

function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(status < 400 ? { ok: true, data } : { ok: false, error: data }), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("复核页", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    if (originalClipboard) {
      Object.defineProperty(navigator, "clipboard", originalClipboard);
    } else {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("复核与导出入口显示长期保留说明", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }));
    render(<ReviewPage />);

    expect(await screen.findByRole("note")).toHaveTextContent("作文图片与批改文件会长期保留，老师可在历史记录中手动永久删除");
    expect(screen.queryByText(/30 天|到期|自动永久删除/u)).not.toBeInTheDocument();
  });

  it("已完成教师复核的详情显示已复核标记", async () => {
    const reviewed = { ...review, teacherReviewedAt: "2026-08-22T06:00:00.000Z" };
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(reviewed))
      .mockImplementationOnce(() => json({ job: null }));
    render(<ReviewPage />);

    expect(await screen.findByText("已复核", { selector: ".status-badge" })).toBeInTheDocument();
    expect(screen.queryByText("待复核", { selector: ".status-badge" })).not.toBeInTheDocument();
  });

  it("在状态提示之后、作文复核工作区之前展示三份家长反馈", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }));
    render(<ReviewPage />);

    const panel = await screen.findByRole("region", { name: "给家长的反馈" });
    const retentionNote = screen.getByRole("note");
    const workspace = screen.getByRole("region", { name: "作文复核工作区" });

    expect(retentionNote.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("tab", { name: "亲切详细" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("tab", { name: /亲切详细|专业清晰|简短微信版/ })).toHaveLength(3);
  });

  it("修改反馈后可保存完整 report，保存结果成为新的恢复基线", async () => {
    const savedContent = "修改后的家长反馈";
    const savedReview = {
      ...review,
      revision: 2,
      report: {
        ...review.report,
        parentFeedbacks: [
          { ...parentFeedbacks[0], content: savedContent },
          parentFeedbacks[1],
          parentFeedbacks[2],
        ],
      },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => json(savedReview));
    const user = userEvent.setup();
    render(<ReviewPage />);

    const editor = await screen.findByLabelText("亲切详细家长反馈");
    await user.clear(editor);
    await user.type(editor, savedContent);
    expect(screen.getByRole("button", { name: "保存复核" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "保存复核" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string)).toMatchObject({
      report: {
        parentFeedbacks: [
          { style: "warm", title: "亲切详细", content: savedContent },
          parentFeedbacks[1],
          parentFeedbacks[2],
        ],
      },
    });

    await user.clear(editor);
    await user.type(editor, "保存后的第二次修改");
    await user.click(screen.getByRole("button", { name: "恢复原文" }));
    expect(editor).toHaveValue(savedContent);
  });

  it("复制家长反馈成功时显示页面提示", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }));
    render(<ReviewPage />);

    await user.click(await screen.findByRole("button", { name: "复制反馈" }));

    expect(writeText).toHaveBeenCalledWith(parentFeedbacks[0].content);
    expect(await screen.findByRole("status")).toHaveTextContent("家长反馈已复制");
  });

  it("复制家长反馈失败时显示手动复制说明", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }));
    render(<ReviewPage />);

    await user.click(await screen.findByRole("button", { name: "复制反馈" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("无法自动复制，请选中文本后手动复制。");
  });

  it("分析排队或运行时锁定家长反馈编辑和操作", async () => {
    const queuedJob = {
      id: "job-1", reviewId: "review-1", status: "queued", progressStage: "queued",
      message: null, createdAt: new Date().toISOString(), finishedAt: null,
    };
    vi.spyOn(window, "setInterval").mockImplementation(() => 1 as never);
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: queuedJob }));
    render(<ReviewPage />);

    expect(await screen.findByLabelText("亲切详细家长反馈")).toBeDisabled();
    expect(screen.getByRole("button", { name: "恢复原文" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "复制反馈" })).toBeDisabled();
  });

  it("旧报告显示家长反馈空状态且保留原复核编辑器", async () => {
    const legacyReview = {
      ...review,
      report: { ...review.report, parentFeedbacks: undefined },
    };
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(legacyReview))
      .mockImplementationOnce(() => json({ job: null }));
    render(<ReviewPage />);

    expect(await screen.findByText("暂无家长反馈，请重新分析作文后生成。")).toBeInTheDocument();
    expect(screen.getByLabelText("优点一")).toHaveValue("真诚");
  });

  it("重新分析时把老师观点一并提交", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => json({ id: "job-1", status: "queued", progressStage: "queued", message: null }));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.type(await screen.findByLabelText("老师补充观点"), "请重点看结尾是否扣题");
    await user.click(screen.getByRole("button", { name: "重新分析" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string)).toEqual({
      teacherGuidance: "请重点看结尾是否扣题",
    });
  });

  it("识别原文保存后保留旧报告并提示重新生成", async () => {
    const staleReview = {
      ...review,
      ocr: { ...review.ocr, ocrRevision: 2, pages: [{ ...review.ocr.pages[0], text: "老师修正后的作文。" }] },
      reportStale: true,
    };
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => json(staleReview));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.click(await screen.findByRole("tab", { name: "识别原文" }));
    const editor = screen.getByRole("textbox", { name: "第 1 页识别原文" });
    await user.clear(editor);
    await user.type(editor, "老师修正后的作文。");
    await user.click(screen.getByRole("button", { name: "保存识别原文" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("批改报告基于旧版识别原文");
    await user.click(screen.getByRole("tab", { name: "批改报告" }));
    expect(screen.getByLabelText("优点一")).toHaveValue("真诚");
  });

  it("从过期提示重新生成时只提交 content_only，失败仍保留旧报告", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json({ ...review, reportStale: true }))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => json({ code: "AI_REQUEST_FAILED", message: "内容模型暂时不可用" }, 502));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.click(await screen.findByRole("button", { name: "重新生成批改" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string)).toEqual({
      mode: "content_only",
    });
    expect(await screen.findByText("内容模型暂时不可用")).toBeInTheDocument();
    expect(screen.getByLabelText("优点一")).toHaveValue("真诚");
  });

  it("保存时 PATCH 完整 report 与 annotations", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => json({ ...review, revision: 7 }))
      .mockImplementationOnce(() => json({ ...review, revision: 8 }));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.clear(await screen.findByLabelText("优点一"));
    await user.type(screen.getByLabelText("优点一"), "观察细致，继续保持");
    await user.click(screen.getByRole("button", { name: "保存复核" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const request = fetchMock.mock.calls[2];
    expect(request[0]).toBe("/api/reviews/review-1");
    expect(JSON.parse((request[1] as RequestInit).body as string)).toMatchObject({
      expectedRevision: 1,
      report: { personalizedComment: "观察细致，继续保持" }, annotations: [],
    });
    expect(screen.getByAltText("第 1 页作文")).toHaveAttribute(
      "src",
      "/api/reviews/review-1/files?imageId=1&variant=annotation",
    );

    await user.clear(screen.getByLabelText("优点一"));
    await user.type(screen.getByLabelText("优点一"), "第二次保存");
    await user.click(screen.getByRole("button", { name: "保存复核" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(JSON.parse((fetchMock.mock.calls[3][1] as RequestInit).body as string)).toMatchObject({
      expectedRevision: 7,
    });
  });

  it("保存前指出具体的空白报告字段，不发送无效 PATCH", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.clear(await screen.findByLabelText("主题判断依据"));
    await user.click(screen.getByRole("button", { name: "保存复核" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("主题判断依据不能为空");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("结构诊断为空时使用通用结构要求文案", async () => {
    const currentReview = {
      ...review,
      report: {
        ...review.report,
        scores: undefined,
        grade: "B" as const,
        diagnostics: {
          authenticityAndRelevance: { finding: "事件真实。", action: "保留真实细节。" },
          materialAndDetails: { finding: "细节具体。", action: "继续写清动作。" },
          structure: { finding: "结构完整。", action: "保持段落顺序。" },
          language: { finding: "表达通顺。", action: "精简重复句。" },
        },
      },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(currentReview))
      .mockImplementationOnce(() => json({ job: null }));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.clear(await screen.findByLabelText("前后逻辑与结构精准定位"));
    await user.click(screen.getByRole("button", { name: "保存复核" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("结构要求的精准定位不能为空");
    expect(screen.queryByText(/五段结构/u)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("保存被 Worker 拒绝时使用安全字段路径显示具体问题", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => json({
        code: "VALIDATION_ERROR",
        message: "请求参数无效",
        details: { path: ["report", "sampleParagraphs", 0, "text"] },
      }, 400));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.type(await screen.findByRole("textbox", { name: "学生姓名" }), "小明");
    await user.click(screen.getByRole("button", { name: "保存复核" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("示范文第 1 段的示范正文不能为空");
  });

  it("支持填写并保存学生姓名", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => json({
        ...review,
        revision: 2,
        studentName: "张小明",
      }));
    const user = userEvent.setup();
    render(<ReviewPage />);

    const input = await screen.findByRole("textbox", { name: "学生姓名" });
    await user.type(input, "张小明");
    await user.click(screen.getByRole("button", { name: "保存复核" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string)).toMatchObject({
      expectedRevision: 1,
      studentName: "张小明",
    });
    expect(input).toHaveValue("张小明");
  });

  it("保存进行时禁用保存、分析和替换，避免同页写入重叠", async () => {
    const saved = deferred<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => saved.promise);
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.clear(await screen.findByLabelText("优点一"));
    await user.type(screen.getByLabelText("优点一"), "待保存内容");
    await user.click(screen.getByRole("button", { name: "保存复核" }));

    expect(screen.getByRole("button", { name: "保存中…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新分析" })).toBeDisabled();
    expect(screen.getByLabelText("替换/重拍作文图片")).toBeDisabled();

    saved.resolve(await json({ ...review, revision: 2 }));
  });

  it("有未保存修改时点击导出会保存当前内容并下载", async () => {
    const reviewed = {
      ...review,
      revision: 2,
      teacherReviewedAt: "2026-08-23T08:00:00.000Z",
      report: { ...review.report, personalizedComment: "导出时保存的修改" },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => json(reviewed))
      .mockImplementationOnce(() => json({ ...reviewed, status: "exported" }));
    const user = userEvent.setup();
    render(<ReviewPage />);

    const exportButton = await screen.findByRole("button", { name: "导出 PDF" });
    await user.clear(screen.getByLabelText("优点一"));
    await user.type(screen.getByLabelText("优点一"), "导出时保存的修改");

    expect(exportButton).toBeEnabled();
    await user.click(exportButton);

    await waitFor(() => expect(pdfDownloads.single).toHaveBeenCalledWith("review-1"));
    expect(fetchMock.mock.calls[2][0]).toBe("/api/reviews/review-1/teacher-review");
    expect(JSON.parse(String((fetchMock.mock.calls[2][1] as RequestInit).body))).toMatchObject({
      expectedRevision: 1,
      report: { personalizedComment: "导出时保存的修改" },
    });
  });

  it("未复核记录点击导出时先保存为教师已复核再下载", async () => {
    const reviewed = {
      ...review,
      revision: 2,
      teacherReviewedAt: "2026-08-23T08:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => json(reviewed))
      .mockImplementationOnce(() => json({ ...reviewed, status: "exported" }));
    const open = vi.spyOn(window, "open");
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
    expect(pdfDownloads.single).toHaveBeenCalledWith("review-1");
    expect(open).not.toHaveBeenCalled();
  });

  it("已复核且没有修改时直接下载，不重复提交教师复核", async () => {
    const reviewed = {
      ...review,
      teacherReviewedAt: "2026-08-23T08:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(reviewed))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => json({ ...reviewed, status: "exported" }));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.click(await screen.findByRole("button", { name: "导出 PDF" }));

    await waitFor(() => expect(pdfDownloads.single).toHaveBeenCalledWith("review-1"));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/teacher-review"))).toBe(false);
  });

  it("导出前教师复核保存失败时保留当前修改且不下载", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => json({ message: "保存失败，请重试" }, 500));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.clear(await screen.findByLabelText("优点一"));
    await user.type(screen.getByLabelText("优点一"), "需要保留的修改");
    await user.click(screen.getByRole("button", { name: "导出 PDF" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("保存失败，请重试"));
    expect(pdfDownloads.single).not.toHaveBeenCalled();
    expect(screen.getByLabelText("优点一")).toHaveValue("需要保留的修改");
    expect(screen.getByRole("button", { name: "导出 PDF" })).toBeEnabled();
  });

  it("替换图片控件使用 file-label 显示键盘焦点", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }));

    render(<ReviewPage />);

    const fileInput = await screen.findByLabelText("替换/重拍作文图片");
    expect(fileInput.closest("label")).toHaveClass("file-label");
  });

  it("有未保存修改时重新分析先确认，取消后不发请求", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.clear(await screen.findByLabelText("优点一"));
    await user.type(screen.getByLabelText("优点一"), "本地未保存内容");
    await user.click(screen.getByRole("button", { name: "重新分析" }));

    expect(confirm).toHaveBeenCalledWith("当前复核内容尚未保存，重新分析会覆盖这些修改。确定继续吗？");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("优点一")).toHaveValue("本地未保存内容");
  });

  it("冲突不会覆盖脏的本地草稿，链接离开仍会确认", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => json({ code: "ANALYSIS_CONFLICT", message: "冲突" }, 409))
      .mockImplementationOnce(() => json({
        ...review,
        report: { ...review.report, personalizedComment: "服务端内容" },
      }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.clear(await screen.findByLabelText("优点一"));
    await user.type(screen.getByLabelText("优点一"), "本地草稿");
    await user.click(screen.getByRole("button", { name: "保存复核" }));
    await screen.findByRole("alert");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText("优点一")).toHaveValue("本地草稿");
    fireEvent.click(screen.getByRole("link", { name: "新建作文批改" }));
    expect(confirm).toHaveBeenCalledWith("复核内容尚未保存，确定离开吗？");
  });

  it("替换图片前确认脏草稿，取消后不上传也不清空本地内容", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.clear(await screen.findByLabelText("优点一"));
    await user.type(screen.getByLabelText("优点一"), "替换前本地草稿");
    await user.upload(
      screen.getByLabelText("替换/重拍作文图片"),
      new File(["image"], "replacement.jpg", { type: "image/jpeg" }),
    );

    expect(confirm).toHaveBeenCalledWith("当前复核内容尚未保存，替换图片会清空这些修改。确定继续吗？");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("优点一")).toHaveValue("替换前本地草稿");
  });

  it("保存 409 提供确认后的放弃本地修改并刷新动作", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => json({ code: "ANALYSIS_CONFLICT", message: "冲突" }, 409))
      .mockImplementationOnce(() => json({
        ...review,
        report: { ...review.report, personalizedComment: "服务端最新内容" },
      }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.clear(await screen.findByLabelText("优点一"));
    await user.type(screen.getByLabelText("优点一"), "会被放弃的本地草稿");
    await user.click(screen.getByRole("button", { name: "保存复核" }));
    const abandon = screen.queryByRole("button", { name: "放弃本地修改并刷新" });
    expect(abandon).toBeInTheDocument();
    if (!abandon) return;
    await user.click(abandon);

    expect(confirm).toHaveBeenCalledWith("将放弃当前未保存的复核修改并加载服务器最新内容，确定继续吗？");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(screen.getByLabelText("优点一")).toHaveValue("服务端最新内容");
  });

  it("提交分析后立即显示任务进度并锁定复核操作", async () => {
    const queuedJob = {
      id: "job-1", reviewId: "review-1", status: "queued", progressStage: "queued",
      message: null, createdAt: new Date().toISOString(), finishedAt: null,
    };
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => json(queuedJob));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.click(await screen.findByRole("button", { name: "重新分析" }));

    expect(await screen.findByText("AI 分析：排队中")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新分析" })).toBeDisabled();
    expect(screen.getByLabelText("替换/重拍作文图片")).toBeDisabled();
  });

  it("任务状态更新后移除提交时的排队提示", async () => {
    const queuedJob = {
      id: "job-1", reviewId: "review-1", status: "queued", progressStage: "queued",
      message: null, createdAt: new Date().toISOString(), finishedAt: null,
    };
    const runningJob = {
      ...queuedJob, status: "running", progressStage: "generating_review",
    };
    const intervals: Array<() => void> = [];
    vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => {
      if (delay === 1500) intervals.push(callback as () => void);
      return (intervals.length || 1) as never;
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => json(queuedJob))
      .mockImplementationOnce(() => json({ job: runningJob }));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.click(await screen.findByRole("button", { name: "重新分析" }));
    expect(await screen.findByText("AI 分析已提交：排队中")).toBeInTheDocument();
    await waitFor(() => expect(intervals).toHaveLength(1));
    intervals[0]();

    expect(await screen.findByText("AI 分析：正在生成批改内容")).toBeInTheDocument();
    expect(screen.queryByText("AI 分析已提交：排队中")).not.toBeInTheDocument();
  });

  it("新任务提交后忽略较早发出的空任务状态响应", async () => {
    const pendingStatus = deferred<Response>();
    const queuedJob = {
      id: "job-1", reviewId: "review-1", status: "queued", progressStage: "queued",
      message: null, createdAt: new Date().toISOString(), finishedAt: null,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => pendingStatus.promise)
      .mockImplementationOnce(() => json(queuedJob));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.click(await screen.findByRole("button", { name: "重新分析" }));
    expect(await screen.findByText("AI 分析：排队中")).toBeInTheDocument();
    await act(async () => {
      pendingStatus.resolve(await json({ job: null }));
      await pendingStatus.promise;
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByText("AI 分析：排队中")).toBeInTheDocument();
  });

  it("刷新时恢复仍在排队的任务并锁定编辑与上传", async () => {
    const queuedJob = {
      id: "job-1", reviewId: "review-1", status: "queued", progressStage: "queued",
      message: null, createdAt: new Date().toISOString(), finishedAt: null,
    };
    const intervals: Array<() => void> = [];
    vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => {
      if (delay === 1500) intervals.push(callback as () => void);
      return (intervals.length || 1) as never;
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: queuedJob }));
    render(<ReviewPage />);

    expect(await screen.findByText("AI 分析：排队中")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新分析" })).toBeDisabled();
    expect(screen.getByLabelText("替换/重拍作文图片")).toBeDisabled();
    await waitFor(() => expect(intervals).toHaveLength(1));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/reviews/review-1/analyze/status");
  });

  it("初始作文读取与任务完成竞争时只刷新一次最终批改", async () => {
    const finishedJob = {
      id: "job-1", reviewId: "review-1", status: "succeeded", progressStage: "saving_result",
      message: null, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json({ ...review, status: "analyzing" as const }))
      .mockImplementationOnce(() => json({ job: finishedJob }))
      .mockImplementationOnce(() => json({
        ...review,
        revision: 2,
        report: { ...review.report, personalizedComment: "最终批改已保存" },
      }));
    render(<ReviewPage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/reviews/review-1/analyze/status");
    expect(fetchMock.mock.calls[2][0]).toBe("/api/reviews/review-1");
    expect(await screen.findByLabelText("优点一")).toHaveValue("最终批改已保存");
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("任务完成后拉取最终批改遇到短暂断线时自动重试", async () => {
    const finishedJob = {
      id: "job-1", reviewId: "review-1", status: "succeeded", progressStage: "saving_result",
      message: null, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    };
    const retryTimers: Array<() => void> = [];
    const setTimeout = browserWindow.setTimeout.bind(browserWindow);
    vi.spyOn(browserWindow, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (delay === 1500 && typeof callback === "function") {
        retryTimers.push(() => callback(...args));
        return retryTimers.length || 1;
      }
      return setTimeout(callback, delay, ...args);
    });
    vi.spyOn(window, "clearTimeout").mockImplementation(() => undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json({ ...review, status: "analyzing" as const }))
      .mockImplementationOnce(() => json({ job: finishedJob }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementationOnce(() => json({
        ...review,
        revision: 2,
        report: { ...review.report, personalizedComment: "断线恢复后的最终批改" },
      }));
    render(<ReviewPage />);

    expect(await screen.findByText("AI 分析已完成，正在加载批改结果。")).toBeInTheDocument();
    await waitFor(() => expect(retryTimers).toHaveLength(1));
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
    await act(async () => retryTimers[0]());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(await screen.findByLabelText("优点一")).toHaveValue("断线恢复后的最终批改");
    expect(screen.queryByText("AI 分析：正在保存结果")).not.toBeInTheDocument();
    expect(screen.queryByText("AI 分析已完成，正在加载批改结果。")).not.toBeInTheDocument();
  });

  it("最终批改不存在时停止自动重试并提供手动重新加载", async () => {
    const finishedJob = {
      id: "job-1", reviewId: "review-1", status: "succeeded", progressStage: "saving_result",
      message: null, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    };
    const retryTimers: Array<() => void> = [];
    const setTimeout = browserWindow.setTimeout.bind(browserWindow);
    vi.spyOn(browserWindow, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if ((delay === 1500 || delay === 3000 || delay === 6000) && typeof callback === "function") {
        retryTimers.push(() => callback(...args));
        return retryTimers.length || 1;
      }
      return setTimeout(callback, delay, ...args);
    });
    vi.spyOn(window, "clearTimeout").mockImplementation(() => undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json({ ...review, status: "analyzing" as const }))
      .mockImplementationOnce(() => json({ job: finishedJob }))
      .mockImplementationOnce(() => json({ code: "NOT_FOUND", message: "批改记录不存在" }, 404))
      .mockImplementationOnce(() => json({
        ...review,
        revision: 2,
        report: { ...review.report, personalizedComment: "手动恢复后的最终批改" },
      }));
    const user = userEvent.setup();
    render(<ReviewPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("批改结果加载失败，请重新加载。");
    expect(retryTimers).toHaveLength(0);
    expect(screen.getByRole("button", { name: "重新分析" })).toBeEnabled();
    expect(screen.queryByText("AI 分析：正在保存结果")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新加载结果" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(await screen.findByLabelText("优点一")).toHaveValue("手动恢复后的最终批改");
  });

  it("手动重新加载最终批改前保护未保存的本地修改", async () => {
    const finishedJob = {
      id: "job-1", reviewId: "review-1", status: "succeeded", progressStage: "saving_result",
      message: null, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json({ ...review, status: "analyzing" as const }))
      .mockImplementationOnce(() => json({ job: finishedJob }))
      .mockImplementationOnce(() => json({ code: "NOT_FOUND", message: "批改记录不存在" }, 404));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<ReviewPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("批改结果加载失败，请重新加载。");
    await user.clear(screen.getByLabelText("优点一"));
    await user.type(screen.getByLabelText("优点一"), "尚未保存的本地评语");
    await user.click(screen.getByRole("button", { name: "重新加载结果" }));

    expect(confirm).toHaveBeenCalledWith("将放弃当前未保存的复核修改并加载服务器最新内容，确定继续吗？");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByLabelText("优点一")).toHaveValue("尚未保存的本地评语");
  });

  it("结果加载失败后重新分析会清除旧的手动加载状态", async () => {
    const finishedJob = {
      id: "job-1", reviewId: "review-1", status: "succeeded", progressStage: "saving_result",
      message: null, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    };
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json({ ...review, status: "analyzing" as const }))
      .mockImplementationOnce(() => json({ job: finishedJob }))
      .mockImplementationOnce(() => json({ code: "NOT_FOUND", message: "批改记录不存在" }, 404))
      .mockImplementationOnce(() => json({ code: "ANALYSIS_CONFLICT", message: "冲突" }, 409));
    const user = userEvent.setup();
    render(<ReviewPage />);

    expect(await screen.findByRole("button", { name: "重新加载结果" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新分析" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("分析结果与当前内容冲突，请刷新后重试。");
    expect(screen.queryByRole("button", { name: "重新加载结果" })).not.toBeInTheDocument();
  });

  it("最终批改连续断线时按上限退避重试后解除锁定", async () => {
    const finishedJob = {
      id: "job-1", reviewId: "review-1", status: "succeeded", progressStage: "saving_result",
      message: null, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    };
    const retryTimers: Array<{ callback: () => void; delay: number }> = [];
    const setTimeout = browserWindow.setTimeout.bind(browserWindow);
    vi.spyOn(browserWindow, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if ((delay === 1500 || delay === 3000 || delay === 6000) && typeof callback === "function") {
        retryTimers.push({ callback: () => callback(...args), delay });
        return retryTimers.length || 1;
      }
      return setTimeout(callback, delay, ...args);
    });
    vi.spyOn(window, "clearTimeout").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json({ ...review, status: "analyzing" as const }))
      .mockImplementationOnce(() => json({ job: finishedJob }))
      .mockRejectedValue(new TypeError("Failed to fetch"));
    render(<ReviewPage />);

    await waitFor(() => expect(retryTimers.map(({ delay }) => delay)).toEqual([1500]));
    await act(async () => retryTimers[0].callback());
    await waitFor(() => expect(retryTimers.map(({ delay }) => delay)).toEqual([1500, 3000]));
    await act(async () => retryTimers[1].callback());
    await waitFor(() => expect(retryTimers.map(({ delay }) => delay)).toEqual([1500, 3000, 6000]));
    await act(async () => retryTimers[2].callback());

    expect(await screen.findByRole("alert")).toHaveTextContent("网络连接不稳定，批改结果暂时无法加载。");
    expect(screen.getByRole("button", { name: "重新分析" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "重新加载结果" })).toBeInTheDocument();
  });

  it("刷新后按后台任务状态轮询，并在完成时刷新批改结果", async () => {
    const runningJob = {
      id: "job-1", reviewId: "review-1", status: "running", progressStage: "generating_review",
      message: null, createdAt: new Date().toISOString(), finishedAt: null,
    };
    const doneJob = { ...runningJob, status: "succeeded", progressStage: "saving_result", finishedAt: new Date().toISOString() };
    const intervals: Array<() => void> = [];
    vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => {
      if (delay === 1500) intervals.push(callback as () => void);
      return (intervals.length || 1) as never;
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json({ ...review, status: "analyzing" as const }))
      .mockImplementationOnce(() => json({ job: runningJob }))
      .mockImplementationOnce(() => json({ job: doneJob }))
      .mockImplementationOnce(() => json({ ...review, revision: 2 }));
    render(<ReviewPage />);

    expect(await screen.findByText("AI 分析：正在生成批改内容")).toBeInTheDocument();
    await waitFor(() => expect(intervals).toHaveLength(1));
    intervals[0]();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/reviews/review-1/analyze/status");
    expect(fetchMock.mock.calls[2][0]).toBe("/api/reviews/review-1/analyze/status");
    expect(fetchMock.mock.calls[3][0]).toBe("/api/reviews/review-1");
  });

  it("卸载时中止挂起的任务状态请求且不触发状态更新警告", async () => {
    const pending = deferred<Response>();
    let signal: AbortSignal | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce((_input, init) => {
        signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
        return pending.promise;
      });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = render(<ReviewPage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    unmount();

    expect(signal?.aborted).toBe(true);
    pending.resolve(await json({ job: null }));
    await Promise.resolve();
    await Promise.resolve();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("分析遇到 409 时提示刷新后重试", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => json({ code: "ANALYSIS_CONFLICT", message: "冲突" }, 409));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.click(await screen.findByRole("button", { name: "重新分析" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("分析结果与当前内容冲突，请刷新后重试。");
  });

  it("需重拍时可直接选择 1 至 4 张图片替换作文", async () => {
    const unreadable = { ...review, status: "needs_better_images" as const, report: null };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(unreadable))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => json({ images: [{ id: 8, position: 0, originalName: "重拍.jpg", mimeType: "image/jpeg", width: 100, height: 120, rotation: 0, crop: null }], revision: 2 }));
    const user = userEvent.setup();
    render(<ReviewPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("图片暂时无法辨认");
    await user.upload(
      screen.getByLabelText("替换/重拍作文图片"),
      new File(["image"], "重拍.jpg", { type: "image/jpeg" }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2][0]).toBe("/api/reviews/review-1/images");
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: "POST" });
    expect(((fetchMock.mock.calls[2][1] as RequestInit).body as FormData).get("expectedRevision")).toBe("1");
    expect(await screen.findByRole("status")).toHaveTextContent("作文图片已压缩优化并替换，可重新开始 AI 分析。");
  });
});
