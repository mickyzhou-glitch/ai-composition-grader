type Classified = { className?: string };

export function classNames(items: Classified[]): string[] {
  return [...new Set(items.map((item) => item.className ?? "").filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
}

export function filterReviewsByClass<T extends Classified>(items: T[], selected: string | null): T[] {
  return selected === null ? items : items.filter((item) => (item.className ?? "") === selected);
}
