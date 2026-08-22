import { describe, expect, it } from "vitest";

import {
  annotationSchema,
  assignmentConfigSchema,
  createEvaluationReportSchema,
  evaluationReportSchema,
  expectedSampleParagraphCount,
  privacyUploadConsentSchema,
  scoreLevelSchema,
} from "./contracts";
import { deriveLevel, validateReport } from "./report-validation";

const paragraph = "我".repeat(120);
const parentFeedbacks = [
  { style: "warm" as const, title: "亲切详细", content: "家长您好，这次作文选材真实，第三段可以补写争执原因。" },
  { style: "professional" as const, title: "专业清晰", content: "本次作文选材切题；建议第三段补足冲突起因。" },
  { style: "concise" as const, title: "简短微信版", content: "家长您好，作文选材真实，第三段再补清争执原因。" },
];

const validReport = {
  themeFit: "fits" as const,
  themeReason: "审题准确。",
  personalizedComment: "细节真实，结构完整。",
  painPoints: ["结尾略快"],
  commonIssues: ["个别句子较长"],
  revisionSuggestions: ["补充结尾感受"],
  grade: "A-" as const,
  diagnostics: {
    authenticityAndRelevance: { finding: "主题明确，事件真实。", action: "保留真实经历，补一处选择时的感受。" },
    materialAndDetails: { finding: "关键动作还可以更具体。", action: "补写爸爸递水时的动作和自己的感受。" },
    structure: { finding: "五段结构完整。", action: "让第四段的行动承接第三段的转折。" },
    language: { finding: "句子基本流畅。", action: "把段首时间词改为承接情绪的句子。" },
  },
  sampleParagraphs: Array.from({ length: 5 }, (_, index) => ({
    title: `第 ${index + 1} 段`,
    text: paragraph,
    suggestion: "补充动作细节。",
  })),
  parentFeedbacks,
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

  it("历史配置默认要求5段，显式配置保留指定段落数", () => {
    const historical = assignmentConfigSchema.parse({
      title: "珍贵的礼物",
      writingRequirements: "写一件真实的事。",
      structureRequirements: "分五段展开。",
      scoringFocus: "细节与真情实感。",
      templateType: "custom",
    });

    expect(expectedSampleParagraphCount(historical)).toBe(5);
    expect(expectedSampleParagraphCount({ ...historical, sampleParagraphCount: 3 })).toBe(3);
  });

  it.each([0, 1.5, 11])("拒绝非法示例段落数 %s", (sampleParagraphCount) => {
    expect(() => assignmentConfigSchema.parse({
      title: "珍贵的礼物",
      writingRequirements: "写一件真实的事。",
      structureRequirements: "分五段展开。",
      scoringFocus: "细节与真情实感。",
      templateType: "custom",
      sampleParagraphCount,
    })).toThrow();
  });
});

