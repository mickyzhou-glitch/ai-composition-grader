import { describe, expect, it } from "vitest";

import { validateGeneratedReportSemantics } from "../ai/review-semantics";
import type { AssignmentConfig } from "./contracts";
import { ReportValidationError, validateReport } from "./report-validation";
import { createOcrCheckpointV2, type OcrCheckpointV1 } from "../ocr/contracts";

const config: AssignmentConfig = {
  title: "为自己喝彩",
  grade: "上海五四学制六年级",
  writingRequirements: "写一件亲身经历的事。",
  targetCharacters: 600,
  structureRequirements: "开头点题，结尾升华。",
  scoringFocus: "细节描写与真情实感。",
  templateType: "preset_self_applause",
};

const diagnostics = {
  authenticityAndRelevance: {
    finding: "主题明确，事件真实。",
    action: "保留真实经历，补一处选择时的感受。",
  },
  materialAndDetails: {
    finding: "关键动作还可以更具体。",
    action: "补写爸爸递水时的动作和自己的感受。",
  },
  structure: {
    finding: "开头点题，结尾升华。",
    action: "让第四段的行动承接第三段的转折。",
  },
  language: {
    finding: "句子基本流畅。",
    action: "把段首时间词改为承接情绪的句子。",
  },
};

const parentFeedbacks = [
  { style: "warm" as const, title: "亲切详细", content: "小明家长您好，作文选材真实，建议补充动作细节。" },
  { style: "professional" as const, title: "专业清晰", content: "小明家长您好，作文主题明确，建议写清心理变化。" },
  { style: "concise" as const, title: "简短微信版", content: "小明家长您好，内容真实，再补一处听觉细节。" },
];

const checkpoint = createOcrCheckpointV2({
  sourceRevision: 3,
  ocrRevision: 1,
  pages: [{
    pageIndex: 0,
    text: "清晨，我走进公园。风吹过树叶。",
    readable: true,
    warnings: [],
    blocks: [],
  }],
  paragraphs: [
    {
      paragraphIndex: 0,
      text: "清晨，我走进公园。",
      segments: [{
        pageIndex: 0,
        text: "清晨，我走进公园。",
        x: 0.1,
        y: 0.1,
        width: 0.4,
        height: 0.05,
      }],
    },
    {
      paragraphIndex: 1,
      text: "风吹过树叶。",
      segments: [{
        pageIndex: 0,
        text: "风吹过树叶。",
        x: 0.1,
        y: 0.2,
        width: 0.3,
        height: 0.05,
      }],
    },
  ],
});

const reportContent = {
  themeFit: "fits" as const,
  themeReason: "审题准确。",
  personalizedComment: "1. 选材真实\n2. 情感自然",
  painPoints: ["1. 描写单一", "2. 结尾略快"],
  commonIssues: ["段落衔接较弱"],
  revisionSuggestions: ["补充感官细节"],
  grade: "A" as const,
  diagnostics,
  parentFeedbacks,
};

const paragraphReviews = checkpoint.paragraphs.map((paragraph, index) => ({
  paragraphId: paragraph.id,
  suggestions: [{
    problem: index === 0 ? "描写单一" : "保留",
    advice: index === 0 ? "补充听觉细节" : "保留准确的动作描写",
    example: index === 0 ? "风吹过树叶，沙沙作响。" : "风吹过树叶。",
  }],
  revisedText: index === 0 ? "清晨，我走进公园，听见树叶沙沙作响。" : "风吹过树叶。",
}));

const paragraphReport = {
  ...reportContent,
  version: 2 as const,
  paragraphReviews,
};

describe("validateReport paragraph coverage", () => {
  it("接受与当前 OCR v2 数量、唯一性和顺序完全一致的逐段批改", () => {
    expect(validateReport(paragraphReport, { config, ocr: checkpoint })).toEqual(paragraphReport);
  });

  it.each([
    ["遗漏", paragraphReviews.slice(0, 1)],
    ["重复", [paragraphReviews[0], { ...paragraphReviews[1], paragraphId: "paragraph-1" }]],
    ["乱序", [...paragraphReviews].reverse()],
    ["未知 ID", [paragraphReviews[0], { ...paragraphReviews[1], paragraphId: "paragraph-99" }]],
  ])("拒绝%s的 paragraphId 覆盖", (_reason, invalidReviews) => {
    expect(() => validateReport(
      { ...paragraphReport, paragraphReviews: invalidReviews },
      { config, ocr: checkpoint },
    )).toThrow(ReportValidationError);
  });

  it.each([
    ["0 条 suggestions", []],
    ["5 条 suggestions", Array.from({ length: 5 }, () => paragraphReviews[0].suggestions[0])],
    ["空 problem", [{ ...paragraphReviews[0].suggestions[0], problem: "   " }]],
    ["空 advice", [{ ...paragraphReviews[0].suggestions[0], advice: "   " }]],
    ["空 example", [{ ...paragraphReviews[0].suggestions[0], example: "   " }]],
    ["problem=保留但 advice 为空", [{ problem: "保留", advice: "   ", example: "原句准确。" }]],
    ["problem=保留但 example 为空", [{ problem: "保留", advice: "保留原句", example: "   " }]],
  ])("拒绝%s", (_reason, suggestions) => {
    expect(() => validateReport({
      ...paragraphReport,
      paragraphReviews: [
        { ...paragraphReviews[0], suggestions },
        paragraphReviews[1],
      ],
    }, { config, ocr: checkpoint })).toThrow();
  });

  it("拒绝空 revisedText", () => {
    expect(() => validateReport({
      ...paragraphReport,
      paragraphReviews: [
        { ...paragraphReviews[0], revisedText: "   " },
        paragraphReviews[1],
      ],
    }, { config, ocr: checkpoint })).toThrow();
  });

  it("逐段报告缺少当前 OCR v2 时返回清晰错误", () => {
    const checkpointV1: OcrCheckpointV1 = {
      version: 1,
      sourceRevision: 3,
      ocrRevision: 1,
      editedAt: null,
      pages: checkpoint.pages,
    };

    for (const ocr of [undefined, checkpointV1]) {
      try {
        validateReport(paragraphReport, { config, ocr });
        throw new Error("expected validation to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ReportValidationError);
        expect((error as ReportValidationError).code).toBe("OCR_V2_REQUIRED");
      }
    }
  });

  it("逐段报告继续执行等级、结构和家长反馈语义校验", () => {
    const result = validateGeneratedReportSemantics(
      paragraphReport,
      config,
      "小明",
      checkpoint,
    );

    expect(result).toMatchObject({
      version: 2,
      personalizedComment: "选材真实\n情感自然",
      painPoints: ["描写单一", "结尾略快"],
      commonIssues: [],
      revisionSuggestions: [],
      paragraphReviews,
    });
  });
});
