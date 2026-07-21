import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import Home from "./page";

const review = {
  id: "review-1",
  status: "ready_for_review",
  config: { title: "为自己鼓掌" },
  report: { scores: { total: 36, level: "优秀作文" } },
  createdAt: "2026-07-20T08:00:00.000Z",
  updatedAt: "2026-07-20T08:00:00.000Z",
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

  it("加载历史、统计状态并确认删除", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([review]))
      .mockImplementationOnce(() => json({ deleted: true }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();

    render(<Home />);

    expect(await screen.findByRole("heading", { name: "为自己鼓掌" })).toBeInTheDocument();
    expect(screen.getByText("待复核", { selector: "dt" })).toBeInTheDocument();
    expect(screen.getByText("36 分 · 优秀作文")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "删除《为自己鼓掌》" }));

    await waitFor(() => expect(screen.queryByText("36 分 · 优秀作文")).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenLastCalledWith("/api/reviews/review-1", { method: "DELETE" });
  });

  it("没有记录时显示直接新建的空状态", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => json([]));
    render(<Home />);

    expect(await screen.findByText("还没有作文批改记录")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "新建作文批改" })[0]).toHaveAttribute("href", "/new");
  });

  it("重新导出调用真实 PDF API，下载后刷新为可下载状态", async () => {
    const refreshed = {
      ...review,
      status: "exported",
      hasPdf: true,
      pdfFilename: "作文批改-为自己鼓掌.pdf",
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => json([review]))
      .mockImplementationOnce(() => Promise.resolve(new Response("%PDF", {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="composition-review.pdf"; filename*=UTF-8''${encodeURIComponent(refreshed.pdfFilename)}`,
        },
      })))
      .mockImplementationOnce(() => json([refreshed]));
    const clickDownload = mockBrowserDownload();
    const user = userEvent.setup();
    render(<Home />);

    await user.click(await screen.findByRole("button", { name: "重新导出" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/reviews/review-1/pdf");
    expect(clickDownload).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: "下载 PDF" })).toBeEnabled();
  });
});
