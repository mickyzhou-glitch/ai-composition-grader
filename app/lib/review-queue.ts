import { gradeFromLegacyTotal, isLegacyEvaluationReport, type ReviewStatus } from "@/src/domain/contracts";
import { deliveryReadiness } from "@/src/delivery/readiness";
import type { ReviewSummaryView, ReviewView } from "./types";

export type ReviewDisplayStatus = ReviewStatus | "reviewed";

type ReviewLifecycleFields = Pick<ReviewView, "status" | "teacherReviewedAt"> & {
  report?: unknown;
  hasReport?: boolean;
};

/**
 * 审核失败：分析失败（含保留旧报告但最新一次分析失败，状态即 failed），
 * 或分析结束却没有可用报告。审核不通过（rejected）不算在内。
 */
export function isReviewFailed(review: ReviewLifecycleFields): boolean {
  if (review.status === "failed") return true;
  if (review.status !== "ready_for_review") return false;
  if (typeof review.hasReport === "boolean") return !review.hasReport;
  return "report" in review && review.report == null;
}

export function normalizeStudentSearch(value: string): string {
  return value.trim().toLocaleLowerCase("zh-CN");
}

export function filterReviewsByStudentName<T extends { studentName: string }>(
  items: T[],
  query: string,
): T[] {
  const normalized = normalizeStudentSearch(query);
  return normalized
    ? items.filter(({ studentName }) => normalizeStudentSearch(studentName).includes(normalized))
    : items;
}

export function reviewPrefetchWindow(ids: string[], activeId: string | null): string[] {
  if (!activeId) return [];
  const index = ids.indexOf(activeId);
  return index < 0 ? [] : ids.slice(index, index + 3);
}

export function isReviewedPendingExport(review: ReviewLifecycleFields): boolean {
  return Boolean(review.teacherReviewedAt) && review.status !== "exported";
}

export function reviewDisplayStatus(review: ReviewLifecycleFields): ReviewDisplayStatus {
  return isReviewedPendingExport(review) ? "reviewed" : review.status;
}

export type HistoryStatusFilter = "" | "draft" | "review" | "failed" | "reviewed" | "exported" | "rejected";

export function matchesHistoryStatus(
  review: ReviewLifecycleFields,
  filter: HistoryStatusFilter,
): boolean {
  if (filter === "") return true;
  if (filter === "draft") return review.status === "draft";
  if (filter === "review") {
    return !review.teacherReviewedAt
      && !isReviewFailed(review)
      && ["analyzing", "needs_better_images", "ready_for_review"].includes(review.status);
  }
  if (filter === "failed") return isReviewFailed(review);
  if (filter === "reviewed") return isReviewedPendingExport(review);
  if (filter === "exported") return review.status === "exported";
  return review.status === "rejected";
}

export function exportEligibility(
  review:
    | (Pick<ReviewView, "report" | "teacherReviewedAt" | "reportStale" | "ocr" | "images"> & { status?: ReviewStatus })
    | Pick<ReviewSummaryView, "exportEligibility" | "status">,
): { eligible: true } | { eligible: false; reason: string } {
  if (review.status === "rejected") {
    return { eligible: false, reason: "审核不通过的作文不能导出" };
  }
  if ("exportEligibility" in review && review.exportEligibility) {
    return review.exportEligibility;
  }
  const fullReview = review as Pick<ReviewView, "report" | "teacherReviewedAt" | "reportStale" | "ocr" | "images">;
  const readiness = deliveryReadiness({
    ...fullReview,
    images: fullReview.images ?? [],
  });
  return readiness.ready
    ? { eligible: true }
    : { eligible: false, reason: readiness.message };
}

export function toReviewSummary(review: ReviewView): ReviewSummaryView {
  const hasReport = review.report !== null && review.report !== undefined;
  const legacy = Boolean(review.report && isLegacyEvaluationReport(review.report));
  const grade = review.report
    ? (review.report.grade ?? (legacy ? gradeFromLegacyTotal(review.report.scores?.total ?? 0) : null))
    : null;
  const rawDiag = review.report?.diagnostics;
  const diagnostics = rawDiag?.authenticityAndRelevance && rawDiag?.structure
    ? {
        authenticityAndRelevance: rawDiag.authenticityAndRelevance,
        structure: rawDiag.structure,
      }
    : null;
  return {
    id: review.id,
    status: review.status,
    studentName: review.studentName ?? "",
    className: review.className ?? "",
    config: { title: review.config.title },
    revision: review.revision ?? 0,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt ?? review.createdAt,
    teacherReviewedAt: review.teacherReviewedAt ?? null,
    hasReport,
    isLegacyReport: legacy,
    grade,
    ...(diagnostics ? { diagnostics } : {}),
    hasPdf: Boolean(review.hasPdf),
    pdfFilename: review.pdfFilename ?? null,
    exportEligibility: exportEligibility({
      status: review.status,
      report: review.report ?? null,
      teacherReviewedAt: review.teacherReviewedAt ?? null,
      reportStale: Boolean(review.reportStale),
      ocr: review.ocr ?? null,
      images: review.images ?? [],
    }),
    ...(review.analysisFailure ? { analysisFailure: review.analysisFailure } : {}),
  };
}
