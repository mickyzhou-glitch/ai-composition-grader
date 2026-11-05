import { mergedParagraphAction, UNCHANGED_PARAGRAPH_ACTION } from "../domain/paragraph-actions";
import { buildSentenceRevisionRuns, type RevisionRun, type RevisionUnderline } from "./revision-diff";

/**
 * 改后全段按「第 N 条修改动作」划不同线（家奇 2026-11-05）：
 * 第 1 条波浪线、第 2 条双横线、第 3 条单横线，超过 3 条从头循环。
 */
export const ADVICE_UNDERLINE_CYCLE: readonly RevisionUnderline[] = ["wave", "double", "single"];

export function adviceUnderlineStyle(actionIndex: number): RevisionUnderline {
  return ADVICE_UNDERLINE_CYCLE[actionIndex % ADVICE_UNDERLINE_CYCLE.length]!;
}

/** 网页预览/打印页用的 CSS text-decoration-style，与 Word/PDF 导出一致。 */
export const PREVIEW_UNDERLINE_STYLE: Record<RevisionUnderline, "wavy" | "double" | "solid"> = {
  wave: "wavy",
  double: "double",
  single: "solid",
};

type SuggestionLike = { advice: string; revisedQuotes?: readonly string[] };

const NUMBER_MARKER = /(\d{1,2})\s*[.、．)）]\s*/gu;

/**
 * 把一个框里的修改动作拆成逐条。支持「1. …\n2. …」分行，也容忍同一行「1. … 2. …」。
 * 编号必须从 1 起连续递增；不是编号列表时整段算 1 条；「本段无需修改」算 0 条。
 */
export function splitParagraphActions(advice: string): string[] {
  const text = advice.trim();
  if (!text || text === UNCHANGED_PARAGRAPH_ACTION) return [];
  const starts: Array<{ index: number; bodyStart: number }> = [];
  let expected = 1;
  for (const match of text.matchAll(NUMBER_MARKER)) {
    const index = match.index;
    if (Number(match[1]) !== expected) continue;
    const before = index === 0 ? "" : text[index - 1]!;
    if (index !== 0 && !/[\s。；;！!？?]/u.test(before)) continue;
    if (expected === 1 && index !== 0) break;
    starts.push({ index, bodyStart: index + match[0].length });
    expected += 1;
  }
  if (starts.length < 2) return [text];
  return starts.map((start, position) => (
    text.slice(start.bodyStart, starts[position + 1]?.index ?? text.length).trim()
  ));
}

/** 本段所有修改动作（多条 suggestion 先按导出口径合并编号再拆）。 */
export function paragraphActions(suggestions: readonly SuggestionLike[]): string[] {
  return splitParagraphActions(mergedParagraphAction(suggestions));
}

/** 按动作顺序拼出的定位摘录；任何一条 suggestion 缺字段即视为没有（退回旧口径）。 */
function collectQuotes(suggestions: readonly SuggestionLike[]): string[] | null {
  if (suggestions.length === 0 || suggestions.some((suggestion) => !Array.isArray(suggestion.revisedQuotes))) {
    return null;
  }
  return suggestions.flatMap((suggestion) => suggestion.revisedQuotes ?? []).map((quote) => quote.trim());
}

type QuoteRange = { start: number; end: number; actionIndex: number };

/**
 * 在改后全段里依次定位每条摘录（逐字子串、互不重叠）。
 * 条数与动作数不符、有摘录找不到、或一条都没有时返回 null。
 */
export function locateRevisedQuotes(
  revisedText: string,
  suggestions: readonly SuggestionLike[],
): QuoteRange[] | null {
  const quotes = collectQuotes(suggestions);
  if (!quotes) return null;
  if (quotes.length !== paragraphActions(suggestions).length) return null;
  const ranges: QuoteRange[] = [];
  for (const [actionIndex, quote] of quotes.entries()) {
    if (!quote) continue;
    let offset = revisedText.indexOf(quote);
    while (offset >= 0 && ranges.some((range) => offset < range.end && offset + quote.length > range.start)) {
      offset = revisedText.indexOf(quote, offset + 1);
    }
    if (offset < 0) return null;
    ranges.push({ start: offset, end: offset + quote.length, actionIndex });
  }
  if (ranges.length === 0) return null;
  return ranges.sort((left, right) => left.start - right.start);
}

/** 新报告落库前：摘录与 revisedText / 动作条数对不上就整条删掉，渲染时退回单下划线。 */
export function sanitizeRevisedQuotes<T extends { suggestions: SuggestionLike[]; revisedText: string }>(review: T): T {
  if (!review.suggestions.some((suggestion) => suggestion.revisedQuotes !== undefined)) return review;
  if (locateRevisedQuotes(review.revisedText, review.suggestions)) return review;
  return {
    ...review,
    suggestions: review.suggestions.map((suggestion) => {
      const { revisedQuotes: _dropped, ...rest } = suggestion;
      void _dropped;
      return rest;
    }),
  };
}

/**
 * 改后全段下划线：有可靠摘录时按动作序号划波浪/双线/单线，未改动和未摘录的句子不划线；
 * 否则退回「相对原文改动的句子一律单下划线」。拼接后的文字始终等于 revisedText。
 */
export function buildAdviceRevisionRuns(
  sourceText: string,
  revisedText: string,
  suggestions: readonly SuggestionLike[],
): RevisionRun[] {
  const ranges = locateRevisedQuotes(revisedText, suggestions);
  if (!ranges) {
    return buildSentenceRevisionRuns(sourceText, revisedText).map((run) => (
      run.kind === "inserted" ? { ...run, underline: "single" as const } : run
    ));
  }
  const runs: RevisionRun[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) runs.push({ kind: "unchanged", text: revisedText.slice(cursor, range.start) });
    runs.push({
      kind: "inserted",
      text: revisedText.slice(range.start, range.end),
      underline: adviceUnderlineStyle(range.actionIndex),
      actionIndex: range.actionIndex,
    });
    cursor = range.end;
  }
  if (cursor < revisedText.length) runs.push({ kind: "unchanged", text: revisedText.slice(cursor) });
  return runs;
}

/** 给模型的摘录规则（首轮批改、返修、单段重写共用）。 */
export const REVISED_QUOTES_RULE = "suggestions 里同时返回 revisedQuotes 数组：按 advice 的编号顺序，每条修改动作对应一项，内容是该动作在本段 revisedText 里落实后的那一句或连续几句，必须从 revisedText 逐字复制（含标点），不得改写、缩写或拼接不相邻的句子；各项互不重叠。advice 只有一条动作时 revisedQuotes 只有一项；动作在正文里没有可定位的句子（如删除）时该项写空字符串 \"\"；advice 为「本段无需修改」时 revisedQuotes 为 []。导出时第 1 条动作的摘录划波浪线、第 2 条双横线、第 3 条单横线，未摘录的句子不划线。";
