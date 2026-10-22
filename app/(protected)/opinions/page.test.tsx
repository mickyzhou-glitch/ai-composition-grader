import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

import GradingOpinionsPage from "./page";

const opinion = {
  id: "opinion-1",
  body: "为什么不合适：开头太空\n应该怎么改：用一句名言开头",
  sourceReviewId: "review-1",
  sourceStudentName: "小明",
  sourceClassName: "六1班",
  sourceTitle: "我终于明白了",
  createdAt: "2026-10-22T02:15:00.000Z",
  updatedAt: "2026-10-22T02:15:00.000Z",
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

describe("批改意见存档页", () => {
  afterEach(() => vi.restoreAllMocks());

  it("列出意见的来源，并可以编辑和删除", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => jsonResponse({ ok: true, data: [opinion] }))
      .mockImplementationOnce(() => jsonResponse({
        ok: true,
        data: { ...opinion, body: "改为五段，欲扬先抑", updatedAt: "2026-10-22T03:00:00.000Z" },
      }))
      .mockImplementationOnce(() => jsonResponse({ ok: true, data: { deleted: true } }));
    const user = userEvent.setup();
    render(<GradingOpinionsPage />);

    expect(await screen.findByRole("heading", { name: "批改意见存档" })).toBeInTheDocument();
    expect(screen.getByText(/小明 · 六1班 · 我终于明白了/)).toBeInTheDocument();
    const field = screen.getByRole("textbox", { name: "编辑小明 · 六1班 · 我终于明白了的批改意见" });
    expect(field).toHaveValue(opinion.body);

    await user.clear(field);
    await user.type(field, "改为五段，欲扬先抑");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/grading-opinions/opinion-1");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ body: "改为五段，欲扬先抑" }),
    });
    expect(field).toHaveValue("改为五段，欲扬先抑");

    await user.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "编辑小明 · 六1班 · 我终于明白了的批改意见" })).not.toBeInTheDocument());
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "DELETE" });
    expect(screen.getByText("还没有存档的批改意见。")).toBeInTheDocument();
  });
});
