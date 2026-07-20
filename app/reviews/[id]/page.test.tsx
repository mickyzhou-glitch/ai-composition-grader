import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "review-1" }) }));

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
};

function json(data: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(status < 400 ? { ok: true, data } : { ok: false, error: data }), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

describe("复核页", () => {
  afterEach(() => vi.restoreAllMocks());

  it("保存时 PATCH 完整 report 与 annotations", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json(review))
      .mockImplementationOnce(() => json(review));
    const user = userEvent.setup();
    render(<ReviewPage />);

    await user.clear(await screen.findByLabelText("个性评语"));
    await user.type(screen.getByLabelText("个性评语"), "观察细致，继续保持");
    await user.click(screen.getByRole("button", { name: "保存复核" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const request = fetchMock.mock.calls[1];
    expect(request[0]).toBe("/api/reviews/review-1");
    expect(JSON.parse((request[1] as RequestInit).body as string)).toMatchObject({
      report: { personalizedComment: "观察细致，继续保持" }, annotations: [],
    });
    expect(screen.getByAltText("第 1 页作文")).toHaveAttribute(
      "src",
      "/api/reviews/review-1/files?imageId=1&variant=annotation",
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
    vi.spyOn(window, "setInterval").mockImplementation((callback) => {
      intervals.push(callback as () => void);
      return intervals.length as never;
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
      .mockImplementationOnce(() => json({ images: [{ id: 8, position: 0, originalName: "重拍.jpg", mimeType: "image/jpeg", width: 100, height: 120, rotation: 0, crop: null }] }));
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
    expect(await screen.findByRole("status")).toHaveTextContent("作文图片已替换");
  });
});
