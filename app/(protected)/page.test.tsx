import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

const pdfDownloads = vi.hoisted(() => ({
  single: vi.fn().mockResolvedValue("为自己鼓掌-张小明.pdf"),
  batch: vi.fn().mockResolvedValue("作文批改批量导出.zip"),
}));

vi.mock("../lib/pdf-download", () => ({
  downloadReviewPdf: pdfDownloads.single,
  downloadReviewPdfArchive: pdfDownloads.batch,
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
    vi.clearAllMocks();
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

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

  it("历史记录长期保留并提供批量审核入口", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => json([review]));
    render(<Home />);

    expect(await screen.findByText("长期保留，可手动永久删除")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "开始批量审核" })).toHaveAttribute("href", "/reviews/batch");
    expect(screen.queryByText(/30 天|到期|自动永久删除/u)).not.toBeInTheDocument();
  });

  it("可直接按学生姓名搜索且不匹配作文题目", async () => {
    const reviews = [
      review,
      { ...review, id: "review-2", studentName: "李安然", config: { title: "张小明的礼物" } },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => json(reviews));
    const user = userEvent.setup();
    render(<Home />);

    await screen.findByText("学生：张小明");
    await user.type(screen.getByRole("searchbox", { name: "搜索学生姓名" }), "李安然");
    expect(screen.getByText("学生：李安然")).toBeVisible();
    expect(screen.queryByText("学生：张小明")).not.toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "搜索学生姓名" }));
    await user.type(screen.getByRole("searchbox", { name: "搜索学生姓名" }), "张小明");
    expect(screen.queryByText("学生：李安然")).not.toBeInTheDocument();
  });

  it("没有记录时显示直接新建的空状态", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => json([]));
    render(<Home />);

    expect(await screen.findByText("还没有作文批改记录")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "新建作文批改" })[0]).toHaveAttribute("href", "/new");
  });

  it("直接下载单篇 PDF，不打开打印页", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([review]))
      .mockImplementationOnce(() => json([review]));
    const open = vi.spyOn(window, "open");
    const user = userEvent.setup();
    render(<Home />);

    await user.click(await screen.findByRole("button", { name: "下载 PDF" }));

    await waitFor(() => expect(pdfDownloads.single).toHaveBeenCalledWith("review-1"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();
  });

  it("可选择多篇批改记录并下载一个 ZIP 压缩包", async () => {
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
    const open = vi.spyOn(window, "open");
    const user = userEvent.setup();
    render(<Home />);

    await user.click(await screen.findByRole("checkbox", { name: "选择《为自己鼓掌》" }));
    await user.click(screen.getByRole("checkbox", { name: "选择《珍贵的礼物》" }));
    await user.click(screen.getByRole("button", { name: "导出所选 2 篇（ZIP）" }));

    await waitFor(() => expect(pdfDownloads.batch).toHaveBeenCalledWith(["review-1", "review-2"]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();
  });
});
