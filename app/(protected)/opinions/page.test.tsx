import { render, screen, waitFor, within } from "@testing-library/react";
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
      .mockImplementationOnce(() => jsonResponse({ ok: true, data: [] }))
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

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ text: "开头点题", category: "结构" }),
    });
    expect(field).toHaveValue("开头点题");

    await user.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "编辑小明 · 六1班 · 我终于明白了的长期规则" })).not.toBeInTheDocument());
    expect(screen.getByText("还没有长期批改规则。")).toBeInTheDocument();
    expect(essayStats).toHaveTextContent("共 1 条");
  });

  it("待审批候选规则显示归纳规则和来源意见，通过后写入长期规则，驳回则移除", async () => {
    const candidates = [
      { id: "cand-1", title: "这件事打动了我", ruleText: "第三段要写出被打动的细节。", category: "结构", sources: [{ text: "第三段细节不够", studentName: "小明" }, { text: "第三段要具体", studentName: "小红" }], createdAt: "2026-10-22T03:00:00.000Z" },
      { id: "cand-2", title: "这件事打动了我", ruleText: "结尾点题。", category: "结构", sources: [{ text: "结尾没点题" }], createdAt: "2026-10-22T03:00:00.000Z" },
    ];
    const approvedRule = { ...standing, id: "op-new", text: "第三段要写出被打动的细节。", sourceTitle: "这件事打动了我" };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => jsonResponse({ ok: true, data: [] }))
      .mockImplementationOnce(() => jsonResponse({ ok: true, data: candidates }))
      .mockImplementationOnce(() => jsonResponse({ ok: true, data: { id: "cand-1", status: "approved" } }))
      .mockImplementationOnce(() => jsonResponse({ ok: true, data: [approvedRule] }))
      .mockImplementationOnce(() => jsonResponse({ ok: true, data: { id: "cand-2", status: "rejected" } }));
    const user = userEvent.setup();
    render(<GradingOpinionsPage />);
    const first = await screen.findByRole("article", { name: "候选规则：第三段要写出被打动的细节。" });
    expect(first).toHaveTextContent("第三段细节不够（小明）");
    expect(first).toHaveTextContent("来源意见（2 条）");
    await user.click(within(first).getByRole("button", { name: "通过" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: /的长期规则$/u })).toHaveValue("第三段要写出被打动的细节。"));
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe("/api/rule-candidates/cand-1/approve");
    const second = screen.getByRole("article", { name: "候选规则：结尾点题。" });
    await user.click(within(second).getByRole("button", { name: "驳回" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "待审批的候选规则" })).not.toBeInTheDocument());
    expect(String(fetchMock.mock.calls[4]?.[0])).toBe("/api/rule-candidates/cand-2/reject");
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