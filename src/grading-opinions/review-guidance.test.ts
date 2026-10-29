import { describe, expect, it } from "vitest";
import { composeReviewGuidance, readReviewGuidance, guidanceForPrompt } from "./review-guidance";
import { validateTeacherRewriteLengths } from "../domain/teacher-rewrite-lengths";

describe("分层指导", () => {
  it("三轮修改始终只解析最新硬约束，旧历史不复活", () => {
    const standing = [{ text: "五段式，第1段至少100字", createdAt: 1 }];
    const history = [
      { text: "五段式，第1段至少100字，结尾点题", createdAt: 2 },
      { text: "四段式，第1段最多20字，结尾写动作", createdAt: 3 },
    ];
    const raw = composeReviewGuidance("严格三段式，第1段最多5字，结尾留白", standing, history)!;
    expect(readReviewGuidance(raw).constraints).toBe("严格三段式，第1段最多5字，结尾留白");
    expect(() => validateTeacherRewriteLengths(["甲乙", "丙", "丁"], readReviewGuidance(raw).constraints)).not.toThrow();
    const batch = readReviewGuidance(composeReviewGuidance(null, standing, history));
    expect(batch.constraints).toBe("");
    expect(batch.history).toContain("四段式");
    expect(batch.constraints).not.toContain("五段式");
    expect(guidanceForPrompt(raw)).toContain("已被替代");
    expect(readReviewGuidance(composeReviewGuidance(null, standing, [])).history).toBe("");
  });
  it("完整保留最长本轮文本，并容忍教师手写的标记前缀", () => {
    const current = "甲".repeat(4000);
    const raw = composeReviewGuidance(current, [], [])!;
    expect(raw.length).toBeLessThanOrEqual(4000);
    expect(readReviewGuidance(raw).current).toBe(current);
    expect(readReviewGuidance("review-guidance-v1:不是JSON").current).toBe("review-guidance-v1:不是JSON");
  });
  it("预算优先保留本轮，再保留最近本篇，结构化存储完整可解析", () => {
    const raw = composeReviewGuidance("本轮".repeat(1200), [{ text: "长期".repeat(1000), createdAt: 1 }], [{ text: "本篇历史", createdAt: 2 }])!;
    expect(readReviewGuidance(raw).current).toBe("本轮".repeat(1200));
    expect(readReviewGuidance(raw).history).toBe("本篇历史");
    expect(raw.length).toBeLessThanOrEqual(4000);
  });
});
