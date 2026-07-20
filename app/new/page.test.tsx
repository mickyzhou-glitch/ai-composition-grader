import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import NewReviewPage from "./page";

function json(data: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(status < 400 ? { ok: true, data } : { ok: false, error: data }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("新建作文批改", () => {
  beforeEach(() => {
    push.mockReset();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn((file: File) => `blob:${file.name}`),
      revokeObjectURL: vi.fn(),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("支持内置题目与自定义字段验证", async () => {
    const user = userEvent.setup();
    render(<NewReviewPage />);

    expect(screen.getByRole("button", { name: /为自己鼓掌/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "自定义题目" }));
    await user.click(screen.getByRole("button", { name: "下一步：上传作文" }));

    expect(screen.getByRole("alert")).toHaveTextContent("请填写作文题目");
    expect(screen.getByLabelText("目标字数")).toHaveValue(600);
  });

  it("按调整后的三图顺序上传，并提交旋转和裁剪", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json({ id: "review-new" }, 201))
      .mockImplementationOnce(() =>
        json({ images: [
          { id: 11, position: 0 },
          { id: 12, position: 1 },
          { id: 13, position: 2 },
        ] }),
      )
      .mockImplementationOnce(() => json({ images: [] }));
    const user = userEvent.setup();
    render(<NewReviewPage />);

    await user.click(screen.getByRole("button", { name: /为自己鼓掌/ }));
    await user.click(screen.getByRole("button", { name: "下一步：上传作文" }));
    const files = ["一.jpg", "二.jpg", "三.jpg"].map(
      (name) => new File([name], name, { type: "image/jpeg" }),
    );
    await user.upload(screen.getByLabelText("选择作文图片"), files);
    await user.click(screen.getByRole("button", { name: "上移 三.jpg" }));
    await user.click(screen.getByRole("button", { name: "旋转 二.jpg" }));
    await user.clear(screen.getByLabelText("二.jpg 裁剪左边界（%）"));
    await user.type(screen.getByLabelText("二.jpg 裁剪左边界（%）"), "10");
    await user.click(screen.getByRole("button", { name: "下一步：确认提交" }));
    const summary = screen.getByLabelText("图片提交顺序");
    expect(within(summary).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("一.jpg"),
      expect.stringContaining("三.jpg"),
      expect.stringContaining("二.jpg"),
    ]);
    await user.click(screen.getByRole("button", { name: "创建并开始批改" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/reviews/review-new"));
    const reviewRequest = fetchMock.mock.calls[0];
    expect(reviewRequest[0]).toBe("/api/reviews");
    expect(JSON.parse((reviewRequest[1] as RequestInit).body as string).config.title).toBe("为自己鼓掌");
    const uploaded = (fetchMock.mock.calls[1][1] as RequestInit).body as FormData;
    expect(uploaded.getAll("images").map((file) => (file as File).name)).toEqual([
      "一.jpg",
      "三.jpg",
      "二.jpg",
    ]);
    const transforms = JSON.parse((fetchMock.mock.calls[2][1] as RequestInit).body as string);
    expect(transforms.images[2]).toMatchObject({ id: 13, position: 2, rotation: 90 });
    expect(transforms.images[2].crop.x).toBe(0.1);
  });

  it("上传失败后改题重试会先 PATCH 最新配置，再上传图片", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json({ id: "review-retry" }, 201))
      .mockImplementationOnce(() => json({ code: "UPLOAD_FAILED", message: "上传失败" }, 502))
      .mockImplementationOnce(() => json({ id: "review-retry" }))
      .mockImplementationOnce(() => json({ images: [{ id: 31, position: 0 }] }))
      .mockImplementationOnce(() => json({ images: [] }));
    const user = userEvent.setup();
    render(<NewReviewPage />);

    await user.click(screen.getByRole("button", { name: "自定义题目" }));
    await user.type(screen.getByLabelText("作文题目"), "第一次题目");
    await user.type(screen.getByLabelText("写作要求"), "写一件具体的事。");
    await user.type(screen.getByLabelText("结构要求"), "开头点题，结尾升华。");
    await user.type(screen.getByLabelText("评分侧重"), "细节描写。");
    await user.click(screen.getByRole("button", { name: "下一步：上传作文" }));
    await user.upload(
      screen.getByLabelText("选择作文图片"),
      new File(["image"], "first.jpg", { type: "image/jpeg" }),
    );
    await user.click(screen.getByRole("button", { name: "下一步：确认提交" }));
    await user.click(screen.getByRole("button", { name: "创建并开始批改" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("上传失败");

    await user.click(screen.getByRole("button", { name: "上一步" }));
    await user.click(screen.getByRole("button", { name: "上一步" }));
    await user.clear(screen.getByLabelText("作文题目"));
    await user.type(screen.getByLabelText("作文题目"), "修订后的题目");
    await user.click(screen.getByRole("button", { name: "下一步：上传作文" }));
    await user.click(screen.getByRole("button", { name: "下一步：确认提交" }));
    await user.click(screen.getByRole("button", { name: "创建并开始批改" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/reviews/review-retry",
      expect.objectContaining({ method: "PATCH" }),
    ));
    const configRequest = fetchMock.mock.calls.find(([url, init]) =>
      url === "/api/reviews/review-retry" && (init as RequestInit).method === "PATCH",
    );
    expect(JSON.parse((configRequest?.[1] as RequestInit).body as string)).toMatchObject({
      config: { title: "修订后的题目" },
    });
  });
});
