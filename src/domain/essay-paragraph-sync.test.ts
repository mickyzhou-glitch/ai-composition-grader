import { describe, expect, it } from "vitest";

import type { ParagraphEvaluationReport } from "./contracts";
import {
  applyEssayToParagraphReviews,
  essayDiffersFromParagraphReviews,
  planReviewedEssayRepair,
  splitEssayIntoReviewParagraphs,
  structureGroupsShareEssay,
  writeGroupedParagraphText,
} from "./essay-paragraph-sync";

const diagnostics = {
  authenticityAndRelevance: { finding: "真实", action: "保留" },
  materialAndDetails: { finding: "细节少", action: "补动作" },
  structure: { finding: "完整", action: "保留" },
  language: { finding: "普通", action: "改具体" },
};

function report(
  essay: string[],
  revised: string[],
): ParagraphEvaluationReport {
  return {
    version: 2,
    themeFit: "fits",
    themeReason: "切题",
    personalizedComment: "真实",
    painPoints: [],
    commonIssues: [],
    revisionSuggestions: [],
    grade: "A-",
    diagnostics,
    rewrittenEssay: essay,
    paragraphReviews: revised.map((revisedText, index) => ({
      paragraphId: `paragraph-${index + 1}`,
      suggestions: [{ advice: index === 0 ? "补细节" : "本段无需修改" }],
      revisedText,
    })),
    parentFeedbacks: [],
  };
}

describe("完整范文切到逐段改后全段", () => {
  it("五段范文与五段逐段建议按原段覆盖，一段里的多个句子不再拆开", () => {
    const essay = ["开篇改后。还有一句。", "抑。", "扬的事件。", "真相。", "结尾。"];
    expect(splitEssayIntoReviewParagraphs(essay, 5)).toEqual(essay);
    const source = report(essay, ["开篇。", "抑。", "扬的事件。", "真相。", "结尾。"]);
    expect(essayDiffersFromParagraphReviews(source)).toBe(true);
    const synced = applyEssayToParagraphReviews(source);
    expect(synced.paragraphReviews.map((item) => item.revisedText)).toEqual(essay);
    expect(synced.paragraphReviews[0]?.suggestions).toEqual(source.paragraphReviews[0]?.suggestions);
    expect(synced.rewrittenEssay).toEqual(essay);
    expect(essayDiffersFromParagraphReviews(synced)).toBe(false);
    expect(applyEssayToParagraphReviews(synced)).toBe(synced);
  });

  it("范文段数多于逐段框时按顺序并进现有框", () => {
    const essay = ["甲。", "乙。", "丙。", "丁。", "戊。"];
    expect(splitEssayIntoReviewParagraphs(essay, 2)).toEqual(["甲。乙。丙。", "丁。戊。"]);
  });

  it("范文只有两段、逐段有五框时按句子切成五段", () => {
    const essay = ["甲。乙。丙。", "丁。戊。"];
    expect(splitEssayIntoReviewParagraphs(essay, 5)).toEqual(["甲。", "乙。", "丙。", "丁。", "戊。"]);
    const source = report(essay, ["旧一", "旧二", "旧三", "旧四", "旧五"]);
    expect(applyEssayToParagraphReviews(source).paragraphReviews.map((item) => item.revisedText))
      .toEqual(["甲。", "乙。", "丙。", "丁。", "戊。"]);
  });

  it("句子不够五段时按字均分，短到无法覆盖则保持原样", () => {
    expect(splitEssayIntoReviewParagraphs(["甲乙丙丁戊"], 5)).toEqual(["甲", "乙", "丙", "丁", "戊"]);
    const tiny = report(["甲"], ["旧一", "旧二"]);
    expect(splitEssayIntoReviewParagraphs(["甲"], 2)).toBeNull();
    expect(essayDiffersFromParagraphReviews(tiny)).toBe(true);
    expect(applyEssayToParagraphReviews(tiny)).toBe(tiny);
  });

  it("结构段范围在覆盖改后全段时保留", () => {
    const source = report(["前两段改后。", "结尾。"], ["旧前段。", "旧结尾。"]);
    source.paragraphReviews[0] = {
      ...source.paragraphReviews[0]!,
      sourceParagraphStart: 1,
      sourceParagraphEnd: 2,
    };
    source.paragraphReviews[1] = {
      ...source.paragraphReviews[1]!,
      paragraphId: "paragraph-3",
      sourceParagraphStart: 3,
      sourceParagraphEnd: 3,
    };
    const synced = applyEssayToParagraphReviews(source);
    expect(synced.paragraphReviews[0]).toMatchObject({
      sourceParagraphStart: 1,
      sourceParagraphEnd: 2,
      revisedText: "前两段改后。",
    });
    expect(synced.paragraphReviews[1]).toMatchObject({
      paragraphId: "paragraph-3",
      revisedText: "结尾。",
    });
  });
});

