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

export function exportEligibility(review: {
  report: unknown | null;
  teacherReviewedAt: string | null;
}): { eligible: true } | { eligible: false; reason: string } {
  if (!review.report) return { eligible: false, reason: "批改报告尚未完成" };
  if (!review.teacherReviewedAt) return { eligible: false, reason: "尚未经过老师审核" };
  return { eligible: true };
}
