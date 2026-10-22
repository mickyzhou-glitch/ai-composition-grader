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

export function collapseParagraphSuggestions<T extends { advice: string }>(
  suggestions: readonly T[],
): T[] {
  if (suggestions.length <= 1) return [...suggestions];
  return [{ ...suggestions[0], advice: mergedParagraphAction(suggestions) }];
}
