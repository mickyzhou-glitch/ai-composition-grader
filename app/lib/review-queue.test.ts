import { describe, expect, it } from "vitest";

import { filterReviewsByStudentName, normalizeStudentSearch } from "./review-queue";

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
});
