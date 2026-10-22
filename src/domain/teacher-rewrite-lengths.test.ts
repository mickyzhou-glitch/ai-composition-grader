import { describe, expect, it } from "vitest";

import { teacherRewriteLengthRule, validateTeacherRewriteLengths } from "./teacher-rewrite-lengths";

describe("教师明确的段落字数要求", () => {
  const essay = ["甲".repeat(50), "乙".repeat(50), "丙".repeat(180), "丁", "戊"];

  it("为模型提供明确计数口径和余量，减少刚好擦边的失败", () => {
    const rule = teacherRewriteLengthRule("第一、二段合计不超过120字，第三段不少于180字");
    expect(rule).toContain("第1、2段合计必须不超过120个汉字");
    expect(rule).toContain("控制在96个汉字以内");
    expect(rule).toContain("至少写到324个汉字以上");
  });

  it.each(["前两段合计不超过120字", "第一、二段合计不超过120字", "第1、2段总计最多120字"])("校验合计上限：%s", (guidance) => {
    expect(() => validateTeacherRewriteLengths(essay, guidance)).not.toThrow();
    expect(() => validateTeacherRewriteLengths(["甲".repeat(80), ...essay.slice(1)], guidance))
      .toThrow("rewritten_essay_chars_1_2_max_120_actual_130");
  });

  it("校验单段下限并按汉字计数，不能靠标点凑数", () => {
    expect(() => validateTeacherRewriteLengths(essay, "第三段不少于180字")).not.toThrow();
    expect(() => validateTeacherRewriteLengths(["甲", "乙", "丙".repeat(179) + "！"], "第三段不少于180字"))
      .toThrow("rewritten_essay_chars_3_min_180_actual_179");
  });

  it("新的两个框里的字数硬性要求都会校验", () => {
    const guidance = "[结构问题 / 共性问题]\n第三段不少于180字\n[内容建议]\n保留原意";
    expect(() => validateTeacherRewriteLengths(essay, guidance)).not.toThrow();
    expect(() => validateTeacherRewriteLengths(["甲", "乙", "丙".repeat(10), "丁", "戊"], guidance))
      .toThrow("rewritten_essay_chars_3_min_180_actual_10");
  });

  it("只处理明确硬性要求，忽略约数、事实数字和不合适原因", () => {
    expect(() => validateTeacherRewriteLengths(essay, "第一段约100字，凌晨四点，十几年" )).not.toThrow();
    expect(() => validateTeacherRewriteLengths(essay, "[不合适原因]\n第三段至少200字仍不够生动\n[修改要求]\n保留第三段，调整结尾" )).not.toThrow();
  });
});
