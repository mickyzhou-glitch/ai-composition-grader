import { describe, expect, it } from "vitest";

import {
  isMeaningfulOpinion,
  originalRuleTexts,
  planRuleCandidates,
  rejectionOpinionText,
} from "./rule-candidates";

describe("候选长期规则保留原话", () => {
  it("过滤「无」、空内容和测试数据", () => {
    for (const text of ["", "  ", "无", "无。", "暂无", "测试", "test", "111", "测试一下", "-", "同上"]) {
      expect(isMeaningfulOpinion(text), text).toBe(false);
    }
    expect(isMeaningfulOpinion("第三段要写出被打动的细节")).toBe(true);
    expect(isMeaningfulOpinion("测试时间段的心理描写要具体，写出紧张的感受")).toBe(true);
  });

  it("只合并完全相同原文，相近意见和标点、换行均不改写", async () => {
    const opinions = [
      { text: "开头太长", reviewId: "r1" },
      { text: "开头太长", reviewId: "r2" },
      { text: "开头太长了" },
      { text: "开头太长。" },
      { text: "第三段写具体。\n保留  两处停顿！" },
      { text: "无" },
    ];
    const plan = await planRuleCandidates({ title: " 这件事打动了我 ", opinions, existing: [] });
    expect(plan.create.map((item) => [item.title, item.ruleText, item.sources.length])).toEqual([
      ["这件事打动了我", "开头太长", 2],
      ["这件事打动了我", "开头太长了", 1],
      ["这件事打动了我", "开头太长。", 1],
      ["这件事打动了我", "第三段写具体。\n保留  两处停顿！", 1],
    ]);
    expect(plan.skipped).toEqual([{ text: "无", reason: "invalid" }]);
  });

  it("与已通过规则完全相同时跳过，待审批只合并相同原话", async () => {
    const plan = await planRuleCandidates({
      title: "t",
      opinions: [{ text: "开头点题。" }, { text: "开头点题，并写清时间地点。" }, { text: "第三段写细节！" }, { text: "第三段写细节" }],
      existing: [
        { id: "op-1", ruleText: "开头点题。", status: "approved", sources: [] },
        { id: "cand-1", ruleText: "旧 AI 改写的第三段细节要求", status: "pending", sources: [{ text: "第三段写细节" }] },
      ],
    });
    expect(plan.skipped).toEqual([{ text: "开头点题。", reason: "already_approved" }]);
    expect(plan.create.map((item) => item.ruleText)).toEqual(["开头点题，并写清时间地点。", "第三段写细节！"]);
    expect(plan.merge).toEqual([{ id: "cand-1", sources: [{ text: "第三段写细节" }] }]);
  });

  it("同一篇的同一条意见不重复计入", async () => {
    const plan = await planRuleCandidates({
      title: "t",
      opinions: [{ text: "结尾点题", reviewId: "r1" }],
      existing: [{ id: "cand-1", ruleText: "x", status: "pending", sources: [{ text: "结尾点题", reviewId: "r1" }] }],
    });
    expect(plan.skipped).toEqual([{ text: "结尾点题", reason: "duplicate_source" }]);
  });

  it("同一篇的修改版不能被去掉标点和空格后误判为重复", async () => {
    const plan = await planRuleCandidates({
      title: "t",
      opinions: [{ text: "结尾：点题！", reviewId: "r1" }],
      existing: [{ id: "cand-1", ruleText: "结尾点题", status: "pending", sources: [{ text: "结尾点题", reviewId: "r1" }] }],
    });
    expect(plan.create.map((item) => item.ruleText)).toEqual(["结尾：点题！"]);
    expect(plan.skipped).toEqual([]);
  });

  it("已通过规则只跳过完全相同原文，保留标点、空白和换行差异", async () => {
    const texts = ["开头点题。", "开头点题", "开头  点题。", "开头\n点题。"];
    const plan = await planRuleCandidates({
      title: "t",
      opinions: texts.map((text) => ({ text })),
      existing: [{ id: "op-1", ruleText: texts[0]!, status: "approved", sources: [] }],
    });
    expect(plan.create.map((item) => item.ruleText)).toEqual(texts.slice(1));
    expect(plan.skipped).toEqual([{ text: texts[0], reason: "already_approved" }]);
  });

  it("从历史来源按原文去重，保留顺序、标点、空白和完整换行", () => {
    const originals = ["第一段铺垫。", "第一段铺垫！", "第一段  铺垫。\n再写过程。", "  第一段铺垫。  "];
    expect(originalRuleTexts({
      ruleText: "AI 改写的内容",
      sources: [...originals, originals[0]!, "\n  "].map((text) => ({ text })),
    })).toEqual(originals);
  });

  it("历史候选没有可用来源时兼容原 ruleText", () => {
    expect(originalRuleTexts({ ruleText: "旧版规则。\n保留  换行", sources: [] })).toEqual(["旧版规则。\n保留  换行"]);
    expect(originalRuleTexts({ ruleText: "旧版规则", sources: [{ text: "   " }] })).toEqual(["旧版规则"]);
    expect(originalRuleTexts({ ruleText: "   ", sources: [] })).toEqual([]);
  });

  it("退回意见合并原因和修改要求，丢掉「无」", () => {
    expect(rejectionOpinionText("离题", "无")).toBe("离题");
    expect(rejectionOpinionText("无", "")).toBe("");
  });
});
