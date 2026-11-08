import { mergedParagraphAction, UNCHANGED_PARAGRAPH_ACTION } from "../domain/paragraph-actions";
import { buildSubstantiveSentenceRuns, type RevisionRun, type RevisionUnderline } from "./revision-diff";

/**
 * 改后全段按「第 N 条修改动作」划不同线，修改动作本身也划同样的线，方便一一对应。
 * 线型顺序按家奇 2026-11-08 手改稿：第 1 条单线、第 2 条波浪线、第 3 条点划线，超过 3 条从头循环。
 */
export const ADVICE_UNDERLINE_CYCLE: readonly RevisionUnderline[] = ["single", "wave", "dotDotDash"];

export function adviceUnderlineStyle(actionIndex: number): RevisionUnderline {
  return ADVICE_UNDERLINE_CYCLE[actionIndex % ADVICE_UNDERLINE_CYCLE.length]!;
}

/** 网页预览/打印页用的 CSS text-decoration-style，与 Word/PDF 导出一致。 */
/** CSS 没有点划线，网页预览用虚线代替。 */
export const PREVIEW_UNDERLINE_STYLE: Record<RevisionUnderline, "wavy" | "dashed" | "solid"> = {
  single: "solid",
  wave: "wavy",
  dotDotDash: "dashed",
};

type SuggestionLike = { advice: string; revisedQuotes?: ReadonlyArray<string | readonly string[]> };

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

/**
 * 按动作顺序拼出的定位摘录，每条动作一组（一条动作可落在不相邻的几处）；
 * 任何一条 suggestion 缺字段即视为没有（退回旧口径）。
 */
function collectQuotes(suggestions: readonly SuggestionLike[]): string[][] | null {
  if (suggestions.length === 0 || suggestions.some((suggestion) => !Array.isArray(suggestion.revisedQuotes))) {
    return null;
  }
  return suggestions
    .flatMap((suggestion) => [...(suggestion.revisedQuotes ?? [])])
    .map((item) => (typeof item === "string" ? [item] : [...item]).map((quote) => quote.trim()).filter(Boolean));
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
  for (const [actionIndex, segments] of quotes.entries()) {
    for (const quote of segments) {
      let offset = revisedText.indexOf(quote);
      while (offset >= 0 && ranges.some((range) => offset < range.end && offset + quote.length > range.start)) {
        offset = revisedText.indexOf(quote, offset + 1);
      }
      if (offset < 0) return null;
      ranges.push({ start: offset, end: offset + quote.length, actionIndex });
    }
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
 * 每条修改动作该划的线型：摘录可靠且这条动作在改后全段里有落实句时，与那几句同线型；
 * 没有落实句（删除、调序）或摘录不可靠时为 null，动作不划线。
 */
export function adviceActionUnderlines(
  revisedText: string,
  suggestions: readonly SuggestionLike[],
): Array<RevisionUnderline | null> {
  const actions = paragraphActions(suggestions);
  const ranges = locateRevisedQuotes(revisedText, suggestions);
  return actions.map((_action, index) => (
    ranges?.some((range) => range.actionIndex === index) ? adviceUnderlineStyle(index) : null
  ));
}

/**
 * 改后全段下划线：有可靠摘录时按动作序号划单线/波浪线/点划线，未改动和未摘录的句子不划线；
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
  "每条写成简短的动作短语，例如「简单解释和点出英语老师」「用一句伏笔点到“原先对她的印象”即可，不写具体的事件」「增加雨停、阳光照进办公室的暖色环境描写，象征情感转折」「补充老师的语言、动作、神态，具体展现老师的温暖」；多条用「1. 」「2. 」分行编号，一般不超过 3 条。",
  "每条对应正文里一处具体修改，读者能在改后全段里找到落实它的句子（删除、调序除外）。同一处修改只写一次：不要另写一条总括性的动作去概括其他几条已写到的内容（例如已逐条写了过渡句、环境描写、语言动作神态，就不要再写「把原文第四段内容移到本段，详写老师讲题过程，放缓转变节奏」）。",
  "不写：错别字、语病、标点、用词微调等基础修改；与原文意思基本相同的句子；「保留……」这类没有改动的内容；句末附加的理由、目的说明或提醒（如「因为……」「使第一段只承担开头功能」「不刻意贬低老师」）；相对上一版底稿、复核意见或返修过程改了什么。advice 只描述学生原文到最终范文的差异，每次重写 revisedText 后都要按这个口径重新核对并重写 advice。",
  "整段只有基础修改、没有实质改动时，advice 写「本段无需修改」。",
].join("");

/** 给模型的摘录规则（首轮批改、返修、单段重写共用）。 */
export const REVISED_QUOTES_RULE = "suggestions 里同时返回 revisedQuotes 数组：按 advice 的编号顺序，每条修改动作对应一项，内容是该动作在本段 revisedText 里落实后的那一句或连续几句，必须从 revisedText 逐字复制（含标点），不得改写、缩写或拼接不相邻的句子；一条动作落实在不相邻的几处时，该项写成字符串数组，每处一个元素（例如 [\"推开门时，冷雨停了。\",\"阳光暖暖地照进来。\"]）；所有摘录互不重叠。只摘这条动作真正落实的句子，不要把整段都摘进来。只摘实质修改落实的句子：与学生原文相同、意思基本相同或只修了错字语病标点的句子不摘。advice 只有一条动作时 revisedQuotes 只有一项；动作在正文里没有可定位的句子（如删除）时该项写空字符串 \"\"；advice 为「本段无需修改」时 revisedQuotes 为 []。导出时第 1 条动作和它的摘录划单线、第 2 条划波浪线、第 3 条划点划线，未摘录的句子不划线。";
