import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import NewReviewPage from "./page";

async function confirmPrivacy(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText("确认真实作文上传说明"));
}

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

    expect(screen.getByRole("button", { name: /为自己鼓掌/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "自定义题目" }));
    expect(screen.getByRole("button", { name: "自定义题目" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "下一步：上传作文" }));

    expect(screen.getByRole("alert")).toHaveTextContent("请填写作文题目");
    expect(screen.getByLabelText("目标字数")).toHaveValue(600);
  });

  it("自定义题目可用 AI 先生成写作、结构与评分要求，且保留可编辑性", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => json([])).mockImplementationOnce(() => json({
      writingRequirements: "选择一件真实小事，写清变化。",
      structureRequirements: "开头设置情境，中间展开经过，结尾回扣题目。",
      scoringFocus: "事件具体，细节真实，感受自然。",
    }));
    const user = userEvent.setup();
    render(<NewReviewPage />);

    await user.click(screen.getByRole("button", { name: "自定义题目" }));
    await user.type(screen.getByLabelText("作文题目"), "我学会了等待");
    await user.click(screen.getByRole("button", { name: "AI 生成要求" }));

    expect(await screen.findByDisplayValue("选择一件真实小事，写清变化。")).toBeInTheDocument();
    expect(screen.getByDisplayValue("开头设置情境，中间展开经过，结尾回扣题目。")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("写作要求"));
    await user.type(screen.getByLabelText("写作要求"), "教师手动调整后的要求。");
    expect(screen.getByDisplayValue("教师手动调整后的要求。")).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/assignment-guidance", expect.objectContaining({ method: "POST" }));
  });

  it("在提交前必须确认真实作文上传说明", async () => {
    const user = userEvent.setup();
    render(<NewReviewPage />);

    await user.click(screen.getByRole("button", { name: /为自己鼓掌/ }));
    await user.click(screen.getByRole("button", { name: "下一步：上传作文" }));
    await user.upload(
      screen.getByLabelText("选择作文图片"),
      new File(["image"], "composition.jpg", { type: "image/jpeg" }),
    );
    await user.click(screen.getByRole("button", { name: "下一步：确认提交" }));

    expect(screen.getByText(/请勿在图片中保留学生姓名、学号、班级、学校/)).toBeInTheDocument();
    expect(screen.getByText(/30 天/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建并开始批改" })).toBeDisabled();
    await confirmPrivacy(user);
    expect(screen.getByRole("button", { name: "创建并开始批改" })).toBeEnabled();
  });

  it("填写学生姓名后按调整后的四图顺序上传，并提交旋转和裁剪", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([]))
      .mockImplementationOnce(() => json({ id: "review-new", revision: 0 }, 201))
      .mockImplementationOnce(() =>
        json({ images: [
          { id: 11, position: 0 },
          { id: 12, position: 1 },
          { id: 13, position: 2 },
          { id: 14, position: 3 },
        ], revision: 1 }),
      )
      .mockImplementationOnce(() => json({ images: [], revision: 2 }));
    const user = userEvent.setup();
    render(<NewReviewPage />);

    await user.click(screen.getByRole("button", { name: /为自己鼓掌/ }));
    await user.click(screen.getByRole("button", { name: "下一步：上传作文" }));
    await user.type(screen.getByLabelText("学生姓名"), "李羿辰");
    const files = ["一.jpg", "二.jpg", "三.jpg", "四.jpg"].map(
      (name) => new File([name], name, { type: "image/jpeg" }),
    );
    await user.upload(screen.getByLabelText("选择作文图片"), files);
    expect(screen.getByText("4/4 张")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "上移 三.jpg" }));
    await user.click(screen.getByRole("button", { name: "旋转 二.jpg" }));
    await user.clear(screen.getByLabelText("二.jpg 裁剪左边界（%）"));
    await user.type(screen.getByLabelText("二.jpg 裁剪左边界（%）"), "10");
    await user.click(screen.getByRole("button", { name: "下一步：确认提交" }));
    await confirmPrivacy(user);
    const summary = screen.getByLabelText("图片提交顺序");
    expect(within(summary).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("一.jpg"),
      expect.stringContaining("三.jpg"),
      expect.stringContaining("二.jpg"),
      expect.stringContaining("四.jpg"),
    ]);
    expect(screen.getByText("李羿辰")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "创建并开始批改" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/reviews?id=review-new"));
    const reviewRequest = fetchMock.mock.calls[1];
    expect(reviewRequest[0]).toBe("/api/reviews");
    expect(JSON.parse((reviewRequest[1] as RequestInit).body as string)).toMatchObject({
      studentName: "李羿辰",
      config: { title: "为自己鼓掌" },
    });
    const uploaded = (fetchMock.mock.calls[2][1] as RequestInit).body as FormData;
    expect(uploaded.get("expectedRevision")).toBe("0");
    expect(uploaded.get("privacyConfirmed")).toBe("true");
    expect(uploaded.get("privacyNoticeVersion")).toBe("2026-07-22");
    expect(uploaded.getAll("images").map((file) => (file as File).name)).toEqual([
      "一.jpg",
      "三.jpg",
      "二.jpg",
      "四.jpg",
    ]);
    expect(JSON.parse(String(uploaded.get("imageMeta")))).toHaveLength(4);
  });

  it("上传失败后改题重试会先 PATCH 最新配置，再上传图片", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([]))
      .mockImplementationOnce(() => json({ id: "review-retry", revision: 0 }, 201))
      .mockImplementationOnce(() => json({ code: "UPLOAD_FAILED", message: "上传失败" }, 502))
      .mockImplementationOnce(() => json({ id: "review-retry", revision: 1 }))
      .mockImplementationOnce(() => json({ images: [{ id: 31, position: 0 }], revision: 2 }))
      .mockImplementationOnce(() => json({ images: [], revision: 3 }));
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
    await confirmPrivacy(user);
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
      expectedRevision: 0,
      config: { title: "修订后的题目" },
    });
  });

  it("转换后的图片上传成功后直接进入批改详情", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([]))
      .mockImplementationOnce(() => json({ id: "review-versioned", revision: 0 }, 201))
      .mockImplementationOnce(() => json({ images: [{ id: 41, position: 0 }], revision: 1 }));
    const user = userEvent.setup();
    render(<NewReviewPage />);

    await user.click(screen.getByRole("button", { name: /为自己鼓掌/ }));
    await user.click(screen.getByRole("button", { name: "下一步：上传作文" }));
    await user.upload(
      screen.getByLabelText("选择作文图片"),
      new File(["image"], "versioned.jpg", { type: "image/jpeg" }),
    );
    await user.click(screen.getByRole("button", { name: "下一步：确认提交" }));
    await confirmPrivacy(user);
    await user.click(screen.getByRole("button", { name: "创建并开始批改" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/reviews?id=review-versioned"));
  });
});
