import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({ reviewId: "review-1" }));

vi.mock("next/navigation", () => ({ useParams: () => ({ id: navigation.reviewId }) }));

import ReviewPage from "./page";

const review = {
  id: "review-1",
  status: "ready_for_review",
  revision: 1,
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
    delete (URL as typeof URL & { createObjectURL?: unknown }).createObjectURL;
    delete (URL as typeof URL & { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  function mockBrowserDownload() {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:pdf"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    return vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  }

  it("保存时 PATCH 完整 report 与 annotations", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ ...review, revision: 7 }))
      .mockImplementationOnce(() => json({ ...review, revision: 8 }));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.clear(await screen.findByLabelText("个性评语"));
    await user.type(screen.getByLabelText("个性评语"), "观察细致，继续保持");
    await user.click(screen.getByRole("button", { name: "保存复核" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const request = fetchMock.mock.calls[1];
    expect(request[0]).toBe("/api/reviews/review-1");
    expect(JSON.parse((request[1] as RequestInit).body as string)).toMatchObject({
      expectedRevision: 1,
      report: { personalizedComment: "观察细致，继续保持" }, annotations: [],
    });
    expect(screen.getByAltText("第 1 页作文")).toHaveAttribute(
      "src",
      "/api/reviews/review-1/files?imageId=1&variant=annotation",
    );

    await user.clear(screen.getByLabelText("个性评语"));
    await user.type(screen.getByLabelText("个性评语"), "第二次保存");
    await user.click(screen.getByRole("button", { name: "保存复核" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string)).toMatchObject({
      expectedRevision: 7,
    });
  });

  it("保存进行时禁用保存、分析和替换，避免同页写入重叠", async () => {
    const saved = deferred<Response>();
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => saved.promise);
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.clear(await screen.findByLabelText("个性评语"));
    await user.type(screen.getByLabelText("个性评语"), "待保存内容");
    await user.click(screen.getByRole("button", { name: "保存复核" }));

    expect(screen.getByRole("button", { name: "保存中…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新分析" })).toBeDisabled();
    expect(screen.getByLabelText("替换/重拍作文图片")).toBeDisabled();

    saved.resolve(await json({ ...review, revision: 2 }));
  });

  it("有未保存修改时禁止导出并提示先保存", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => json(review));
    const user = userEvent.setup();
    render(<ReviewPage />);

    const exportButton = await screen.findByRole("button", { name: "导出 PDF" });
    expect(exportButton).toBeEnabled();
    await user.clear(screen.getByLabelText("个性评语"));
    await user.type(screen.getByLabelText("个性评语"), "未保存修改");

    expect(exportButton).toBeDisabled();
    expect(exportButton).toHaveAttribute("title", "请先保存复核修改再导出");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("导出期间显示 loading，下载后刷新 exported 状态", async () => {
    const pdf = deferred<Response>();
    const exported = {
      ...review,
      status: "exported" as const,
      revision: 2,
      hasPdf: true,
      pdfFilename: "作文批改-为自己鼓掌.pdf",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => pdf.promise)
      .mockImplementationOnce(() => json(exported));
    const clickDownload = mockBrowserDownload();
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.click(await screen.findByRole("button", { name: "导出 PDF" }));
    expect(screen.getByRole("button", { name: "正在生成 PDF…" })).toBeDisabled();
    pdf.resolve(new Response("%PDF", {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="composition-review.pdf"; filename*=UTF-8''${encodeURIComponent(exported.pdfFilename)}`,
      },
    }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/reviews/review-1/pdf");
    expect(clickDownload).toHaveBeenCalledOnce();
    expect(await screen.findByText("已导出")).toBeInTheDocument();
  });

  it("导出 API 错误在页面上可见", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({
        code: "PDF_ENGINE_MISSING",
        message: "PDF 引擎未安装，请运行 npx playwright install chromium 后重试",
      }, 503));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.click(await screen.findByRole("button", { name: "导出 PDF" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "PDF 引擎未安装，请运行 npx playwright install chromium 后重试",
    );
  });

  it("替换图片控件使用 file-label 显示键盘焦点", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => json(review));

    render(<ReviewPage />);

    const fileInput = await screen.findByLabelText("替换/重拍作文图片");
    expect(fileInput.closest("label")).toHaveClass("file-label");
  });

  it("有未保存修改时重新分析先确认，取消后不发请求", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => json(review));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.clear(await screen.findByLabelText("个性评语"));
    await user.type(screen.getByLabelText("个性评语"), "本地未保存内容");
    await user.click(screen.getByRole("button", { name: "重新分析" }));

    expect(confirm).toHaveBeenCalledWith("当前复核内容尚未保存，重新分析会覆盖这些修改。确定继续吗？");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("个性评语")).toHaveValue("本地未保存内容");
  });

  it("冲突不会覆盖脏的本地草稿，链接离开仍会确认", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ code: "ANALYSIS_CONFLICT", message: "冲突" }, 409))
      .mockImplementationOnce(() => json({
        ...review,
        report: { ...review.report, personalizedComment: "服务端内容" },
      }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.clear(await screen.findByLabelText("个性评语"));
    await user.type(screen.getByLabelText("个性评语"), "本地草稿");
    await user.click(screen.getByRole("button", { name: "保存复核" }));
    await screen.findByRole("alert");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("个性评语")).toHaveValue("本地草稿");
    fireEvent.click(screen.getByRole("link", { name: "新建作文批改" }));
    expect(confirm).toHaveBeenCalledWith("复核内容尚未保存，确定离开吗？");
  });

  it("替换图片前确认脏草稿，取消后不上传也不清空本地内容", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => json(review));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.clear(await screen.findByLabelText("个性评语"));
    await user.type(screen.getByLabelText("个性评语"), "替换前本地草稿");
    await user.upload(
      screen.getByLabelText("替换/重拍作文图片"),
      new File(["image"], "replacement.jpg", { type: "image/jpeg" }),
    );

    expect(confirm).toHaveBeenCalledWith("当前复核内容尚未保存，替换图片会清空这些修改。确定继续吗？");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("个性评语")).toHaveValue("替换前本地草稿");
  });

  it("保存 409 提供确认后的放弃本地修改并刷新动作", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ code: "ANALYSIS_CONFLICT", message: "冲突" }, 409))
      .mockImplementationOnce(() => json({
        ...review,
        report: { ...review.report, personalizedComment: "服务端最新内容" },
      }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.clear(await screen.findByLabelText("个性评语"));
    await user.type(screen.getByLabelText("个性评语"), "会被放弃的本地草稿");
    await user.click(screen.getByRole("button", { name: "保存复核" }));
    const abandon = screen.queryByRole("button", { name: "放弃本地修改并刷新" });
    expect(abandon).toBeInTheDocument();
    if (!abandon) return;
    await user.click(abandon);

    expect(confirm).toHaveBeenCalledWith("将放弃当前未保存的复核修改并加载服务器最新内容，确定继续吗？");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText("个性评语")).toHaveValue("服务端最新内容");
  });

  it("分析中轮询不会覆盖脏的本地草稿", async () => {
    const analyzing = { ...review, status: "analyzing" as const };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(analyzing))
      .mockImplementationOnce(() => json({
        ...review,
        report: { ...review.report, personalizedComment: "服务端轮询内容" },
      }));
    const intervals: Array<() => void> = [];
    vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => {
      if (delay === 1500) intervals.push(callback as () => void);
      return (intervals.length || 1) as never;
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.clear(await screen.findByLabelText("个性评语"));
    await user.type(screen.getByLabelText("个性评语"), "本地轮询草稿");
    intervals.at(-1)?.();

    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("个性评语")).toHaveValue("本地轮询草稿");
  });

  it("轮询发出后开始编辑时废弃在途响应", async () => {
    const pending = deferred<Response>();
    const intervals: Array<() => void> = [];
    vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => {
      if (delay === 1500) intervals.push(callback as () => void);
      return (intervals.length || 1) as never;
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json({ ...review, status: "analyzing" as const }))
      .mockImplementationOnce(() => pending.promise);
    const user = userEvent.setup();
    render(<ReviewPage />);

    await screen.findByLabelText("个性评语");
    await waitFor(() => expect(intervals).toHaveLength(1));
    intervals[0]();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await user.clear(screen.getByLabelText("个性评语"));
    await user.type(screen.getByLabelText("个性评语"), "请求发出后的本地草稿");
    await act(async () => {
      pending.resolve(await json({
        ...review,
        report: { ...review.report, personalizedComment: "迟到的服务端内容" },
      }));
    });

    expect(screen.getByLabelText("个性评语")).toHaveValue("请求发出后的本地草稿");
  });

  it("较旧轮询响应晚到时不会覆盖最新响应", async () => {
    const older = deferred<Response>();
    const latest = deferred<Response>();
    let olderSignal: AbortSignal | undefined;
    const intervals: Array<() => void> = [];
    vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => {
      if (delay === 1500) intervals.push(callback as () => void);
      return (intervals.length || 1) as never;
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json({ ...review, status: "analyzing" as const }))
      .mockImplementationOnce((_input, init) => {
        olderSignal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
        return older.promise;
      })
      .mockImplementationOnce(() => latest.promise);
    render(<ReviewPage />);

    await screen.findByLabelText("个性评语");
    await waitFor(() => expect(intervals).toHaveLength(1));
    intervals[0]();
    intervals[0]();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(olderSignal?.aborted).toBe(true);

    latest.resolve(await json({
      ...review,
      report: { ...review.report, personalizedComment: "最新轮询结果" },
    }));
    await waitFor(() => expect(screen.getByLabelText("个性评语")).toHaveValue("最新轮询结果"));

    older.resolve(await json({
      ...review,
      report: { ...review.report, personalizedComment: "过期轮询结果" },
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(screen.getByLabelText("个性评语")).toHaveValue("最新轮询结果");
  });

  it("替换图片会废弃在途轮询，防止旧图片回写", async () => {
    const pendingPoll = deferred<Response>();
    const intervals: Array<() => void> = [];
    vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => {
      if (delay === 1500) intervals.push(callback as () => void);
      return (intervals.length || 1) as never;
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json({ ...review, status: "analyzing" as const }))
      .mockImplementationOnce(() => pendingPoll.promise)
      .mockImplementationOnce(() => json({
        images: [{ ...review.images[0], id: 8, originalName: "替换.jpg" }],
        revision: 9,
      }));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await screen.findByAltText("第 1 页作文");
    await waitFor(() => expect(intervals).toHaveLength(1));
    intervals[0]();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await user.upload(
      screen.getByLabelText("替换/重拍作文图片"),
      new File(["image"], "替换.jpg", { type: "image/jpeg" }),
    );
    await waitFor(() => expect(screen.getByAltText("第 1 页作文")).toHaveAttribute(
      "src",
      "/api/reviews/review-1/files?imageId=8&variant=annotation",
    ));
    const uploadBody = (fetchMock.mock.calls[2][1] as RequestInit).body as FormData;
    expect(uploadBody.get("expectedRevision")).toBe("1");

    await act(async () => {
      pendingPoll.resolve(await json(review));
    });

    expect(screen.getByAltText("第 1 页作文")).toHaveAttribute(
      "src",
      "/api/reviews/review-1/files?imageId=8&variant=annotation",
    );
  });

  it("卸载时中止未完成请求且不触发状态更新警告", async () => {
    const pending = deferred<Response>();
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      signal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
      return pending.promise;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = render(<ReviewPage />);

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));
    unmount();

    expect(signal?.aborted).toBe(true);
    pending.resolve(await json(review));
    await Promise.resolve();
    await Promise.resolve();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("分析遇到 409 时提示刷新后重试", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json({ code: "ANALYSIS_CONFLICT", message: "冲突" }, 409));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.click(await screen.findByRole("button", { name: "重新分析" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("分析结果与当前内容冲突，请刷新后重试。");
  });

  it("需重拍时可直接选择 1 至 3 张图片替换作文", async () => {
    const unreadable = { ...review, status: "needs_better_images" as const, report: null };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(unreadable))
      .mockImplementationOnce(() => json({ images: [{ id: 8, position: 0, originalName: "重拍.jpg", mimeType: "image/jpeg", width: 100, height: 120, rotation: 0, crop: null }], revision: 2 }));
    const user = userEvent.setup();
    render(<ReviewPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("图片暂时无法辨认");
    await user.upload(
      screen.getByLabelText("替换/重拍作文图片"),
      new File(["image"], "重拍.jpg", { type: "image/jpeg" }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/reviews/review-1/images");
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST" });
    expect(((fetchMock.mock.calls[1][1] as RequestInit).body as FormData).get("expectedRevision")).toBe("1");
    expect(await screen.findByRole("status")).toHaveTextContent("作文图片已替换");
  });
});