describe("结构归组后的双向同步", () => {
  function grouped(essay: string[], revised: string[]) {
    const source = report(essay, revised);
    source.paragraphReviews = source.paragraphReviews.map((review, index) => ({
      ...review,
      sourceParagraphStart: index + 1,
      sourceParagraphEnd: index + 1,
    }));
    return source;
  }

  it("改第 n 段时两边写成同一份文字，未改的旧差异保持原样", () => {
    const source = grouped(["范文甲。", "范文乙。"], ["旧甲。", "旧乙。"]);
    expect(structureGroupsShareEssay(source)).toBe(true);
    expect(writeGroupedParagraphText(source, 0, "新甲。")).toMatchObject({
      rewrittenEssay: ["新甲。", "范文乙。"],
      paragraphReviews: [
        { revisedText: "新甲。" },
        { revisedText: "旧乙。" },
      ],
    });
    expect(writeGroupedParagraphText(source, 1, "新乙。").paragraphReviews.map((item) => item.revisedText))
      .toEqual(["旧甲。", "新乙。"]);
    expect(writeGroupedParagraphText(source, 1, "新乙。").rewrittenEssay).toEqual(["范文甲。", "新乙。"]);
  });

  it("没有结构归组或段数不同时不改写任何一边", () => {
    const ungrouped = report(["范文甲。", "范文乙。"], ["旧甲。", "旧乙。"]);
    expect(structureGroupsShareEssay(ungrouped)).toBe(false);
    expect(writeGroupedParagraphText(ungrouped, 0, "新甲。")).toBe(ungrouped);
    const uneven = grouped(["只有一段。"], ["旧甲。", "旧乙。"]);
    expect(structureGroupsShareEssay(uneven)).toBe(false);
    expect(writeGroupedParagraphText(uneven, 0, "新甲。")).toBe(uneven);
  });
});

describe("历史已审核作文修复", () => {
  const essay = ["开篇改后。", "抑。", "扬。", "真相。", "结尾。"];

  it("只改已审核且改后全段与范文不一致的作文", () => {
    const mismatched = report(essay, ["开篇。", "抑。", "扬。", "真相。", "结尾。"]);
    const repair = planReviewedEssayRepair({
      id: "review-1",
      studentName: "王若宁",
      title: "为自己鼓掌",
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
      report: mismatched,
    });
    expect(repair?.report.paragraphReviews.map((item) => item.revisedText)).toEqual(essay);
    expect(planReviewedEssayRepair({
      id: "review-2",
      studentName: "张小明",
      title: "为自己鼓掌",
      teacherReviewedAt: null,
      report: mismatched,
    })).toBeNull();
    expect(planReviewedEssayRepair({
      id: "review-3",
      studentName: "张小明",
      title: "为自己鼓掌",
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
      deletingAt: "2026-08-23T06:00:00.000Z",
      report: mismatched,
    })).toBeNull();
    expect(planReviewedEssayRepair({
      id: "review-4",
      studentName: "张小明",
      title: "为自己鼓掌",
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
      report: report(essay, essay),
    })).toBeNull();
    expect(planReviewedEssayRepair({
      id: "review-5",
      studentName: "张小明",
      title: "为自己鼓掌",
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
      report: { sampleParagraphs: [{ title: "示例", text: "旧正文", suggestion: "补充" }] },
    })).toBeNull();
  });
});
