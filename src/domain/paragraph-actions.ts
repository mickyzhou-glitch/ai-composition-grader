export const UNCHANGED_PARAGRAPH_ACTION = "本段无需修改";

/** One box per paragraph: several actions become one numbered list. */
export function mergedParagraphAction(suggestions: readonly { advice: string }[]): string {
  const lines = suggestions
    .map((suggestion) => suggestion.advice.trim())
    .filter((advice) => advice.length > 0);
  if (lines.length === 0) return UNCHANGED_PARAGRAPH_ACTION;
  if (lines.length === 1) return lines[0];
  return lines.map((advice, index) => `${index + 1}. ${advice}`).join("\n");
}

export function collapseParagraphSuggestions<T extends { advice: string; revisedQuotes?: Array<string | string[]> }>(
  suggestions: readonly T[],
): T[] {
  if (suggestions.length <= 1) return [...suggestions];
  const { revisedQuotes: _first, ...first } = suggestions[0]!;
  void _first;
  // 合并编号后摘录按同样顺序拼接；有一条缺摘录就整体不带，渲染时退回单下划线。
  const quotes = suggestions.every((suggestion) => Array.isArray(suggestion.revisedQuotes))
    ? suggestions.flatMap((suggestion) => suggestion.revisedQuotes ?? [])
    : undefined;
  return [{
    ...first,
    advice: mergedParagraphAction(suggestions),
    ...(quotes ? { revisedQuotes: quotes } : {}),
  } as T];
}
