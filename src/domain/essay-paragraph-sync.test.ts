import { describe, expect, it } from "vitest";

import { paragraphEvaluationReportSchema, type ParagraphEvaluationReport } from "./contracts";
import { paragraphReviewCoverageMessage } from "./paragraph-review-groups";
import {
  applyEssayToParagraphReviews,
  deriveEssayFromParagraphReviews,
  essayDiffersFromParagraphReviews,
  splitEssayIntoReviewParagraphs,
  syncEssayBeforeApproval,
  syncEssayFromParagraphReviews,
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

  it("范文只有两段、逐段有五框时，同步到逐段按范文改成两段", () => {
    const essay = ["甲。乙。丙。", "丁。戊。"];
    expect(splitEssayIntoReviewParagraphs(essay, 5)).toEqual(["甲。", "乙。", "丙。", "丁。", "戊。"]);
    const source = report(essay, ["旧一", "旧二", "旧三", "旧四", "旧五"]);
    expect(applyEssayToParagraphReviews(source)).toBe(source);
    const ids = ["paragraph-1", "paragraph-2", "paragraph-3", "paragraph-4", "paragraph-5"];
    const synced = applyEssayToParagraphReviews(source, ids);
    expect(synced.paragraphReviews.map((item) => item.revisedText)).toEqual(essay);
    expect(synced.paragraphReviews.map((item) => [item.sourceParagraphStart, item.sourceParagraphEnd]))
      .toEqual([[1, 3], [4, 5]]);
    expect(essayDiffersFromParagraphReviews(synced)).toBe(false);
  });

  it("原文段数少于范文时，同步到逐段仍按范文段数，多出的段标为原文无对应段", () => {
    const essay = ["一。", "二。", "三。", "四。", "五。"];
    const source = report(essay, ["旧一", "旧二", "旧三", "旧四"]);
    const ids = ["paragraph-1", "paragraph-2", "paragraph-3", "paragraph-4"];
    const synced = applyEssayToParagraphReviews(source, ids);
    expect(synced.paragraphReviews.map((item) => item.revisedText)).toEqual(essay);
    expect(synced.paragraphReviews.map((item) => item.noSourceParagraph ?? false))
      .toEqual([false, false, true, false, false]);
    expect(paragraphReviewCoverageMessage(synced.paragraphReviews, ids)).toBeNull();
    expect(paragraphEvaluationReportSchema.safeParse(synced).success).toBe(true);
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

  it("审核通过前以 paragraphReviews[].revisedText 为唯一编辑源刷新 rewrittenEssay，绝不反向覆盖", () => {
    const oldEssay = ["旧范文一。", "旧范文二。", "旧范文三。"];
    const teacherRevised = ["老师改后一。", "老师改后二。"];
    const ocr = { paragraphs: [{ id: "paragraph-2", paragraphIndex: 1 }, { id: "paragraph-1", paragraphIndex: 0 }] };
    const source = report(oldEssay, teacherRevised);
    expect(deriveEssayFromParagraphReviews(source.paragraphReviews)).toEqual(teacherRevised);
    const synced = syncEssayBeforeApproval(source, ocr);
    expect(synced).toEqual(syncEssayFromParagraphReviews(source));
    expect(synced.paragraphReviews.map((item) => item.revisedText)).toEqual(teacherRevised);
    expect(synced.rewrittenEssay).toEqual(teacherRevised);
    expect(syncEssayBeforeApproval(synced, ocr)).toBe(synced);
    const same = report(teacherRevised, teacherRevised);
    expect(syncEssayBeforeApproval(same, ocr)).toBe(same);
    expect(syncEssayBeforeApproval(report(oldEssay, ["甲", "乙", "丙"]), null)).toMatchObject({
      rewrittenEssay: ["甲", "乙", "丙"],
      paragraphReviews: [
        expect.objectContaining({ revisedText: "甲" }),
        expect.objectContaining({ revisedText: "乙" }),
        expect.objectContaining({ revisedText: "丙" }),
      ],
    });
  });
});
