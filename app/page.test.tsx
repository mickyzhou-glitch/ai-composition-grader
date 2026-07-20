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
  afterEach(() => vi.restoreAllMocks());

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
});
