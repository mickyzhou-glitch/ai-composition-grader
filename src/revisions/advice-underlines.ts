import { mergedParagraphAction, UNCHANGED_PARAGRAPH_ACTION } from "../domain/paragraph-actions";
import { buildSubstantiveSentenceRuns, type RevisionRun, type RevisionUnderline } from "./revision-diff";

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
 * 条数与动作数不符、或有摘录找不到时返回 null。
 * 摘录全为空（本段无需修改、只有删除动作）时返回空数组：可靠且无句可划。
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
 * 否则退回「相对原文实质改动的句子单下划线」（只改错字、语病、标点的句子不划）。
 * 拼接后的文字始终等于 revisedText。
 */
export function buildAdviceRevisionRuns(
  sourceText: string,
  revisedText: string,
  suggestions: readonly SuggestionLike[],
): RevisionRun[] {
  const ranges = locateRevisedQuotes(revisedText, suggestions);
  if (!ranges) {
    return buildSubstantiveSentenceRuns(sourceText, revisedText).map((run) => (
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

/**
 * 修改动作口径（家奇 2026-11-08）：动作 = 学生原文 → 最终范文的实质差异。
 * 首轮批改、结构返修、字数返修、单段重写共用，保证每次改写正文后都按原文重新核对。
 */
export const ADVICE_ACTIONS_RULE = [
  "修改动作（suggestions.advice）的口径：逐句核对这一段的学生原文（归组段按 sourceParagraphStart–sourceParagraphEnd 对应的全部原文段）和本段最终 revisedText 哪里不一样，只写范文相对学生原文做了哪些实质修改：补写或扩写了什么、删去了原文哪些内容、把原文哪句改成了什么意思、调整了哪些顺序或详略、加了什么过渡或伏笔。",
  "每条写成简短的动作短语，例如「简单解释名言并点出英语老师」「用一句伏笔点到“原先对她的印象”即可，不写具体的事件」；多条用「1. 」「2. 」分行编号。",
  "不写：错别字、语病、标点、用词微调等基础修改；与原文意思基本相同的句子；「保留……」这类没有改动的内容；修改理由或解释；相对上一版底稿、复核意见或返修过程改了什么。advice 只描述学生原文到最终范文的差异，每次重写 revisedText 后都要按这个口径重新核对并重写 advice。",
  "整段只有基础修改、没有实质改动时，advice 写「本段无需修改」。",
].join("");

/** 给模型的摘录规则（首轮批改、返修、单段重写共用）。 */
export const REVISED_QUOTES_RULE = "suggestions 里同时返回 revisedQuotes 数组：按 advice 的编号顺序，每条修改动作对应一项，内容是该动作在本段 revisedText 里落实后的那一句或连续几句，必须从 revisedText 逐字复制（含标点），不得改写、缩写或拼接不相邻的句子；各项互不重叠。只摘实质修改落实的句子：与学生原文相同、意思基本相同或只修了错字语病标点的句子不摘。advice 只有一条动作时 revisedQuotes 只有一项；动作在正文里没有可定位的句子（如删除）时该项写空字符串 \"\"；advice 为「本段无需修改」时 revisedQuotes 为 []。导出时第 1 条动作的摘录划波浪线、第 2 条双横线、第 3 条单横线，未摘录的句子不划线。";
