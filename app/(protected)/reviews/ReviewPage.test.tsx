import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

import ReviewPage from "./ReviewPage";

const review = {
  id: "review-1",
  status: "ready_for_review",
  revision: 1,
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
  },
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
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  function mockPrintWindow() {
    return vi.spyOn(window, "open").mockReturnValue({} as Window);
  }

  it("复核与导出入口持续显示自动删除期限", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }));
    render(<ReviewPage />);

    expect(await screen.findByRole("note")).toHaveTextContent("导出 PDF 不会延长保存期限");
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

  it("有未保存修改时禁止导出并提示先保存", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }));
    const user = userEvent.setup();
    render(<ReviewPage />);

    const exportButton = await screen.findByRole("button", { name: "导出 PDF" });
    expect(exportButton).toBeEnabled();
    await user.clear(screen.getByLabelText("优点一"));
    await user.type(screen.getByLabelText("优点一"), "未保存修改");

    expect(exportButton).toBeDisabled();
    expect(exportButton).toHaveAttribute("title", "请先保存复核修改再导出");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("导出时打开浏览器打印页", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }))
      .mockImplementationOnce(() => json(review));
    const open = mockPrintWindow();
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.click(await screen.findByRole("button", { name: "导出 PDF" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(open).toHaveBeenCalledWith("/print/reviews?id=review-1", "_blank", "noopener");
  });

  it("浏览器拦截打印窗口时显示错误", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ job: null }));
    vi.spyOn(window, "open").mockReturnValue(null);
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.click(await screen.findByRole("button", { name: "导出 PDF" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "浏览器拦截了打印窗口，请允许弹窗后重试",
    );
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

    expect(await screen.findByText("AI 分析：生成批改")).toBeInTheDocument();
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
    expect(await screen.findByRole("status")).toHaveTextContent("作文图片已替换");
  });
});
