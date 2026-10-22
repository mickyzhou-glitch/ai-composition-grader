import { describe, expect, it } from "vitest";

import {
  MAX_STANDING_GUIDANCE_CHARS,
  MAX_STORED_TEACHER_GUIDANCE_CHARS,
  STANDING_GUIDANCE_HEADER,
  classifyOpinion,
  describeGradingOpinion,
  gradingOpinionBody,
  guidanceWithStandingOpinions,
  paragraphLabelFromText,
  parseArchivedOpinionBody,
  parseRevisionTeacherGuidance,
} from "./standing-guidance";

describe("grading opinion standing guidance", () => {
  it("空说明不存档，并抽出段落位置和类别", () => {
    expect(gradingOpinionBody("  ", "   ")).toBeNull();
    expect(describeGradingOpinion("第2段太空", "写具体")).toMatchObject({
      reason: "第2段太空",
      changeRequest: "写具体",
      paragraphLabel: "第2段",
      category: "结构",
    });
    expect(paragraphLabelFromText("第一段和第三段都要改")).toBe("第1段、第3段");
    expect(classifyOpinion("语言生硬", "改得自然")).toBe("语言");
    expect(classifyOpinion("不少于180字", "补足字数")).toBe("字数");
    expect(classifyOpinion("离题", "只写一件事")).toBe("内容");
    expect(classifyOpinion("称呼乱了", "按原文改")).toBe("其他");
  });

  it("从任务里的退回说明读出两项文字，并忽略后面的规则清单", () => {
    const guidance = [
      "[不合适原因]",
      "第2段太空",
      "[修改要求]",
      "写具体",
      "",
      STANDING_GUIDANCE_HEADER,
      "【结构】",
      "1. 应该怎么改：旧规则",
    ].join("\n");

    expect(parseRevisionTeacherGuidance(guidance)).toEqual({
      reason: "第2段太空",
      changeRequest: "写具体",
    });
    const legacy = [
      "[不合适原因]",
      "结构散",
      "[修改要求]",
      "严格五段",
      "",
      "以下是这位老师存档的长期批改要求，每次批改都必须遵守。与本次补充意见冲突时，以本次补充意见为准；与原文事实冲突时，以原文为准。",
      "1. 为什么不合适：旧规则",
    ].join("\n");
    expect(parseRevisionTeacherGuidance(legacy)).toEqual({
      reason: "结构散",
      changeRequest: "严格五段",
    });
    expect(parseRevisionTeacherGuidance("请重点看结尾")).toBeNull();
    expect(parseRevisionTeacherGuidance(null)).toBeNull();
    expect(parseArchivedOpinionBody("为什么不合适：结构散\n应该怎么改：严格五段")).toEqual({
      reason: "结构散",
      changeRequest: "严格五段",
    });
    expect(parseArchivedOpinionBody("老师补充观点")).toBeNull();
  });

  it("没有存档时原样保留本次意见", () => {
    expect(guidanceWithStandingOpinions(null, [])).toBeNull();
    expect(guidanceWithStandingOpinions("  保留原句  ", [])).toBe("保留原句");
  });

  it("相同意见合并成一条规则并按类别列出次数", () => {
    const guidance = guidanceWithStandingOpinions("本次只改结尾", [
      { reason: "结构散", changeRequest: "严格五段", createdAt: 1 },
      { reason: "结构散", changeRequest: "严格五段", createdAt: 3 },
      { reason: "离题", changeRequest: "只写一件事", createdAt: 2 },
    ]);

    expect(guidance).toContain("本次只改结尾");
    expect(guidance).toContain(STANDING_GUIDANCE_HEADER);
    expect(guidance).toContain("【结构】");
    expect(guidance).toContain("1. 应该怎么改：严格五段（出现 2 次）");
    expect(guidance).toContain("   为什么不合适：结构散");
    expect(guidance).toContain("【内容】");
    expect(guidance).toContain("1. 应该怎么改：只写一件事");
    expect(guidance!.indexOf("【内容】")).toBeGreaterThan(guidance!.indexOf("【结构】"));
    expect(guidance?.match(/严格五段/gu)).toHaveLength(1);
  });

  it("段落位置写进规则，超长时丢掉放不下的旧规则", () => {
    const user = "意".repeat(1_100);
    const guidance = guidanceWithStandingOpinions(user, [
      { reason: "旧", changeRequest: "旧".repeat(900), createdAt: 1 },
      { reason: "中", changeRequest: "中".repeat(900), createdAt: 2 },
      { reason: "新", changeRequest: `第2段${"新".repeat(900)}`, createdAt: 3 },
    ]);

    expect(guidance?.startsWith(user)).toBe(true);
    expect(guidance).toContain("（第2段）");
    expect(guidance).toContain("中".repeat(20));
    expect(guidance).not.toContain("旧".repeat(20));
    expect(guidance!.length).toBeLessThanOrEqual(MAX_STORED_TEACHER_GUIDANCE_CHARS);
    expect(guidance!.length - user.length).toBeLessThanOrEqual(MAX_STANDING_GUIDANCE_CHARS + 2);
  });

  it("单条超长规则放不下时，仍带上后面较短的规则", () => {
    const guidance = guidanceWithStandingOpinions(null, [
      { reason: "短", changeRequest: "短要求", createdAt: 1 },
      { reason: "长", changeRequest: "长".repeat(MAX_STANDING_GUIDANCE_CHARS), createdAt: 2 },
    ]);

    expect(guidance).toContain("1. 应该怎么改：短要求");
    expect(guidance).not.toContain("长".repeat(20));
    expect(guidance!.length).toBeLessThanOrEqual(MAX_STANDING_GUIDANCE_CHARS);
  });
});