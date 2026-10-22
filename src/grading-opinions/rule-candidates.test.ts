import { describe, expect, it, vi } from "vitest";

import {
  groupSimilarOpinions,
  isMeaningfulOpinion,
  planRuleCandidates,
  rejectionOpinionText,
} from "./rule-candidates";

describe("候选长期规则归纳", () => {
  it("过滤「无」、空内容和测试数据", () => {
    for (const text of ["", "  ", "无", "无。", "暂无", "测试", "test", "111", "测试一下", "-", "同上"]) {
      expect(isMeaningfulOpinion(text), text).toBe(false);
    }
    expect(isMeaningfulOpinion("第三段要写出被打动的细节")).toBe(true);
    expect(isMeaningfulOpinion("测试时间段的心理描写要具体，写出紧张的感受")).toBe(true);
  });

  it("合并重复和相近的意见", () => {
    const groups = groupSimilarOpinions([
      { text: "第三段要写出被打动的细节" },
      { text: "第三段要写出被打动的细节。" },
      { text: "第三段要写出让我被打动的具体细节" },
      { text: "结尾要点题" },
    ]);
    expect(groups.map((group) => group.length)).toEqual([3, 1]);
  });

  it("用 AI 归纳每组为一条规则；AI 失败时回退为组内最完整的一条", async () => {
    const opinions = [{ text: "开头太长" }, { text: "开头太长了" }, { text: "无" }, { text: "结尾要点题" }];
    const summarize = vi.fn(async () => ["开头控制在三句话内。", "结尾回扣题目。"]);
    const plan = await planRuleCandidates({ title: " 这件事打动了我 ", opinions, existing: [], summarizer: { summarize } });
    expect(summarize).toHaveBeenCalledWith({ title: "这件事打动了我", groups: [["开头太长", "开头太长了"], ["结尾要点题"]] });
    expect(plan.create.map((item) => [item.title, item.ruleText, item.sources.length])).toEqual([
      ["这件事打动了我", "开头控制在三句话内。", 2],
      ["这件事打动了我", "结尾回扣题目。", 1],
    ]);
    expect(plan.skipped).toEqual([{ text: "无", reason: "invalid" }]);

    const failed = await planRuleCandidates({ title: "t", opinions, existing: [], summarizer: { summarize: async () => { throw new Error("x"); } } });
    expect(failed.create.map((item) => item.ruleText)).toEqual(["开头太长了", "结尾要点题"]);
  });

  it("与已通过规则一字不差时不再生成候选，编辑过的按新意见；相近的待审批候选合并来源", async () => {
    const plan = await planRuleCandidates({
      title: "t",
      opinions: [{ text: "开头点题。" }, { text: "开头点题，并写清时间地点。" }, { text: "第三段写细节！" }],
      existing: [
        { id: "op-1", ruleText: "开头点题。", status: "approved", sources: [] },
        { id: "cand-1", ruleText: "第三段写细节", status: "pending", sources: [{ text: "第三段写细节" }] },
      ],
    });
    expect(plan.skipped).toEqual([{ text: "开头点题。", reason: "already_approved" }]);
    expect(plan.create.map((item) => item.ruleText)).toEqual(["开头点题，并写清时间地点。"]);
    expect(plan.merge).toEqual([{ id: "cand-1", sources: [{ text: "第三段写细节！" }] }]);
  });

  it("同一篇的同一条意见不重复计入", async () => {
    const plan = await planRuleCandidates({
      title: "t",
      opinions: [{ text: "结尾点题", reviewId: "r1" }],
      existing: [{ id: "cand-1", ruleText: "x", status: "pending", sources: [{ text: "结尾点题", reviewId: "r1" }] }],
    });
    expect(plan.skipped).toEqual([{ text: "结尾点题", reason: "duplicate_source" }]);
  });

  it("退回意见合并原因和修改要求，丢掉「无」", () => {
    expect(rejectionOpinionText("离题", "无")).toBe("离题");
    expect(rejectionOpinionText("无", "")).toBe("");
  });
});
