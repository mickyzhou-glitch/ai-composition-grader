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

const paragraphRangeConfig: AssignmentConfig = {
  ...config,
  structureRequirements: [
    "开头段（建议字数：100-150字）：点题。",
    "第二段（建议字数：100-150字）：写礼物。",
    "第三段（建议字数：200-250字）：写事件。",
    "第四段（建议字数：100-150字）：写影响。",
    "结尾段（建议字数：100-150字）：写感悟。",
  ].join("\n\n"),
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
  it("按教师目标字数下浮 50、上浮 100 生成动态范围", () => {
    expect(resolveSampleWritingRequirements(config)).toEqual({
      paragraphCount: 5,
      minimumCharacters: 550,
      maximumCharacters: 700,
    });
  });

  it("只统计各段正文中的汉字", () => {
    expect(countSampleTextCharacters(paragraphs(600))).toBe(600);
  });

  it("从结构要求读取每段建议字数", () => {
    expect(resolveSampleWritingRequirements(paragraphRangeConfig)).toMatchObject({
      paragraphCount: 5,
      paragraphCharacterRanges: [
        { minimumCharacters: 100, maximumCharacters: 150 },
        { minimumCharacters: 100, maximumCharacters: 150 },
        { minimumCharacters: 200, maximumCharacters: 250 },
        { minimumCharacters: 100, maximumCharacters: 150 },
        { minimumCharacters: 100, maximumCharacters: 150 },
      ],
    });
  });

  it("有分段字数要求时按各段范围校验，不使用总字数范围", () => {
    const paragraphsAtEachMaximum = [150, 150, 250, 150, 150].map((length, index) => ({
      title: `第 ${index + 1} 段`,
      text: "文".repeat(length),
      suggestion: "补充细节。",
    }));
    expect(() => validateSampleWritingRequirements(paragraphsAtEachMaximum, paragraphRangeConfig))
      .not.toThrow();

    const invalid = paragraphsAtEachMaximum.map((paragraph, index) =>
      index === 2 ? { ...paragraph, text: "文".repeat(199) } : paragraph,
    );
    expect(() => validateSampleWritingRequirements(invalid, paragraphRangeConfig))
      .toThrow(/paragraphIndex=3.*expectedParagraphCharacters=200\.\.250.*actualParagraphCharacters=199/u);
  });

  it.each([550, 700])("接受合计 %i 个汉字的示范正文", (totalCharacters) => {
    expect(() => validateSampleWritingRequirements(paragraphs(totalCharacters), config))
      .not.toThrow();
  });

  it.each([549, 701])("拒绝合计 %i 个汉字的示范正文", (totalCharacters) => {
    expect(() => validateSampleWritingRequirements(paragraphs(totalCharacters), config))
      .toThrow(/expectedCharacters=550\.\.700/u);
  });

  it("拒绝段落数不符合题目配置的示范正文", () => {
    expect(() => validateSampleWritingRequirements(paragraphs(600).slice(0, 4), config))
      .toThrow(/expectedParagraphs=5/u);
  });

  it("提示词逐项保留教师配置并限定五升六学生水平", () => {
    const rule = buildSampleWritingRule(config);

    expect(rule).toContain("五升六");
    expect(rule).toContain("550-700");
    expect(rule).toContain(config.writingRequirements);
    expect(rule).toContain(config.structureRequirements);
    expect(rule).toContain(config.scoringFocus);
    expect(rule).toContain("不得写成初中生或成人范文");
  });

  it("有分段字数要求时提示词逐段说明且不追加总量范围", () => {
    const rule = buildSampleWritingRule(paragraphRangeConfig);

    expect(rule).toContain("第1段 text 的汉字数必须为 100-150");
    expect(rule).toContain("第3段 text 的汉字数必须为 200-250");
    expect(rule).not.toContain("550-700");
    expect(rule).toContain("按各段范围校验");
  });

  it("初中年级只限制为指定年级水平，不误写成小学生规则", () => {
    const rule = buildSampleWritingRule({ ...config, grade: "初二" });

    expect(rule).toContain("初二");
    expect(rule).not.toContain("不得写成初中生");
    expect(rule).not.toContain("小学生");
  });
});
