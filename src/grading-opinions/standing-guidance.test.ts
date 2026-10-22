import { describe, expect, it } from "vitest";

import {
  MAX_GRADING_OPINION_BODY_CHARS,
  MAX_STANDING_GUIDANCE_CHARS,
  MAX_STORED_TEACHER_GUIDANCE_CHARS,
  STANDING_GUIDANCE_HEADER,
  gradingOpinionBody,
  guidanceWithStandingOpinions,
} from "./standing-guidance";

describe("grading opinion standing guidance", () => {
  it("空说明不存档，只保留有内容的一侧", () => {
    expect(gradingOpinionBody("  ", "   ")).toBeNull();
    expect(gradingOpinionBody("离题", "")).toBe("为什么不合适：离题");
    expect(gradingOpinionBody("", "改成五段")).toBe("应该怎么改：改成五段");
    expect(gradingOpinionBody(" 离题 ", " 改成五段 ")).toBe("为什么不合适：离题\n应该怎么改：改成五段");
  });

  it("没有存档时原样保留本次意见", () => {
    expect(guidanceWithStandingOpinions(null, [])).toBeNull();
    expect(guidanceWithStandingOpinions("  保留原句  ", [])).toBe("保留原句");
    expect(guidanceWithStandingOpinions("保留原句", [{ body: "   ", createdAt: 2 }])).toBe("保留原句");
  });

  it("去重后优先保留更新的意见，并忽略空白差异", () => {
    const guidance = guidanceWithStandingOpinions("本次只改结尾", [
      { body: "为什么不合适：离题\n应该怎么改：重写", createdAt: 1 },
      { body: "为什么不合适：离题 应该怎么改：重写", createdAt: 3 },
      { body: "应该怎么改：开头用名言", createdAt: 2 },
    ]);

    expect(guidance).toContain("本次只改结尾");
    expect(guidance).toContain(STANDING_GUIDANCE_HEADER);
    expect(guidance).toContain("1. 为什么不合适：离题 应该怎么改：重写");
    expect(guidance).toContain("2. 应该怎么改：开头用名言");
    expect(guidance?.match(/离题/gu)).toHaveLength(1);
    expect(guidance!.indexOf("开头用名言")).toBeGreaterThan(guidance!.indexOf("离题"));
  });

  it("超长时丢掉放不下的旧意见，总长度不超过存档上限", () => {
    const newest = "新".repeat(900);
    const middle = "中".repeat(900);
    const oldest = "旧".repeat(900);
    const user = "意".repeat(1_100);
    const guidance = guidanceWithStandingOpinions(user, [
      { body: oldest, createdAt: 1 },
      { body: middle, createdAt: 2 },
      { body: newest, createdAt: 3 },
    ]);

    expect(guidance?.startsWith(user)).toBe(true);
    expect(guidance).toContain(newest);
    expect(guidance).toContain(middle);
    expect(guidance).not.toContain(oldest);
    expect(guidance!.length).toBeLessThanOrEqual(MAX_STORED_TEACHER_GUIDANCE_CHARS);
    expect(guidance!.length - user.length).toBeLessThanOrEqual(MAX_STANDING_GUIDANCE_CHARS + 2);
    expect(MAX_GRADING_OPINION_BODY_CHARS).toBe(1_200);
  });

  it("单条超长意见放不下时，仍带上后面较短的意见", () => {
    const guidance = guidanceWithStandingOpinions(null, [
      { body: "短要求", createdAt: 1 },
      { body: "长".repeat(MAX_STANDING_GUIDANCE_CHARS), createdAt: 2 },
    ]);

    expect(guidance).toContain("1. 短要求");
    expect(guidance).not.toContain("长".repeat(20));
    expect(guidance!.length).toBeLessThanOrEqual(MAX_STANDING_GUIDANCE_CHARS);
  });
});
