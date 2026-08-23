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

  it("requires a report and teacher review timestamp for export", () => {
    expect(exportEligibility({ report: {}, teacherReviewedAt: "2026-08-22T06:00:00.000Z" })).toEqual({ eligible: true });
    expect(exportEligibility({ report: {}, teacherReviewedAt: null })).toMatchObject({ eligible: false });
    expect(exportEligibility({ report: null, teacherReviewedAt: "2026-08-22T06:00:00.000Z" })).toMatchObject({ eligible: false });
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
