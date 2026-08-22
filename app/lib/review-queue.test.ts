import { describe, expect, it } from "vitest";

import { exportEligibility, filterReviewsByStudentName, normalizeStudentSearch, reviewPrefetchWindow } from "./review-queue";

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
});
