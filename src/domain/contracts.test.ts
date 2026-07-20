import { describe, expect, it } from "vitest";

import {
  annotationSchema,
  assignmentConfigSchema,
  createEvaluationReportSchema,
} from "./contracts";
import { deriveLevel, validateReport } from "./report-validation";

const validScores = {
  themeIntent: 9,
  contentSelection: 9,
  structure: 7,
  languageExpression: 7,
  writingConventions: 4,
  total: 36,
  level: "优秀作文" as const,
};

const paragraph = "我".repeat(110);

const validReport = {
  themeFit: "fits" as const,
  themeReason: "审题准确。",
  personalizedComment: "细节真实，结构完整。",
  painPoints: ["结尾略快"],
  commonIssues: ["个别句子较长"],
  revisionSuggestions: ["补充结尾感受"],
  scores: validScores,
  sampleParagraphs: Array.from({ length: 5 }, () => paragraph),
};

describe("assignmentConfigSchema", () => {
  it("为年级和目标字数提供默认值", () => {
    const config = assignmentConfigSchema.parse({
      title: "为自己喝彩",
      writingRequirements: "写一件亲身经历的事。",
      structureRequirements: "开头点题，结尾升华。",
      scoringFocus: "细节描写与真情实感。",
      templateType: "preset_self_applause",
    });

    expect(config.grade).toBe("上海五四学制六年级");
    expect(config.targetCharacters).toBe(600);
  });
});

describe("annotationSchema", () => {
  const annotation = {
    pageIndex: 0,
    x: 0.5,
    y: 0.25,
    category: "typo" as const,
    anchorText: "的得地",
    comment: "请检查用字。",
    isHighlight: false,
  };

  it.each([
    ["x", -0.01],
    ["x", 1.01],
    ["y", -0.01],
    ["y", 1.01],
  ])("拒绝 %s=%s 的越界坐标", (field, value) => {
    expect(() => annotationSchema.parse({ ...annotation, [field]: value })).toThrow();
  });

  it("接受边界坐标", () => {
    expect(annotationSchema.parse({ ...annotation, x: 0, y: 1 })).toMatchObject({
      x: 0,
      y: 1,
    });
  });
});

describe("evaluationReportSchema", () => {
  it("接受预设模板的5段、550个中文字范文", () => {
    expect(
      createEvaluationReportSchema("preset_self_applause").parse(validReport),
    ).toEqual(validReport);
  });

  it("拒绝预设模板的非5段范文", () => {
    expect(() =>
      createEvaluationReportSchema("preset_self_applause").parse({
        ...validReport,
        sampleParagraphs: validReport.sampleParagraphs.slice(0, 4),
      }),
    ).toThrow();
  });

  it.each([549, 651])(
    "拒绝预设模板合计 %i 个中文字的范文",
    (totalCharacters) => {
      const lengths = [110, 110, 110, 110, totalCharacters - 440];
      expect(() =>
        createEvaluationReportSchema("preset_self_applause").parse({
          ...validReport,
          sampleParagraphs: lengths.map((length) => "文".repeat(length)),
        }),
      ).toThrow();
    },
  );

  it("允许自定义模板包含1至10段", () => {
    expect(
      createEvaluationReportSchema("custom").parse({
        ...validReport,
        sampleParagraphs: ["简短示例"],
      }).sampleParagraphs,
    ).toHaveLength(1);

    expect(
      createEvaluationReportSchema("custom").parse({
        ...validReport,
        sampleParagraphs: Array.from({ length: 10 }, () => "示例"),
      }).sampleParagraphs,
    ).toHaveLength(10);
  });
});

describe("deriveLevel", () => {
  it.each([
    [0, "重写"],
    [29, "重写"],
    [30, "二类作文"],
    [35, "二类作文"],
    [36, "优秀作文"],
    [40, "优秀作文"],
  ])("将 %i 分归类为 %s", (total, expected) => {
    expect(deriveLevel(total)).toBe(expected);
  });

  it.each([-1, 41])("拒绝越界总分 %i", (total) => {
    expect(() => deriveLevel(total)).toThrow();
  });
});

describe("validateReport", () => {
  it("要求分项和等于总分", () => {
    expect(() =>
      validateReport({
        ...validReport,
        scores: { ...validScores, total: 35, level: "二类作文" },
      }),
    ).toThrow(/total/i);
  });

  it("要求等级与总分边界一致", () => {
    expect(() =>
      validateReport({
        ...validReport,
        scores: { ...validScores, level: "二类作文" },
      }),
    ).toThrow(/level/i);
  });

  it.each([
    ["off_topic", false],
    ["fits", true],
  ] as const)(
    "在 themeFit=%s、incompleteEvent=%s 时限制总分不高于29",
    (themeFit, incompleteEvent) => {
      expect(() =>
        validateReport(
          { ...validReport, themeFit },
          { incompleteEvent, templateType: "preset_self_applause" },
        ),
      ).toThrow(/29/);
    },
  );
});
