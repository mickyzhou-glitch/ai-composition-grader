import type { ReviewStatus } from "@/src/domain/contracts";
import { deliveryReadiness } from "@/src/delivery/readiness";
import type { ReviewView } from "./types";

export type ReviewDisplayStatus = ReviewStatus | "reviewed";

type ReviewLifecycleFields = Pick<ReviewView, "status" | "teacherReviewedAt">;

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

export function exportEligibility(
  review: Pick<ReviewView, "report" | "teacherReviewedAt" | "reportStale" | "ocr" | "images">,
): { eligible: true } | { eligible: false; reason: string } {
  const readiness = deliveryReadiness(review);
  return readiness.ready
    ? { eligible: true }
    : { eligible: false, reason: readiness.message };
}
