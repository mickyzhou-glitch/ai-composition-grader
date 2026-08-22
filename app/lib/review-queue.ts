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
