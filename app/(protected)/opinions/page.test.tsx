import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

import GradingOpinionsPage from "./page";

const opinion = {
  id: "opinion-1",
  reason: "开头太空",
  changeRequest: "用一句名言开头",
  paragraphLabel: "第1段",
  category: "结构",
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

  it("列出两项文字和统计，并可以编辑和删除", async () => {
    const updated = {
      ...opinion,
      reason: "开头没有画面",
      changeRequest: "先写一个动作",
      category: "内容",
      updatedAt: "2026-10-22T03:00:00.000Z",
    };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => jsonResponse({ ok: true, data: [opinion] }))
      .mockImplementationOnce(() => jsonResponse({ ok: true, data: updated }))
      .mockImplementationOnce(() => jsonResponse({ ok: true, data: { deleted: true } }));
    const user = userEvent.setup();
    render(<GradingOpinionsPage />);

    expect(await screen.findByRole("heading", { name: "批改意见存档" })).toBeInTheDocument();
    expect(screen.getByText(/提交后台修改并继续/)).toBeInTheDocument();
    expect(screen.getByText(/小明 · 六1班 · 我终于明白了/)).toBeInTheDocument();
    expect(screen.getByText(/第1段/)).toBeInTheDocument();
    const stats = screen.getByRole("region", { name: "批改意见统计" });
    expect(stats).toHaveTextContent("共 1 条");
    expect(stats).toHaveTextContent("结构 1 次");

    const reason = screen.getByRole("textbox", { name: "编辑小明 · 六1班 · 我终于明白了的为什么不合适" });
    const changeRequest = screen.getByRole("textbox", { name: "编辑小明 · 六1班 · 我终于明白了的应该怎么改" });
    expect(reason).toHaveValue(opinion.reason);
    expect(changeRequest).toHaveValue(opinion.changeRequest);

    await user.clear(reason);
    await user.type(reason, "开头没有画面");
    await user.clear(changeRequest);
    await user.type(changeRequest, "先写一个动作");
    await user.selectOptions(screen.getByRole("combobox", { name: "编辑小明 · 六1班 · 我终于明白了的类别" }), "内容");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/grading-opinions/opinion-1");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({
        reason: "开头没有画面",
        changeRequest: "先写一个动作",
        category: "内容",
      }),
    });
    expect(reason).toHaveValue("开头没有画面");
    expect(changeRequest).toHaveValue("先写一个动作");
    expect(stats).toHaveTextContent("内容 1 次");

    await user.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "编辑小明 · 六1班 · 我终于明白了的为什么不合适" })).not.toBeInTheDocument());
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "DELETE" });
    expect(screen.getByText("还没有存档的批改意见。")).toBeInTheDocument();
  });

  it("按相同改法统计次数", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => jsonResponse({
      ok: true,
      data: [
        opinion,
        {
          ...opinion,
          id: "opinion-2",
          sourceStudentName: "小红",
          paragraphLabel: null,
        },
      ],
    }));
    render(<GradingOpinionsPage />);

    const stats = await screen.findByRole("region", { name: "批改意见统计" });
    expect(stats).toHaveTextContent("共 2 条");
    expect(stats).toHaveTextContent("结构 2 次");
    expect(stats).toHaveTextContent("相同改法「用一句名言开头」2 次");
  });
});
