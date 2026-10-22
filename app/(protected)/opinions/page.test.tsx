import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

import GradingOpinionsPage from "./page";

const standing = {
  id: "opinion-1",
  text: "严格五段",
  scope: "standing",
  paragraphLabel: null,
  category: "结构",
  sourceStudentName: "小明",
  sourceClassName: "六1班",
  sourceTitle: "我终于明白了",
  createdAt: "2026-10-22T02:15:00.000Z",
  updatedAt: "2026-10-22T02:15:00.000Z",
};

const essay = {
  ...standing,
  id: "opinion-essay",
  text: "写具体心理",
  scope: "essay",
  category: "内容",
  sourceStudentName: "小红",
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }));
}

describe("长期批改规则页", () => {
  afterEach(() => vi.restoreAllMocks());

  it("只编辑长期规则，两类统计分开", async () => {
    const updated = { ...standing, text: "开头点题", category: "结构", updatedAt: "2026-10-22T03:00:00.000Z" };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => jsonResponse({ ok: true, data: [standing, essay] }))
      .mockImplementationOnce(() => jsonResponse({ ok: true, data: updated }))
      .mockImplementationOnce(() => jsonResponse({ ok: true, data: { deleted: true } }));
    const user = userEvent.setup();
    render(<GradingOpinionsPage />);

    expect(await screen.findByRole("heading", { name: "长期批改规则" })).toBeInTheDocument();
    const standingStats = screen.getByRole("region", { name: "长期规则统计" });
    const essayStats = screen.getByRole("region", { name: "仅当前文章统计" });
    expect(standingStats).toHaveTextContent("共 1 条");
    expect(standingStats).toHaveTextContent("结构 1 次");
    expect(essayStats).toHaveTextContent("共 1 条");
    expect(essayStats).toHaveTextContent("内容 1 次");
    expect(screen.queryByRole("textbox", { name: "编辑小红 · 六1班 · 我终于明白了的长期规则" })).not.toBeInTheDocument();

    const field = screen.getByRole("textbox", { name: "编辑小明 · 六1班 · 我终于明白了的长期规则" });
    expect(field).toHaveValue("严格五段");
    await user.clear(field);
    await user.type(field, "开头点题");
    await user.click(screen.getByRole("button", { name: "保存修改" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ text: "开头点题", category: "结构" }),
    });
    expect(field).toHaveValue("开头点题");

    await user.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "编辑小明 · 六1班 · 我终于明白了的长期规则" })).not.toBeInTheDocument());
    expect(screen.getByText("还没有长期批改规则。")).toBeInTheDocument();
    expect(essayStats).toHaveTextContent("共 1 条");
  });

  it("相同长期规则按次数统计", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => jsonResponse({
      ok: true,
      data: [standing, { ...standing, id: "opinion-2", sourceStudentName: "小刚" }],
    }));
    render(<GradingOpinionsPage />);

    const stats = await screen.findByRole("region", { name: "长期规则统计" });
    expect(stats).toHaveTextContent("共 2 条");
    expect(stats).toHaveTextContent("相同内容「严格五段」2 次");
    expect(screen.getByRole("region", { name: "仅当前文章统计" })).toHaveTextContent("共 0 条");
  });
});