describe("privacyUploadConsentSchema", () => {
  it("只接受当前版本的明确确认", () => {
    expect(privacyUploadConsentSchema.parse({ confirmed: true, version: "2026-07-22" })).toEqual({
      confirmed: true,
      version: "2026-07-22",
    });
    expect(() => privacyUploadConsentSchema.parse({ confirmed: false, version: "2026-07-22" })).toThrow();
    expect(() => privacyUploadConsentSchema.parse({ confirmed: true, version: "old" })).toThrow();
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
  it("接受并保留固定顺序的三份家长反馈", () => {
    expect(evaluationReportSchema.parse(validReport).parentFeedbacks).toEqual(parentFeedbacks);
  });

  it("将缺少家长反馈的历史报告归一化为空数组", () => {
    const legacyReport = {
      ...validReport,
      grade: undefined,
      diagnostics: undefined,
      parentFeedbacks: undefined,
    };

    expect(evaluationReportSchema.parse({
      ...legacyReport,
      scores: {
        themeIntent: 8,
        contentSelection: 8,
        structure: 7,
        languageExpression: 7,
        writingConventions: 4,
        total: 34,
        level: "优秀作文",
      },
    }).parentFeedbacks).toEqual([]);
  });

  it.each([
    ["少于三项", parentFeedbacks.slice(0, 2)],
    ["顺序错误", [parentFeedbacks[1], parentFeedbacks[0], parentFeedbacks[2]]],
    ["样式重复", [parentFeedbacks[0], { ...parentFeedbacks[1], style: "warm" as const }, parentFeedbacks[2]]],
  ])("拒绝%s的非空家长反馈列表", (_reason, invalidParentFeedbacks) => {
    expect(() => evaluationReportSchema.parse({
      ...validReport,
      parentFeedbacks: invalidParentFeedbacks,
    })).toThrow();
  });

  it.each([
    ["title", "   "],
    ["content", "   "],
  ])("拒绝空白的家长反馈%s", (field, value) => {
    expect(() => evaluationReportSchema.parse({
      ...validReport,
      parentFeedbacks: [
        { ...parentFeedbacks[0], [field]: value },
        parentFeedbacks[1],
        parentFeedbacks[2],
      ],
    })).toThrow();
  });

  it("接受无数值的七档等级和四维诊断", () => {
    const result = createEvaluationReportSchema("preset_self_applause").safeParse({
      ...validReport,
      grade: "A-",
      diagnostics: {
        authenticityAndRelevance: {
          finding: "结尾写出坚持，但第二段还缺少一次真实的选择。",
          action: "在第二段补上你犹豫后仍坚持练习的具体经过。",
        },
        materialAndDetails: {
          finding: "爸爸的关心停留在概括，缺少动作细节。",
          action: "补写爸爸递水、停下脚步等一个连续动作。",
        },
        structure: {
          finding: "五段结构完整，第三段转折明确。",
          action: "保留第三段的转折句，并让第四段接着写自己的行动。",
        },
        language: {
          finding: "段首反复使用时间词，衔接较单一。",
          action: "把“第二天”改为承接上一段情绪或动作的句子。",
        },
      },
      scores: undefined,
      sampleParagraphs: Array.from({ length: 5 }, (_, index) => ({
        title: `第 ${index + 1} 段`,
        text: "我".repeat(120),
        suggestion: "补充动作细节。",
      })),
    });

    expect(scoreLevelSchema.safeParse("A+").success).toBe(true);
    expect(scoreLevelSchema.safeParse("C").success).toBe(true);
    expect(result.success).toBe(true);
  });

  it("示范段落是有标题、正文和修改建议的结构化对象", () => {
    const samples = Array.from({ length: 5 }, (_, index) => ({
      title: `第 ${index + 1} 段`,
      text: paragraph,
      suggestion: "补充动作细节。",
    }));

    expect(
      createEvaluationReportSchema("preset_self_applause").parse({
        ...validReport,
        sampleParagraphs: samples,
      }),
    ).toMatchObject({ sampleParagraphs: samples });
  });

  it("报告基础结构不硬编码特定题目的段落数和目标字数", () => {
    const samples = Array.from({ length: 3 }, (_, index) => ({
      title: `第 ${index + 1} 段`,
      text: "文".repeat(100),
      suggestion: "修改建议。",
    }));

    expect(
      createEvaluationReportSchema("preset_self_applause").parse({
        ...validReport,
        sampleParagraphs: samples,
      }),
    ).toMatchObject({ sampleParagraphs: samples });
  });

  it("允许自定义模板包含1至10段", () => {
    expect(
      createEvaluationReportSchema("custom").parse({
        ...validReport,
        sampleParagraphs: [{ title: "示例", text: "简短示例", suggestion: "补充细节。" }],
      }).sampleParagraphs,
    ).toHaveLength(1);

    expect(
      createEvaluationReportSchema("custom").parse({
        ...validReport,
        sampleParagraphs: Array.from({ length: 10 }, () => ({ title: "示例", text: "示例", suggestion: "建议" })),
      }).sampleParagraphs,
    ).toHaveLength(10);
  });
});

describe("gradeFromLegacyTotal", () => {
  it.each([
    [0, "C"], [29, "C"], [30, "B-"], [32, "B"], [34, "B+"], [36, "A-"], [37, "A"], [40, "A+"],
  ])("将历史 %i 分迁移为 %s", (total, expected) => {
    expect(deriveLevel(total)).toBe(expected);
  });

  it.each([-1, 41])("拒绝越界历史总分 %i", (total) => {
    expect(() => deriveLevel(total)).toThrow();
  });
});

describe("validateReport", () => {
  it("偏题作文必须评为 C（重写）", () => {
    expect(() =>
      validateReport({
        ...validReport,
        themeFit: "off_topic",
      }),
    ).toThrow(/grade C/i);
  });

  it("事件不完整时必须评为 C（重写）", () => {
    expect(() => validateReport(validReport, { incompleteEvent: true })).toThrow(/grade C/i);
  });
});
