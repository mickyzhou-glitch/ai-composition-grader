import { describe, expect, it } from "vitest";

import {
  BATCH_REANALYSIS_LIMIT,
  MAX_ANALYSIS_TEACHER_GUIDANCE_CHARS,
  MAX_REVISION_FIELD_CHARS,
  REANALYSIS_SKIP_REASONS,
  batchReanalysisCommitInputSchema,
  batchReanalysisPreviewInputSchema,
  formatRevisionTeacherGuidance,
  normalizeAssignmentTitle,
  revisionRequestInputSchema,
} from "./contracts";

describe("reanalysis contracts", () => {
  it("formats two maximum-length revision fields within the internal guidance limit", () => {
    const reason = "原".repeat(MAX_REVISION_FIELD_CHARS);
    const changeRequest = "改".repeat(MAX_REVISION_FIELD_CHARS);

    const guidance = formatRevisionTeacherGuidance(reason, changeRequest);

    expect(guidance).toBe(`[不合适原因]\n${reason}\n[修改要求]\n${changeRequest}`);
    expect(guidance).toContain("[不合适原因]\n");
    expect(guidance).toContain("\n[修改要求]\n");
    expect(guidance.length).toBeLessThanOrEqual(MAX_ANALYSIS_TEACHER_GUIDANCE_CHARS);
    expect(MAX_ANALYSIS_TEACHER_GUIDANCE_CHARS).toBe(1_100);
  });

  it.each(["reason", "changeRequest"] as const)("rejects blank and oversized %s", (field) => {
    const base = { expectedRevision: 0, reason: "原因", changeRequest: "要求" };

    expect(revisionRequestInputSchema.safeParse({ ...base, [field]: "   " }).success).toBe(false);
    expect(revisionRequestInputSchema.safeParse({
      ...base,
      [field]: "字".repeat(MAX_REVISION_FIELD_CHARS + 1),
    }).success).toBe(false);
  });

  it("trims revision fields and rejects unknown fields", () => {
    expect(revisionRequestInputSchema.parse({
      expectedRevision: 3,
      reason: "  原因  ",
      changeRequest: "  要求  ",
    })).toEqual({ expectedRevision: 3, reason: "原因", changeRequest: "要求" });
    expect(revisionRequestInputSchema.safeParse({
      expectedRevision: 3,
      reason: "原因",
      changeRequest: "要求",
      extra: true,
    }).success).toBe(false);
  });

  it("normalizes assignment titles by trimming only", () => {
    expect(normalizeAssignmentTitle("  My  Essay  ")).toBe("My  Essay");
    expect(normalizeAssignmentTitle("  ABC abc  ")).toBe("ABC abc");
  });

  it("accepts one through twenty unique safe review ids for preview", () => {
    expect(BATCH_REANALYSIS_LIMIT).toBe(20);
    expect(batchReanalysisPreviewInputSchema.parse({ reviewIds: ["review-1"] })).toEqual({
      reviewIds: ["review-1"],
    });
    expect(batchReanalysisPreviewInputSchema.safeParse({
      reviewIds: Array.from({ length: BATCH_REANALYSIS_LIMIT }, (_, index) => `review_${index}`),
    }).success).toBe(true);
  });

  it("rejects invalid preview counts, duplicate ids, unsafe ids, and unknown fields", () => {
    expect(batchReanalysisPreviewInputSchema.safeParse({ reviewIds: [] }).success).toBe(false);
    expect(batchReanalysisPreviewInputSchema.safeParse({
      reviewIds: Array.from({ length: BATCH_REANALYSIS_LIMIT + 1 }, (_, index) => `review-${index}`),
    }).success).toBe(false);
    const duplicate = batchReanalysisPreviewInputSchema.safeParse({
      reviewIds: ["review-1", "review-1"],
    });
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) {
      expect(duplicate.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: "review ids must be unique" }),
      ]));
    }
    expect(batchReanalysisPreviewInputSchema.safeParse({ reviewIds: ["unsafe id"] }).success).toBe(false);
    expect(batchReanalysisPreviewInputSchema.safeParse({ reviewIds: ["review-1"], extra: true }).success).toBe(false);
  });

  it("accepts strict commit items and preserves their values", () => {
    const item = {
      reviewId: "review-1",
      expectedRevision: 2,
      assignmentId: "assignment_1",
      expectedAssignmentUpdatedAt: "2026-08-22T01:02:03.000Z",
    };

    expect(batchReanalysisCommitInputSchema.parse({ items: [item] })).toEqual({ items: [item] });
    expect(batchReanalysisCommitInputSchema.safeParse({
      items: Array.from({ length: BATCH_REANALYSIS_LIMIT }, (_, index) => ({
        ...item,
        reviewId: `review-${index}`,
      })),
    }).success).toBe(true);
  });

  it("rejects invalid commit counts, duplicate review ids, and invalid item fields", () => {
    const item = {
      reviewId: "review-1",
      expectedRevision: 2,
      assignmentId: "assignment-1",
      expectedAssignmentUpdatedAt: "2026-08-22T01:02:03.000Z",
    };
    expect(batchReanalysisCommitInputSchema.safeParse({ items: [] }).success).toBe(false);
    expect(batchReanalysisCommitInputSchema.safeParse({
      items: Array.from({ length: BATCH_REANALYSIS_LIMIT + 1 }, (_, index) => ({
        ...item,
        reviewId: `review-${index}`,
      })),
    }).success).toBe(false);
    expect(batchReanalysisCommitInputSchema.safeParse({
      items: [item],
      extra: true,
    }).success).toBe(false);
    const duplicate = batchReanalysisCommitInputSchema.safeParse({ items: [item, { ...item }] });
    expect(duplicate.success).toBe(false);
    if (!duplicate.success) {
      expect(duplicate.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ message: "review ids must be unique" }),
      ]));
    }
    expect(batchReanalysisCommitInputSchema.safeParse({
      items: [{ ...item, reviewId: "unsafe id" }],
    }).success).toBe(false);
    expect(batchReanalysisCommitInputSchema.safeParse({
      items: [{ ...item, assignmentId: " unsafe" }],
    }).success).toBe(false);
    expect(batchReanalysisCommitInputSchema.safeParse({
      items: [{ ...item, expectedRevision: -1 }],
    }).success).toBe(false);
    expect(batchReanalysisCommitInputSchema.safeParse({
      items: [{ ...item, expectedRevision: 1.5 }],
    }).success).toBe(false);
    expect(batchReanalysisCommitInputSchema.safeParse({
      items: [{ ...item, expectedAssignmentUpdatedAt: "not-a-date" }],
    }).success).toBe(false);
    expect(batchReanalysisCommitInputSchema.safeParse({
      items: [{ ...item, extra: true }],
    }).success).toBe(false);
  });

  it("requires valid UTC datetimes for commit assignment versions", () => {
    const item = {
      reviewId: "review-1",
      expectedRevision: 2,
      assignmentId: "assignment-1",
      expectedAssignmentUpdatedAt: "2026-08-22T10:00:00Z",
    };

    expect(batchReanalysisCommitInputSchema.safeParse({ items: [item] }).success).toBe(true);
    expect(batchReanalysisCommitInputSchema.safeParse({
      items: [{ ...item, expectedAssignmentUpdatedAt: "2026-08-22T10:00:00" }],
    }).success).toBe(false);
    expect(batchReanalysisCommitInputSchema.safeParse({
      items: [{ ...item, expectedAssignmentUpdatedAt: "2026-08-22T10:00:00+08:00" }],
    }).success).toBe(false);
    expect(batchReanalysisCommitInputSchema.safeParse({
      items: [{ ...item, expectedAssignmentUpdatedAt: "2026-02-30T10:00:00Z" }],
    }).success).toBe(false);
  });

  it("exposes stable skip codes and reasons", () => {
    expect(REANALYSIS_SKIP_REASONS).toEqual({
      FRAMEWORK_NOT_FOUND: "没有找到同名的已保存题目框架",
      FRAMEWORK_CHANGED: "题目框架已更新，请重新预览",
      REVIEW_NOT_FOUND: "作文不存在或已不可用",
      REVISION_CONFLICT: "作文已更新，请重新预览",
      OCR_NOT_CURRENT: "识别原文不存在或已失效",
      ANALYSIS_ACTIVE: "作文正在分析中",
      REVIEW_UNAVAILABLE: "作文当前状态不能重新分析",
    });
  });
});
