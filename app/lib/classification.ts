type Classified = { className?: string };
type Titled = { config?: { title?: string }; title?: string };

export function classNames(items: Classified[], extraClasses: readonly string[] = []): string[] {
  return [...new Set([
    ...items.map((item) => item.className ?? ""),
    ...extraClasses,
  ].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
}

export function filterReviewsByClass<T extends Classified>(items: T[], selected: string | null): T[] {
  return selected === null ? items : items.filter((item) => (item.className ?? "") === selected);
}

function itemTitle(item: Titled): string {
  return (item.config?.title ?? item.title ?? "").trim();
}

export function titleNames(items: Titled[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const item of items) {
    const title = itemTitle(item);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    ordered.push(title);
  }
  return ordered;
}

export function filterReviewsByTitle<T extends Titled>(items: T[], selected: string | null): T[] {
  return selected === null ? items : items.filter((item) => itemTitle(item) === selected);
}
