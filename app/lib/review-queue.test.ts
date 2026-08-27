import { describe, expect, it } from "vitest";

import {
  exportEligibility,
  filterReviewsByStudentName,
  isReviewedPendingExport,
  normalizeStudentSearch,
  reviewDisplayStatus,
  reviewPrefetchWindow,
} from "./review-queue";

describe("review queue helpers", () => {
  it("normalizes whitespace and letter case for student-name search", () => {
    expect(normalizeStudentSearch("  zHANG ")).toBe("zhang");
    expect(filterReviewsByStudentName([
      { id: "review-zhang", studentName: "Zhang Wei", title: "礼物" },
      { id: "review-li", studentName: "李安然", title: "Zhang 的故事" },
    ], "  zHANG ").map(({ id }) => id)).toEqual(["review-zhang"]);
  });

  it("returns every item for an empty query", () => {
    const reviews = [{ id: "review-1", studentName: "张小明" }];
    expect(filterReviewsByStudentName(reviews, "   ")).toEqual(reviews);
  });

  it("returns the current item and next two items as the prefetch window", () => {
    expect(reviewPrefetchWindow(["a", "b", "c", "d"], "b")).toEqual(["b", "c", "d"]);
    expect(reviewPrefetchWindow(["a", "b"], "missing")).toEqual([]);
  });

  it("uses the shared paragraph-delivery gate for export", () => {
    const paragraphReview = {
      report: {
        version: 2 as const,
        themeFit: "fits" as const, themeReason: "切题", personalizedComment: "真实",
        painPoints: [], commonIssues: [], revisionSuggestions: [], grade: "A" as const,
        diagnostics: {
          authenticityAndRelevance: { finding: "真实", action: "保留" },
          materialAndDetails: { finding: "具体", action: "保留" },
          structure: { finding: "完整", action: "保留" },
          language: { finding: "通顺", action: "保留" },
        },
        paragraphReviews: [{
          paragraphId: "paragraph-1",
          suggestions: [{ problem: "保留", advice: "保留", example: "自然" }],
          revisedText: "原文。",
        }],
        parentFeedbacks: [] as [],
      },
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
      reportStale: false,
      ocr: {
        version: 2 as const, ocrRevision: 0, editedAt: null,
        pages: [{ pageIndex: 0, text: "原文。", readable: true, warnings: [] }],
        paragraphs: [{
          id: "paragraph-1", paragraphIndex: 0, text: "原文。",
          segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.2 }],
        }],
      },
      images: [{
        id: 1, position: 0, originalName: "a.jpg", mimeType: "image/jpeg",
        width: 1000, height: 1500, rotation: 0 as const, crop: null,
      }],
    };
    expect(exportEligibility(paragraphReview)).toEqual({ eligible: true });
    expect(exportEligibility({ ...paragraphReview, teacherReviewedAt: null })).toMatchObject({ eligible: false });
    expect(exportEligibility({ ...paragraphReview, report: null })).toMatchObject({ eligible: false });
  });

  it("只把已复核且未导出的记录归入已复核状态", () => {
    const reviewed = { status: "ready_for_review" as const, teacherReviewedAt: "2026-08-22T06:00:00.000Z" };
    const pending = { status: "ready_for_review" as const, teacherReviewedAt: null };
    const exported = { status: "exported" as const, teacherReviewedAt: "2026-08-22T06:00:00.000Z" };

    expect(isReviewedPendingExport(reviewed)).toBe(true);
    expect(reviewDisplayStatus(reviewed)).toBe("reviewed");
    expect(isReviewedPendingExport(pending)).toBe(false);
    expect(reviewDisplayStatus(pending)).toBe("ready_for_review");
    expect(isReviewedPendingExport(exported)).toBe(false);
    expect(reviewDisplayStatus(exported)).toBe("exported");
  });
});
