import { describe, expect, it } from "vitest";

import type { AssignmentConfig } from "../domain/contracts";
import {
  buildSampleWritingRule,
  countSampleTextCharacters,
  resolveSampleWritingRequirements,
  validateSampleWritingRequirements,
} from "./sample-writing-requirements";

const config: AssignmentConfig = {
  title: "一次有趣的活动",
  grade: "五升六",
  writingRequirements: "围绕一次真实活动写出自己的感受。",
  targetCharacters: 600,
  structureRequirements: "全文五段，按开头、经过、高潮、结果、感受展开。",
  scoringFocus: "过程具体，感受真实。",
  templateType: "custom",
  sampleParagraphCount: 5,
};

function paragraphs(totalCharacters: number) {
  const baseLength = Math.floor(totalCharacters / 5);
  const remainder = totalCharacters - baseLength * 5;
  return Array.from({ length: 5 }, (_, index) => ({
    title: `第 ${index + 1} 段${"题".repeat(100)}`,
    text: `${"文".repeat(baseLength + (index === 4 ? remainder : 0))}，。123ABC`,
    suggestion: `修改建议不计入字数${"改".repeat(100)}`,
  }));
}

describe("sample writing requirements", () => {
  it("按教师目标字数生成 600 至 660 个汉字的动态范围", () => {
    expect(resolveSampleWritingRequirements(config)).toEqual({
      paragraphCount: 5,
      minimumCharacters: 600,
      maximumCharacters: 660,
    });
  });

  it("只统计各段正文中的汉字", () => {
    expect(countSampleTextCharacters(paragraphs(600))).toBe(600);
  });

  it.each([599, 661])("拒绝合计 %i 个汉字的示范正文", (totalCharacters) => {
    expect(() => validateSampleWritingRequirements(paragraphs(totalCharacters), config))
      .toThrow(/expectedCharacters=600\.\.660/u);
  });

  it("拒绝段落数不符合题目配置的示范正文", () => {
    expect(() => validateSampleWritingRequirements(paragraphs(600).slice(0, 4), config))
      .toThrow(/expectedParagraphs=5/u);
  });

  it("提示词逐项保留教师配置并限定五升六学生水平", () => {
    const rule = buildSampleWritingRule(config);

    expect(rule).toContain("五升六");
    expect(rule).toContain("600-660");
    expect(rule).toContain(config.writingRequirements);
    expect(rule).toContain(config.structureRequirements);
    expect(rule).toContain(config.scoringFocus);
    expect(rule).toContain("不得写成初中生或成人范文");
  });

  it("初中年级只限制为指定年级水平，不误写成小学生规则", () => {
    const rule = buildSampleWritingRule({ ...config, grade: "初二" });

    expect(rule).toContain("初二");
    expect(rule).not.toContain("不得写成初中生");
    expect(rule).not.toContain("小学生");
  });
});
