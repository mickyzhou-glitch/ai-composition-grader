import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

import Home from "./page";

const review = {
  id: "review-1",
  status: "ready_for_review",
  studentName: "张小明",
  config: { title: "为自己鼓掌" },
  report: { scores: { total: 36, level: "优秀作文" } },
  createdAt: "2026-07-20T08:00:00.000Z",
  updatedAt: "2026-07-20T08:00:00.000Z",
  expiresAt: "2026-08-19T08:00:00.000Z",
  hasPdf: false,
  pdfFilename: null,
};

function json(data: unknown, ok = true) {
  return Promise.resolve(
    new Response(JSON.stringify(ok ? { ok: true, data } : { ok: false, error: data }), {
      status: ok ? 200 : 500,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("历史首页", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  function mockPrintWindow() {
    return vi.spyOn(window, "open").mockReturnValue({} as Window);
  }

  it("加载历史、统计状态并确认删除", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([review]))
      .mockImplementationOnce(() => json({ deleted: true }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();

    render(<Home />);

    expect(await screen.findByRole("heading", { name: "为自己鼓掌" })).toBeInTheDocument();
    expect(screen.getByText("学生：张小明")).toBeInTheDocument();
    expect(screen.getByText("待复核", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText("A- · 已完成四维诊断")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "删除《为自己鼓掌》" }));

    expect(window.confirm).toHaveBeenCalledWith("确认永久删除《为自己鼓掌》？删除后不可恢复。");
    await waitFor(() => expect(screen.queryByText("A- · 已完成四维诊断")).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenLastCalledWith("/api/reviews/review-1", { method: "DELETE" });
  });

  it("历史显示上传后的自动永久删除日期", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => json([review]));
    render(<Home />);

    expect(await screen.findByText(/自动永久删除（剩余/)).toBeInTheDocument();
  });

  it("没有记录时显示直接新建的空状态", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => json([]));
    render(<Home />);

    expect(await screen.findByText("还没有作文批改记录")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "新建作文批改" })[0]).toHaveAttribute("href", "/new");
  });

  it("打开浏览器打印页以另存 PDF", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([review]))
      .mockImplementationOnce(() => json([review]));
    const open = mockPrintWindow();
    const user = userEvent.setup();
    render(<Home />);

    await user.click(await screen.findByRole("button", { name: "打印 / 另存 PDF" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(open).toHaveBeenCalledWith("/print/reviews?id=review-1", "_blank", "noopener");
  });

  it("可选择多篇批改记录并分别打开打印页", async () => {
    const secondReview = {
      ...review,
      id: "review-2",
      studentName: "李羿辰",
      config: { title: "珍贵的礼物" },
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([review, secondReview]))
      .mockImplementationOnce(() => json([review, secondReview]));
    const open = mockPrintWindow();
    const user = userEvent.setup();
    render(<Home />);

    await user.click(await screen.findByRole("checkbox", { name: "选择《为自己鼓掌》" }));
    await user.click(screen.getByRole("checkbox", { name: "选择《珍贵的礼物》" }));
    await user.click(screen.getByRole("button", { name: "导出所选 2 篇 PDF" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(open).toHaveBeenNthCalledWith(1, "/print/reviews?id=review-1", "_blank", "noopener");
    expect(open).toHaveBeenNthCalledWith(2, "/print/reviews?id=review-2", "_blank", "noopener");
  });
});
