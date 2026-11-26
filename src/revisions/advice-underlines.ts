import { diffArrays } from "diff";

import {
  MAX_REVISED_RANGE_OFFSET,
  paragraphSuggestionSchema,
  type PersistedQuoteRange,
} from "../domain/contracts";
import { collapseParagraphSuggestions, mergedParagraphAction, UNCHANGED_PARAGRAPH_ACTION } from "../domain/paragraph-actions";
import { buildSubstantiveSentenceRuns, sentenceSimilarity, type RevisionRun, type RevisionUnderline } from "./revision-diff";

/**
 * 改后全段按「第 N 条修改动作」划不同线，修改动作本身也划同样的线，方便一一对应。
 * 线型顺序按家奇 2026-11-08 手改稿：第 1 条单线、第 2 条波浪线、第 3 条点划线，超过 3 条从头循环。
 */
export const ADVICE_UNDERLINE_CYCLE: readonly RevisionUnderline[] = ["single", "wave", "dotDotDash"];

export const UNDERLINE_STYLE_LABELS: Record<RevisionUnderline, string> = {
  single: "单横线",
  wave: "波浪线",
  dotDotDash: "点划线",
};

export function adviceUnderlineStyle(actionIndex: number): RevisionUnderline {
  return ADVICE_UNDERLINE_CYCLE[actionIndex % ADVICE_UNDERLINE_CYCLE.length]!;
}

/** 网页预览/打印页的 CSS text-decoration-style 兜底映射。 */
export const PREVIEW_UNDERLINE_STYLE: Record<RevisionUnderline, "wavy" | "dashed" | "solid"> = {
  single: "solid",
  wave: "wavy",
  dotDotDash: "dashed",
};

function dotDotDashBackgroundUrl(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="2" viewBox="0 0 15 2"><path d="M0 1h6M8 1h1.4M11.4 1h1.4" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * 网页预览与打印页统一下划线内联样式：
 * - single / wave 使用原生 `text-decoration`；
 * - dotDotDash 使用可跨行折行的重复 SVG「长划·点·点」，与 Word (`dotDotDash`) 和 PDF 自绘点划线一致。
 */
export function buildPreviewUnderlineStyles(
  underline: RevisionUnderline,
  color: string,
): {
  textDecoration?: string;
  textDecorationStyle?: "solid" | "wavy" | "dashed";
  textUnderlineOffset?: string;
  backgroundImage?: string;
  backgroundRepeat?: string;
  backgroundPosition?: string;
  backgroundSize?: string;
  paddingBottom?: string;
  WebkitBoxDecorationBreak?: "clone";
  boxDecorationBreak?: "clone";
} {
  if (underline === "dotDotDash") {
    return {
      textDecoration: "none",
      backgroundImage: dotDotDashBackgroundUrl(color),
      backgroundRepeat: "repeat-x",
      backgroundPosition: "0 100%",
      backgroundSize: "15px 2px",
      paddingBottom: "2px",
      WebkitBoxDecorationBreak: "clone",
      boxDecorationBreak: "clone",
    };
  }
  return {
    textDecoration: "underline",
    textDecorationStyle: PREVIEW_UNDERLINE_STYLE[underline],
    textUnderlineOffset: "3px",
  };
}

type SuggestionLike = {
  advice: string;
  revisedQuotes?: ReadonlyArray<string | readonly string[]>;
  revisedRanges?: ReadonlyArray<PersistedQuoteRange>;
};

export type ParagraphActionSlice = {
  prefix: string;
  body: string;
  suffix: string;
};

export type QuoteRange = { start: number; end: number; actionIndex: number };

export type RevisedSentenceSpan = {
  text: string;
  start: number;
  end: number;
};

export type TextEditHint = {
  start: number;
  end: number;
};

// 支持 1..100 连续编号；点号后紧跟数字（如 1.5 倍、2.5 倍）视为小数，不作为序号切分。
const NUMBER_MARKER = /(\d{1,3})(?:\s*[、)）]\s*|\s*[.．](?!\d)\s*)/gu;
export const MAX_QUOTE_SEGMENT_CODEPOINTS = 2000;
export const MAX_QUOTE_SEGMENTS_PER_ACTION = 200;
export const MAX_ACTIONS_WITH_QUOTES = 100;
export const MAX_PERSISTED_QUOTE_RANGES = 500;

const sentenceSegmenter = new Intl.Segmenter("zh-CN", { granularity: "sentence" });
const graphemeSegmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
const sentenceTerminal = /[.!?。！？…](?:["'”’」』】）》〉）])*\s*$/u;

function hash4At(cps: readonly string[], index: number): number {
  let h = 2166136261;
  for (let k = index - 3; k <= index; k += 1) {
    h = Math.imul(h ^ (cps[k]!.codePointAt(0) ?? 0), 16777619) >>> 0;
  }
  return h;
}

/**
 * 真滑动窗口内容定义分块（Local-Maxima Winnowing CDC）：
 * 切点仅取决于局部邻域 `cps[i-14 .. i+4]` 的 4-gram 局部极大值或 >=8 连同字边界，
 * 与块起点历史完全解耦；首尾任意增删改后，在任意周期文本或自然无标点长文中均能在数十字符内 100% 重新同步切点。
 */
function splitIntoContentDefinedTokens(text: string): string[] {
  if (!text) return [];
  const cps = Array.from(text);
  const tokens: string[] = [];
  let chunkStart = 0;
  let i = 0;
  while (i < cps.length) {
    if (
      i + 7 < cps.length
      && cps[i + 1] === cps[i]
      && cps[i + 2] === cps[i]
      && cps[i + 3] === cps[i]
      && cps[i + 4] === cps[i]
      && cps[i + 5] === cps[i]
      && cps[i + 6] === cps[i]
      && cps[i + 7] === cps[i]
    ) {
      if (i > chunkStart) {
        tokens.push(cps.slice(chunkStart, i).join(""));
      }
      let runEnd = i + 8;
      while (runEnd < cps.length && cps[runEnd] === cps[i]) {
        runEnd += 1;
      }
      tokens.push(cps.slice(i, runEnd).join(""));
      chunkStart = runEnd;
      i = runEnd;
      continue;
    }

    const ch = cps[i]!;
    const chunkLen = i - chunkStart + 1;
    const isSentenceBreak = chunkLen >= 8 && /[。！？.!?\r\n]/u.test(ch);
    let isLocalMaxCut = false;
    if (!isSentenceBreak && chunkLen >= 16 && i >= 14 && i + 4 < cps.length) {
      const center = hash4At(cps, i);
      isLocalMaxCut = true;
      for (let left = i - 11; left < i; left += 1) {
        if (hash4At(cps, left) > center) {
          isLocalMaxCut = false;
          break;
        }
      }
      if (isLocalMaxCut) {
        for (let right = i + 1; right <= i + 4; right += 1) {
          if (hash4At(cps, right) >= center) {
            isLocalMaxCut = false;
            break;
          }
        }
      }
    }
    if (isSentenceBreak || isLocalMaxCut || chunkLen >= 256) {
      tokens.push(cps.slice(chunkStart, i + 1).join(""));
      chunkStart = i + 1;
    }
    i += 1;
  }
  if (chunkStart < cps.length) {
    tokens.push(cps.slice(chunkStart).join(""));
  }
  return tokens;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function trimmedFrame(revisedText: string): { leading: number; trimmed: string } {
  const leading = revisedText.length - revisedText.trimStart().length;
  return { leading, trimmed: revisedText.trim() };
}

/** 校正区间端点到完整 UTF-16 码点边界，绝不拆断 emoji/生僻字代理对。 */
export function snapRangeToCodePointBounds(
  text: string,
  rawStart: number,
  rawEnd: number,
): { start: number; end: number } {
  let start = Math.max(0, Math.min(text.length, Math.min(rawStart, rawEnd)));
  let end = Math.max(0, Math.min(text.length, Math.max(rawStart, rawEnd)));
  if (start > 0 && start < text.length && isLowSurrogate(text.charCodeAt(start)) && isHighSurrogate(text.charCodeAt(start - 1))) {
    start -= 1;
  }
  if (end > 0 && end < text.length && isLowSurrogate(text.charCodeAt(end)) && isHighSurrogate(text.charCodeAt(end - 1))) {
    end += 1;
  }
  return { start, end };
}

function findNumberedActionStarts(text: string): Array<{ index: number; bodyStart: number }> {
  const starts: Array<{ index: number; bodyStart: number }> = [];
  let expected = 1;
  for (const match of text.matchAll(NUMBER_MARKER)) {
    const index = match.index;
    const parsedNumber = Number(match[1]);
    if (parsedNumber !== expected || parsedNumber > MAX_ACTIONS_WITH_QUOTES) continue;
    const before = index === 0 ? "" : text[index - 1]!;
    if (index !== 0 && !/[\s。；;！!？?]/u.test(before)) continue;
    if (expected === 1 && index !== 0) break;
    starts.push({ index, bodyStart: index + match[0].length });
    expected += 1;
  }
  return starts;
}

/**
 * 把一个框里的修改动作拆成逐条。支持「1. …\n2. …」分行，也容忍同一行「1. … 2. …」。
 * 编号必须从 1 起连续递增；不是编号列表时整段算 1 条；「本段无需修改」或纯空编号算 0 条。
 */
export function splitParagraphActions(advice: string): string[] {
  const text = advice.trim();
  if (!text || text === UNCHANGED_PARAGRAPH_ACTION) return [];
  const starts = findNumberedActionStarts(text);
  if (starts.length === 1 && starts[0]!.index === 0 && !text.slice(starts[0]!.bodyStart).trim()) {
    return [];
  }
  if (starts.length < 2) return [text];
  return starts.map((start, position) => (
    text.slice(start.bodyStart, starts[position + 1]?.index ?? text.length).trim()
  ));
}

/**
 * 按原始文本无损切分每条动作的「编号前缀 + 动作正文 + 尾随分隔空白/换行」，
 * 拼接 `prefix + body + suffix` 恒等于 `advice.trim()`（空编号除外）。
 */
export function splitParagraphActionSlices(advice: string): ParagraphActionSlice[] {
  const text = advice.trim();
  if (!text || text === UNCHANGED_PARAGRAPH_ACTION) return [];
  const starts = findNumberedActionStarts(text);
  if (starts.length >= 2) {
    return starts.map((start, position) => {
      const nextIndex = starts[position + 1]?.index ?? text.length;
      const markerPrefix = text.slice(start.index, start.bodyStart);
      const raw = text.slice(start.bodyStart, nextIndex);
      const body = raw.trim();
      if (!body) {
        return { prefix: markerPrefix, body: "", suffix: raw };
      }
      const bodyOffset = raw.indexOf(body);
      return {
        prefix: markerPrefix + raw.slice(0, bodyOffset),
        body,
        suffix: raw.slice(bodyOffset + body.length),
      };
    });
  }
  if (starts.length === 1 && starts[0]!.index === 0) {
    const markerPrefix = text.slice(0, starts[0]!.bodyStart);
    const raw = text.slice(starts[0]!.bodyStart);
    const body = raw.trim();
    if (!body) return [];
    const bodyOffset = raw.indexOf(body);
    return [{
      prefix: markerPrefix + raw.slice(0, bodyOffset),
      body,
      suffix: raw.slice(bodyOffset + body.length),
    }];
  }
  return [{ prefix: "", body: text, suffix: "" }];
}

/** 本段所有修改动作（多条 suggestion 先按导出口径合并编号再拆）。 */
export function paragraphActions(suggestions: readonly SuggestionLike[]): string[] {
  return splitParagraphActions(mergedParagraphAction(suggestions));
}

function collectQuotes(suggestions: readonly SuggestionLike[]): string[][] | null {
  if (suggestions.length === 0 || suggestions.some((suggestion) => !Array.isArray(suggestion.revisedQuotes))) {
    return null;
  }
  return suggestions
    .flatMap((suggestion) => [...(suggestion.revisedQuotes ?? [])])
    .map((item) => (typeof item === "string" ? [item] : [...item]).map((quote) => quote.trim()).filter(Boolean));
}

/**
 * `revisedRanges` 统一存储相对于 `revisedText.trim()` 的规范偏移，
 * 从而在编辑器含段首全角/半角缩进空白与保存/导出 `.trim()` 之后始终指向同一字符位置。
 */
function locatePersistedRanges(
  revisedText: string,
  suggestions: readonly SuggestionLike[],
): QuoteRange[] | null {
  if (suggestions.length !== 1 || !Array.isArray(suggestions[0]?.revisedRanges)) {
    return null;
  }
  const persisted = suggestions[0]!.revisedRanges!;
  const actionCount = paragraphActions(suggestions).length;
  if (actionCount === 0) {
    return persisted.length === 0 ? [] : null;
  }
  const { leading, trimmed } = trimmedFrame(revisedText);
  const sorted = [...persisted].sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 0; index < sorted.length; index += 1) {
    const item = sorted[index]!;
    if (
      !Number.isInteger(item.start)
      || !Number.isInteger(item.end)
      || item.start < 0
      || item.end <= item.start
      || item.end > trimmed.length
      || item.actionIndex < 0
      || item.actionIndex >= actionCount
      || (item.start > 0 && isLowSurrogate(trimmed.charCodeAt(item.start)) && isHighSurrogate(trimmed.charCodeAt(item.start - 1)))
      || (item.end < trimmed.length && isLowSurrogate(trimmed.charCodeAt(item.end)) && isHighSurrogate(trimmed.charCodeAt(item.end - 1)))
      || trimmed.slice(item.start, item.end) !== item.text
    ) {
      return null;
    }
    if (index > 0 && sorted[index - 1]!.end > item.start) {
      return null;
    }
  }
  return sorted.map(({ start, end, actionIndex }) => ({
    start: start + leading,
    end: end + leading,
    actionIndex,
  }));
}

function locateQuotesOnly(
  revisedText: string,
  quotes: string[][],
  expectedActionCount: number,
): QuoteRange[] | null {
  if (quotes.length !== expectedActionCount) return null;
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

/**
 * 在改后全段里定位标线区间：
 * 1. 若带有精确规范偏移 `revisedRanges` 且与 `revisedText.trim()` 切片一致，直接还原到当前坐标；
 * 2. 否则按 `revisedQuotes` 依次子串匹配；条数与动作数不符或找不到时返回 null。
 */
export function locateRevisedQuotes(
  revisedText: string,
  suggestions: readonly SuggestionLike[],
): QuoteRange[] | null {
  const fromRanges = locatePersistedRanges(revisedText, suggestions);
  if (fromRanges !== null) return fromRanges;

  const quotes = collectQuotes(suggestions);
  if (!quotes) return null;
  return locateQuotesOnly(revisedText, quotes, paragraphActions(suggestions).length);
}

/** 宽松定位：优先从有效 `revisedRanges` 恢复，否则跳过失效摘录尽量保留仍匹配的片段。 */
function locateAvailableRanges(
  revisedText: string,
  suggestions: readonly SuggestionLike[],
  maxActions: number,
): QuoteRange[] {
  if (maxActions <= 0 || !revisedText) return [];
  if (suggestions.length === 1 && Array.isArray(suggestions[0]?.revisedRanges)) {
    const { leading, trimmed } = trimmedFrame(revisedText);
    const recovered: QuoteRange[] = [];
    for (const item of suggestions[0]!.revisedRanges!) {
      if (item.actionIndex < 0 || item.actionIndex >= maxActions) continue;
      if (item.start >= 0 && item.end > item.start && item.end <= trimmed.length && trimmed.slice(item.start, item.end) === item.text) {
        recovered.push({
          start: item.start + leading,
          end: item.end + leading,
          actionIndex: item.actionIndex,
        });
      }
    }
    return normalizeQuoteRanges(revisedText, recovered, maxActions);
  }
  const quotes = collectQuotes(suggestions);
  if (!quotes) return [];
  const ranges: QuoteRange[] = [];
  for (const [actionIndex, segments] of quotes.slice(0, maxActions).entries()) {
    for (const quote of segments) {
      let offset = revisedText.indexOf(quote);
      while (offset >= 0 && ranges.some((range) => offset < range.end && offset + quote.length > range.start)) {
        offset = revisedText.indexOf(quote, offset + 1);
      }
      if (offset >= 0) {
        ranges.push({ start: offset, end: offset + quote.length, actionIndex });
      }
    }
  }
  return normalizeQuoteRanges(revisedText, ranges, maxActions);
}

function trimRangeBounds(text: string, rawStart: number, rawEnd: number): { start: number; end: number } | null {
  const snapped = snapRangeToCodePointBounds(text, rawStart, rawEnd);
  let { start, end } = snapped;
  while (start < end && /\s/u.test(text[start]!)) start += 1;
  while (end > start && /\s/u.test(text[end - 1]!)) end -= 1;
  const aligned = snapRangeToCodePointBounds(text, start, end);
  return aligned.start < aligned.end ? aligned : null;
}

/** 规范化标线区间：码点对齐、去空白边界、按起点排序、合并同动作相邻区间并裁剪跨动作重叠。 */
export function normalizeQuoteRanges(
  revisedText: string,
  ranges: readonly QuoteRange[],
  actionCount: number,
): QuoteRange[] {
  const limit = Math.min(Math.max(0, actionCount), MAX_ACTIONS_WITH_QUOTES);
  if (limit === 0 || !revisedText) return [];
  const sorted = ranges
    .filter((range) => range.actionIndex >= 0 && range.actionIndex < limit)
    .map((range) => {
      const trimmed = trimRangeBounds(revisedText, range.start, range.end);
      return trimmed ? { ...trimmed, actionIndex: range.actionIndex } : null;
    })
    .filter((range): range is QuoteRange => range !== null)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const normalized: QuoteRange[] = [];
  for (const current of sorted) {
    const previous = normalized.at(-1);
    if (!previous) {
      normalized.push({ ...current });
      continue;
    }
    if (current.start <= previous.end) {
      if (current.actionIndex === previous.actionIndex) {
        previous.end = Math.max(previous.end, current.end);
      } else if (current.end > previous.end) {
        const trimmed = trimRangeBounds(revisedText, previous.end, current.end);
        if (trimmed) normalized.push({ ...trimmed, actionIndex: current.actionIndex });
      }
      continue;
    }
    if (
      current.actionIndex === previous.actionIndex
      && /^\s*$/u.test(revisedText.slice(previous.end, current.start))
    ) {
      previous.end = current.end;
      continue;
    }
    normalized.push({ ...current });
  }
  return normalized;
}

/** 按 Unicode 码点安全切分超长摘录，绝不截断 UTF-16 代理对。 */
function splitLongQuoteSlice(slice: string): string[] {
  const trimmed = slice.trim();
  if (!trimmed) return [];
  const codePoints = Array.from(trimmed);
  if (codePoints.length <= MAX_QUOTE_SEGMENT_CODEPOINTS) return [trimmed];
  const chunks: string[] = [];
  for (let cursor = 0; cursor < codePoints.length; cursor += MAX_QUOTE_SEGMENT_CODEPOINTS) {
    const piece = codePoints.slice(cursor, cursor + MAX_QUOTE_SEGMENT_CODEPOINTS).join("").trim();
    if (piece) chunks.push(piece);
  }
  return chunks;
}

/** 将区间还原为 `revisedQuotes` 数组。 */
export function rangesToRevisedQuotes(
  revisedText: string,
  ranges: readonly QuoteRange[],
  actionCount: number,
): Array<string | string[]> {
  const limit = Math.min(Math.max(0, actionCount), MAX_ACTIONS_WITH_QUOTES);
  if (limit === 0) return [];
  const normalized = normalizeQuoteRanges(revisedText, ranges, limit);
  const grouped: string[][] = Array.from({ length: limit }, () => []);
  for (const range of normalized) {
    const bucket = grouped[range.actionIndex];
    if (!bucket) continue;
    for (const chunk of splitLongQuoteSlice(revisedText.slice(range.start, range.end))) {
      if (bucket.length < MAX_QUOTE_SEGMENTS_PER_ACTION) {
        bucket.push(chunk);
      }
    }
  }
  return grouped.map((segments) => {
    if (segments.length === 0) return "";
    if (segments.length === 1) return segments[0]!;
    return segments;
  });
}

/**
 * 将原始坐标下的区间转换为相对于 `revisedText.trim()` 的精确偏移数组 `revisedRanges`。
 * 若单段超出 `MAX_REVISED_RANGE_OFFSET`，按码点边界无损拆成相邻子段而非丢弃。
 */
export function rangesToPersistedRanges(
  revisedText: string,
  ranges: readonly QuoteRange[],
  actionCount: number,
): PersistedQuoteRange[] {
  const normalized = normalizeQuoteRanges(revisedText, ranges, actionCount);
  const { leading, trimmed } = trimmedFrame(revisedText);
  if (!trimmed) return [];

  const persisted: PersistedQuoteRange[] = [];
  for (const range of normalized) {
    const tStart = Math.max(0, range.start - leading);
    const tEnd = Math.min(trimmed.length, range.end - leading);
    if (tEnd <= tStart || tEnd > MAX_REVISED_RANGE_OFFSET) continue;
    persisted.push({
      start: tStart,
      end: tEnd,
      actionIndex: range.actionIndex,
      text: trimmed.slice(tStart, tEnd),
    });
    if (persisted.length >= MAX_PERSISTED_QUOTE_RANGES) break;
  }
  return persisted;
}

/** 检查新区间集是否完全满足 `paragraphSuggestionSchema` 保存契约，事前显式拦截任何超限操作。 */
export function validateQuoteRangesCapacity(
  revisedText: string,
  ranges: readonly QuoteRange[],
  actionCount: number,
  advice = "占位动作",
): string | null {
  if (actionCount > MAX_ACTIONS_WITH_QUOTES) {
    return `单段修改动作最多支持 ${MAX_ACTIONS_WITH_QUOTES} 条`;
  }
  const normalized = normalizeQuoteRanges(revisedText, ranges, actionCount);
  if (normalized.length > MAX_PERSISTED_QUOTE_RANGES) {
    return `单段标线片段最多支持 ${MAX_PERSISTED_QUOTE_RANGES} 处`;
  }
  const { leading, trimmed } = trimmedFrame(revisedText);
  if (trimmed.length > MAX_REVISED_RANGE_OFFSET) {
    for (const range of normalized) {
      if (range.end - leading > MAX_REVISED_RANGE_OFFSET) {
        return `单段支持标线的最大正文长度为 ${MAX_REVISED_RANGE_OFFSET} 字符`;
      }
    }
  }
  const perActionCounts = new Array<number>(actionCount).fill(0);
  for (const range of normalized) {
    const chunks = splitLongQuoteSlice(revisedText.slice(range.start, range.end));
    perActionCounts[range.actionIndex] = (perActionCounts[range.actionIndex] ?? 0) + chunks.length;
    if (perActionCounts[range.actionIndex]! > MAX_QUOTE_SEGMENTS_PER_ACTION) {
      return `单条动作最多标记 ${MAX_QUOTE_SEGMENTS_PER_ACTION} 处不相邻标线`;
    }
  }
  const candidate = {
    advice: advice.trim() || UNCHANGED_PARAGRAPH_ACTION,
    revisedQuotes: rangesToRevisedQuotes(revisedText, normalized, actionCount),
    revisedRanges: rangesToPersistedRanges(revisedText, normalized, actionCount),
  };
  if (!paragraphSuggestionSchema.safeParse(candidate).success) {
    return "标线范围超出保存契约限制，请缩短段落或减少分段数后重试";
  }
  return null;
}

/**
 * 读取当前段落实际生效的标线区间（含无 `revisedQuotes` 或回退时的自动实质改动单线），
 * 保证老师在预览所见的基础上点选修改时「所见即所改」。
 */
export function effectiveQuoteRanges(
  sourceText: string,
  revisedText: string,
  suggestions: readonly SuggestionLike[],
): QuoteRange[] {
  const actionCount = Math.min(paragraphActions(suggestions).length, MAX_ACTIONS_WITH_QUOTES);
  if (actionCount === 0 || !revisedText) return [];
  const located = locateRevisedQuotes(revisedText, suggestions);
  if (located) return located;
  const runs = buildAdviceRevisionRuns(sourceText, revisedText, suggestions);
  const fallbackRanges: QuoteRange[] = [];
  let cursor = 0;
  for (const run of runs) {
    const nextCursor = cursor + run.text.length;
    if (run.kind === "inserted" && run.text.length > 0) {
      fallbackRanges.push({
        start: cursor,
        end: nextCursor,
        actionIndex: Math.min(run.actionIndex ?? 0, actionCount - 1),
      });
    }
    cursor = nextCursor;
  }
  return normalizeQuoteRanges(revisedText, fallbackRanges, actionCount);
}

/**
 * 在 `[targetStart, targetEnd)` 上涂抹指定动作的标线（`actionIndex === null` 表示擦除该范围标线）。
 * 若涂抹落在已有标线中间，会自动切分保留两侧原有标线。
 */
export function paintQuoteRange(
  revisedText: string,
  currentRanges: readonly QuoteRange[],
  targetStart: number,
  targetEnd: number,
  actionIndex: number | null,
  actionCount: number,
): QuoteRange[] {
  const limit = Math.min(Math.max(0, actionCount), MAX_ACTIONS_WITH_QUOTES);
  if (limit === 0 || !revisedText) return [];
  const { start: selStart, end: selEnd } = snapRangeToCodePointBounds(revisedText, targetStart, targetEnd);
  if (selStart >= selEnd) {
    return normalizeQuoteRanges(revisedText, currentRanges, limit);
  }
  const next: QuoteRange[] = [];
  for (const range of currentRanges) {
    if (range.end <= selStart || range.start >= selEnd) {
      next.push(range);
      continue;
    }
    if (range.start < selStart) {
      next.push({ start: range.start, end: selStart, actionIndex: range.actionIndex });
    }
    if (range.end > selEnd) {
      next.push({ start: selEnd, end: range.end, actionIndex: range.actionIndex });
    }
  }
  if (actionIndex !== null && actionIndex >= 0 && actionIndex < limit) {
    next.push({ start: selStart, end: selEnd, actionIndex });
  }
  return normalizeQuoteRanges(revisedText, next, limit);
}

/** 将 `revisedText` 切分为可一键点选的整句区间，合并单字符引号碎片。 */
export function splitRevisedSentences(revisedText: string): RevisedSentenceSpan[] {
  if (!revisedText) return [];
  const rawUnits: string[] = [];
  let pending = "";
  for (const { segment } of sentenceSegmenter.segment(revisedText)) {
    pending += segment;
    if (sentenceTerminal.test(pending)) {
      rawUnits.push(pending);
      pending = "";
    }
  }
  if (pending.length > 0) rawUnits.push(pending);

  const merged: string[] = [];
  let leading = "";
  for (const unit of rawUnits) {
    const text = leading + unit;
    leading = "";
    const visibleLength = Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment)
      .filter((ch) => !/^\s+$/u.test(ch)).length;
    if (visibleLength > 1) {
      merged.push(text);
    } else if (merged.length > 0) {
      merged[merged.length - 1] += text;
    } else {
      leading = text;
    }
  }
  if (leading.length > 0) merged.push(leading);

  const spans: RevisedSentenceSpan[] = [];
  let cursor = 0;
  for (const text of merged) {
    spans.push({ text, start: cursor, end: cursor + text.length });
    cursor += text.length;
  }
  return spans;
}

function sameRangeList(left: readonly QuoteRange[] | null, right: readonly QuoteRange[]): boolean {
  if (!left || left.length !== right.length) return false;
  return left.every((item, idx) => (
    item.start === right[idx]?.start
    && item.end === right[idx]?.end
    && item.actionIndex === right[idx]?.actionIndex
  ));
}

/**
 * 构建写回字段：
 * - 若原本已有 `revisedRanges`（`preferPersistedRanges = true`），始终写出 `revisedRanges`；
 * - 若原本只有历史 `revisedQuotes`，先检验纯 `revisedQuotes` 在原串与 `.trim()` 串上能否无歧义还原出完全相同的区间；
 *   一旦因调序或重复短语产生歧义，自动升级附带 `revisedRanges` 以保住精确位置。
 */
function buildQuoteFields(
  revisedText: string,
  ranges: readonly QuoteRange[],
  actionCount: number,
  preferPersistedRanges: boolean,
): {
  revisedQuotes: Array<string | string[]>;
  revisedRanges?: PersistedQuoteRange[];
} {
  const normalized = normalizeQuoteRanges(revisedText, ranges, actionCount);
  const revisedQuotes = rangesToRevisedQuotes(revisedText, normalized, actionCount);
  if (!preferPersistedRanges) {
    const normalizedBuckets = revisedQuotes.map((item) => (
      typeof item === "string" ? [item] : [...item]
    ).map((q) => q.trim()).filter(Boolean));
    const byQuotesRaw = locateQuotesOnly(revisedText, normalizedBuckets, actionCount);
    const { leading, trimmed } = trimmedFrame(revisedText);
    const expectedTrimmed = normalized.map((r) => ({
      start: r.start - leading,
      end: r.end - leading,
      actionIndex: r.actionIndex,
    }));
    const byQuotesTrimmed = locateQuotesOnly(trimmed, normalizedBuckets, actionCount);
    if (sameRangeList(byQuotesRaw, normalized) && sameRangeList(byQuotesTrimmed, expectedTrimmed)) {
      return { revisedQuotes };
    }
  }
  const persisted = rangesToPersistedRanges(revisedText, normalized, actionCount);
  return {
    revisedQuotes,
    ...(persisted.length === normalized.length ? { revisedRanges: persisted } : {}),
  };
}

/**
 * 教师修改【修改动作】时同步对齐 `revisedQuotes` / `revisedRanges`：
 * - 若修改后变为「本段无需修改」（0 条动作），无论旧稿是否有摘录，统一写入空摘录/空区间，确保预览与导出均无蓝线；
 * - 统一以剥离序号后的动作正文（`splitParagraphActionSlices` 的 `body`）做同名/高相似匹配，
 *   确保单条 `1. 甲` 扩展为 `1. 甲\n2. 乙` 时保留第 1 条标线，且重复动作名不误判为调序。
 */
export function reconcileQuotesOnAdviceChange<
  T extends {
    advice: string;
    revisedQuotes?: Array<string | string[]>;
    revisedRanges?: PersistedQuoteRange[];
  },
>(
  revisedText: string,
  prevSuggestions: readonly T[],
  nextAdvice: string,
): T {
  const effectiveAdvice = nextAdvice.trim() ? nextAdvice : UNCHANGED_PARAGRAPH_ACTION;
  const collapsed = collapseParagraphSuggestions([...prevSuggestions])[0];
  const base = collapsed
    ? (({ revisedQuotes: _q, revisedRanges: _r, ...rest }) => {
        void _q;
        void _r;
        return rest;
      })(collapsed)
    : {};

  const nextActionCount = splitParagraphActions(effectiveAdvice).slice(0, MAX_ACTIONS_WITH_QUOTES).length;
  const hadRanges = prevSuggestions.some((suggestion) => Array.isArray(suggestion.revisedRanges));
  if (nextActionCount === 0) {
    const emptyQuotes: Array<string | string[]> = [];
    const emptyRanges: PersistedQuoteRange[] = [];
    return {
      ...base,
      advice: effectiveAdvice,
      revisedQuotes: emptyQuotes,
      ...(hadRanges ? { revisedRanges: emptyRanges } : {}),
    } as unknown as T;
  }

  const hasExplicit = hadRanges || prevSuggestions.some((suggestion) => Array.isArray(suggestion.revisedQuotes));
  if (!hasExplicit) {
    return { ...base, advice: effectiveAdvice } as unknown as T;
  }

  const nextBodies = splitParagraphActionSlices(effectiveAdvice)
    .map((slice) => slice.body)
    .slice(0, MAX_ACTIONS_WITH_QUOTES);
  const prevMerged = mergedParagraphAction(prevSuggestions);
  const prevBodies = splitParagraphActionSlices(prevMerged).map((slice) => slice.body);
  const prevActionCount = splitParagraphActions(prevMerged).length;
  const exactPrev = locateRevisedQuotes(revisedText, prevSuggestions);
  const prevRanges = exactPrev
    ?? locateAvailableRanges(revisedText, prevSuggestions, Math.max(prevActionCount, 1));
  if (!hadRanges && exactPrev === null && prevRanges.length === 0) {
    return { ...base, advice: effectiveAdvice } as unknown as T;
  }

  if (prevActionCount === nextActionCount) {
    const nonEmptyUniquePrev = prevBodies.every(Boolean) && new Set(prevBodies).size === prevBodies.length;
    const permutation = nonEmptyUniquePrev ? nextBodies.map((body) => prevBodies.indexOf(body)) : [];
    const isBijectionSwap = nonEmptyUniquePrev
      && permutation.length === nextActionCount
      && new Set(permutation).size === nextActionCount
      && permutation.every((idx) => idx >= 0)
      && permutation.some((idx, pos) => idx !== pos);

    if (isBijectionSwap) {
      const oldToNew = new Map<number, number>();
      permutation.forEach((oldIdx, newIdx) => oldToNew.set(oldIdx, newIdx));
      const remapped = prevRanges
        .map((range) => {
          const newIdx = oldToNew.get(range.actionIndex);
          return newIdx !== undefined ? { ...range, actionIndex: newIdx } : null;
        })
        .filter((range): range is QuoteRange => range !== null);
      return {
        ...base,
        advice: effectiveAdvice,
        ...buildQuoteFields(revisedText, remapped, nextActionCount, hadRanges),
      } as unknown as T;
    }

    if (!hadRanges) {
      const exact = locateRevisedQuotes(revisedText, prevSuggestions);
      const preserved = collapsed?.revisedQuotes;
      if (exact && preserved && preserved.length === nextActionCount) {
        return { ...base, advice: effectiveAdvice, revisedQuotes: preserved } as unknown as T;
      }
    }

    return {
      ...base,
      advice: effectiveAdvice,
      ...buildQuoteFields(revisedText, prevRanges, nextActionCount, hadRanges),
    } as unknown as T;
  }

  const usedPrev = new Set<number>();
  const oldToNew = new Map<number, number>();

  for (let nextIdx = 0; nextIdx < nextBodies.length; nextIdx += 1) {
    const target = nextBodies[nextIdx] ?? "";
    if (!target) continue;
    const exactIdx = prevBodies.findIndex((candidate, idx) => !usedPrev.has(idx) && candidate === target);
    if (exactIdx >= 0) {
      usedPrev.add(exactIdx);
      oldToNew.set(exactIdx, nextIdx);
    }
  }

  for (let nextIdx = 0; nextIdx < nextBodies.length; nextIdx += 1) {
    if ([...oldToNew.values()].includes(nextIdx)) continue;
    const target = nextBodies[nextIdx] ?? "";
    if (!target) continue;
    let bestIdx = -1;
    let bestScore = 0.65;
    for (let prevIdx = 0; prevIdx < prevBodies.length; prevIdx += 1) {
      const candidate = prevBodies[prevIdx] ?? "";
      if (usedPrev.has(prevIdx) || !candidate) continue;
      const score = sentenceSimilarity(candidate, target);
      if (score >= bestScore) {
        bestScore = score;
        bestIdx = prevIdx;
      }
    }
    if (bestIdx >= 0) {
      usedPrev.add(bestIdx);
      oldToNew.set(bestIdx, nextIdx);
    }
  }

  const remapped = prevRanges
    .map((range) => {
      const newIdx = oldToNew.get(range.actionIndex);
      return newIdx !== undefined ? { ...range, actionIndex: newIdx } : null;
    })
    .filter((range): range is QuoteRange => range !== null);

  return {
    ...base,
    advice: effectiveAdvice,
    ...buildQuoteFields(revisedText, remapped, nextActionCount, hadRanges),
  } as unknown as T;
}

type DiffBlock = {
  kind: "equal" | "replace";
  prevStart: number;
  prevEnd: number;
  nextStart: number;
  nextEnd: number;
};

function appendDiffBlock(blocks: DiffBlock[], block: DiffBlock): void {
  if (block.prevStart === block.prevEnd && block.nextStart === block.nextEnd) return;
  const last = blocks.at(-1);
  if (last && last.kind === block.kind && last.prevEnd === block.prevStart && last.nextEnd === block.nextStart) {
    last.prevEnd = block.prevEnd;
    last.nextEnd = block.nextEnd;
    return;
  }
  blocks.push({ ...block });
}

function diffSliceByCodePoints(
  prevSlice: string,
  nextSlice: string,
  prevBase: number,
  nextBase: number,
  out: DiffBlock[],
): void {
  if (!prevSlice && !nextSlice) return;
  if (prevSlice === nextSlice) {
    appendDiffBlock(out, {
      kind: "equal",
      prevStart: prevBase,
      prevEnd: prevBase + prevSlice.length,
      nextStart: nextBase,
      nextEnd: nextBase + nextSlice.length,
    });
    return;
  }

  // 先剥离码点安全的公共前缀与后缀，将长相同区段 O(N) 直接归为 equal
  const prevCps = Array.from(prevSlice);
  const nextCps = Array.from(nextSlice);
  let prefixCp = 0;
  const minCp = Math.min(prevCps.length, nextCps.length);
  while (prefixCp < minCp && prevCps[prefixCp] === nextCps[prefixCp]) {
    prefixCp += 1;
  }
  let prevEndCp = prevCps.length;
  let nextEndCp = nextCps.length;
  while (prevEndCp > prefixCp && nextEndCp > prefixCp && prevCps[prevEndCp - 1] === nextCps[nextEndCp - 1]) {
    prevEndCp -= 1;
    nextEndCp -= 1;
  }

  let prefixUnits = 0;
  for (let i = 0; i < prefixCp; i += 1) prefixUnits += prevCps[i]!.length;
  let suffixUnits = 0;
  for (let i = prevEndCp; i < prevCps.length; i += 1) suffixUnits += prevCps[i]!.length;

  if (prefixUnits > 0) {
    appendDiffBlock(out, {
      kind: "equal",
      prevStart: prevBase,
      prevEnd: prevBase + prefixUnits,
      nextStart: nextBase,
      nextEnd: nextBase + prefixUnits,
    });
  }

  const corePrev = prevCps.slice(prefixCp, prevEndCp);
  const coreNext = nextCps.slice(prefixCp, nextEndCp);
  let prevOffset = prevBase + prefixUnits;
  let nextOffset = nextBase + prefixUnits;

  if (corePrev.length + coreNext.length <= 4_000) {
    const fineChanges = diffArrays(corePrev, coreNext, { maxEditLength: 1024 });
    if (fineChanges) {
      for (const change of fineChanges) {
        const unitLen = change.value.reduce((sum, cp) => sum + cp.length, 0);
        if (change.removed) {
          appendDiffBlock(out, {
            kind: "replace",
            prevStart: prevOffset,
            prevEnd: prevOffset + unitLen,
            nextStart: nextOffset,
            nextEnd: nextOffset,
          });
          prevOffset += unitLen;
        } else if (change.added) {
          appendDiffBlock(out, {
            kind: "replace",
            prevStart: prevOffset,
            prevEnd: prevOffset,
            nextStart: nextOffset,
            nextEnd: nextOffset + unitLen,
          });
          nextOffset += unitLen;
        } else {
          appendDiffBlock(out, {
            kind: "equal",
            prevStart: prevOffset,
            prevEnd: prevOffset + unitLen,
            nextStart: nextOffset,
            nextEnd: nextOffset + unitLen,
          });
          prevOffset += unitLen;
          nextOffset += unitLen;
        }
      }
      if (suffixUnits > 0) {
        appendDiffBlock(out, {
          kind: "equal",
          prevStart: prevBase + prevSlice.length - suffixUnits,
          prevEnd: prevBase + prevSlice.length,
          nextStart: nextBase + nextSlice.length - suffixUnits,
          nextEnd: nextBase + nextSlice.length,
        });
      }
      return;
    }
  }
  const corePrevUnits = prevSlice.length - prefixUnits - suffixUnits;
  const coreNextUnits = nextSlice.length - prefixUnits - suffixUnits;
  appendDiffBlock(out, {
    kind: "replace",
    prevStart: prevOffset,
    prevEnd: prevOffset + corePrevUnits,
    nextStart: nextOffset,
    nextEnd: nextOffset + coreNextUnits,
  });

  if (suffixUnits > 0) {
    appendDiffBlock(out, {
      kind: "equal",
      prevStart: prevBase + prevSlice.length - suffixUnits,
      prevEnd: prevBase + prevSlice.length,
      nextStart: nextBase + nextSlice.length - suffixUnits,
      nextEnd: nextBase + nextSlice.length,
    });
  }
}

function stripCommonCodePointAffixes(prevSpan: string, nextSpan: string): {
  prefixUnits: number;
  suffixUnits: number;
  corePrev: string;
  coreNext: string;
} {
  let prefixUnits = 0;
  const minUnits = Math.min(prevSpan.length, nextSpan.length);
  while (prefixUnits < minUnits && prevSpan.charCodeAt(prefixUnits) === nextSpan.charCodeAt(prefixUnits)) {
    prefixUnits += 1;
  }
  if (
    prefixUnits > 0
    && isHighSurrogate(prevSpan.charCodeAt(prefixUnits - 1))
  ) {
    prefixUnits -= 1;
  }

  let suffixUnits = 0;
  const maxSuffix = minUnits - prefixUnits;
  while (
    suffixUnits < maxSuffix
    && prevSpan.charCodeAt(prevSpan.length - 1 - suffixUnits) === nextSpan.charCodeAt(nextSpan.length - 1 - suffixUnits)
  ) {
    suffixUnits += 1;
  }
  if (
    suffixUnits > 0
    && isLowSurrogate(prevSpan.charCodeAt(prevSpan.length - suffixUnits))
  ) {
    suffixUnits -= 1;
  }

  return {
    prefixUnits,
    suffixUnits,
    corePrev: prevSpan.slice(prefixUnits, prevSpan.length - suffixUnits),
    coreNext: nextSpan.slice(prefixUnits, nextSpan.length - suffixUnits),
  };
}

function diffArbitrarySpan(
  prevSpan: string,
  nextSpan: string,
  prevBase: number,
  nextBase: number,
  out: DiffBlock[],
): void {
  if (!prevSpan && !nextSpan) return;
  if (prevSpan === nextSpan) {
    appendDiffBlock(out, {
      kind: "equal",
      prevStart: prevBase,
      prevEnd: prevBase + prevSpan.length,
      nextStart: nextBase,
      nextEnd: nextBase + nextSpan.length,
    });
    return;
  }

  const { prefixUnits, suffixUnits, corePrev, coreNext } = stripCommonCodePointAffixes(prevSpan, nextSpan);
  if (prefixUnits > 0) {
    appendDiffBlock(out, {
      kind: "equal",
      prevStart: prevBase,
      prevEnd: prevBase + prefixUnits,
      nextStart: nextBase,
      nextEnd: nextBase + prefixUnits,
    });
  }

  const corePrevBase = prevBase + prefixUnits;
  const coreNextBase = nextBase + prefixUnits;

  if (corePrev.length > 0 || coreNext.length > 0) {
    if (corePrev.length === 0 || coreNext.length === 0) {
      appendDiffBlock(out, {
        kind: "replace",
        prevStart: corePrevBase,
        prevEnd: corePrevBase + corePrev.length,
        nextStart: coreNextBase,
        nextEnd: coreNextBase + coreNext.length,
      });
    } else if (corePrev.length + coreNext.length <= 4_000) {
      diffSliceByCodePoints(corePrev, coreNext, corePrevBase, coreNextBase, out);
    } else {
      const prevTokens = splitIntoContentDefinedTokens(corePrev);
      const nextTokens = splitIntoContentDefinedTokens(coreNext);
      const prevTokenSet = new Set(prevTokens);
      const hasSharedToken = nextTokens.some((token) => prevTokenSet.has(token));
      const coarseChanges = hasSharedToken
        ? diffArrays(prevTokens, nextTokens, { maxEditLength: 512 })
        : undefined;

      if (!coarseChanges) {
        appendDiffBlock(out, {
          kind: "replace",
          prevStart: corePrevBase,
          prevEnd: corePrevBase + corePrev.length,
          nextStart: coreNextBase,
          nextEnd: coreNextBase + coreNext.length,
        });
      } else {
        let prevOffset = corePrevBase;
        let nextOffset = coreNextBase;
        let pendingPrev = "";
        let pendingNext = "";
        let pendingPrevStart = corePrevBase;
        let pendingNextStart = coreNextBase;

        const flushPending = () => {
          if (!pendingPrev && !pendingNext) return;
          diffSliceByCodePoints(pendingPrev, pendingNext, pendingPrevStart, pendingNextStart, out);
          pendingPrev = "";
          pendingNext = "";
        };

        for (const change of coarseChanges) {
          const chunk = change.value.join("");
          if (change.removed) {
            if (!pendingPrev && !pendingNext) {
              pendingPrevStart = prevOffset;
              pendingNextStart = nextOffset;
            }
            pendingPrev += chunk;
            prevOffset += chunk.length;
          } else if (change.added) {
            if (!pendingPrev && !pendingNext) {
              pendingPrevStart = prevOffset;
              pendingNextStart = nextOffset;
            }
            pendingNext += chunk;
            nextOffset += chunk.length;
          } else {
            flushPending();
            appendDiffBlock(out, {
              kind: "equal",
              prevStart: prevOffset,
              prevEnd: prevOffset + chunk.length,
              nextStart: nextOffset,
              nextEnd: nextOffset + chunk.length,
            });
            prevOffset += chunk.length;
            nextOffset += chunk.length;
          }
        }
        flushPending();
      }
    }
  }

  if (suffixUnits > 0) {
    appendDiffBlock(out, {
      kind: "equal",
      prevStart: prevBase + prevSpan.length - suffixUnits,
      prevEnd: prevBase + prevSpan.length,
      nextStart: nextBase + nextSpan.length - suffixUnits,
      nextEnd: nextBase + nextSpan.length,
    });
  }
}

function computeCodePointDiffBlocks(
  prevText: string,
  nextText: string,
  editHint?: TextEditHint | null,
): DiffBlock[] {
  if (editHint) {
    const hStart = Math.max(0, Math.min(prevText.length, Math.min(editHint.start, editHint.end)));
    const hEnd = Math.max(0, Math.min(prevText.length, Math.max(editHint.start, editHint.end)));
    const removedLen = hEnd - hStart;
    const insertedLen = nextText.length - (prevText.length - removedLen);
    if (
      insertedLen >= 0
      && prevText.slice(0, hStart) === nextText.slice(0, hStart)
      && prevText.slice(hEnd) === nextText.slice(hStart + insertedLen)
    ) {
      const hintedBlocks: DiffBlock[] = [];
      if (hStart > 0) {
        appendDiffBlock(hintedBlocks, { kind: "equal", prevStart: 0, prevEnd: hStart, nextStart: 0, nextEnd: hStart });
      }
      if (removedLen > 0 || insertedLen > 0) {
        // 选区外侧强制锚定 equal，选区内部继续细化 diff（使全选粘贴仍能保留未改中间句，而删首句能精准保次句）
        diffArbitrarySpan(
          prevText.slice(hStart, hEnd),
          nextText.slice(hStart, hStart + insertedLen),
          hStart,
          hStart,
          hintedBlocks,
        );
      }
      if (hEnd < prevText.length) {
        appendDiffBlock(hintedBlocks, {
          kind: "equal",
          prevStart: hEnd,
          prevEnd: prevText.length,
          nextStart: hStart + insertedLen,
          nextEnd: nextText.length,
        });
      }
      return hintedBlocks;
    }
  }

  const blocks: DiffBlock[] = [];
  diffArbitrarySpan(prevText, nextText, 0, 0, blocks);
  return blocks;
}

/**
 * 教师修改【改后全段】或【完整范文】时，结合选区编辑提示与两级码点 diff 平滑迁移已有标线区间：
 * 支持精准区分删除重复句中的哪一句，也支持数万字长段首尾同时粘贴替换时保留中间未改标线。
 */
export function reconcileQuotesOnRevisedTextChange<
  T extends {
    advice: string;
    revisedQuotes?: Array<string | string[]>;
    revisedRanges?: PersistedQuoteRange[];
  },
>(
  prevRevisedText: string,
  nextRevisedText: string,
  prevSuggestions: readonly T[],
  editHint?: TextEditHint | null,
): T[] {
  if (prevRevisedText === nextRevisedText) return [...prevSuggestions];
  const hadRanges = prevSuggestions.some((suggestion) => Array.isArray(suggestion.revisedRanges));
  const hasExplicit = hadRanges || prevSuggestions.some((suggestion) => Array.isArray(suggestion.revisedQuotes));
  if (!hasExplicit) return [...prevSuggestions];

  const collapsed = collapseParagraphSuggestions([...prevSuggestions])[0];
  if (!collapsed) return [...prevSuggestions];
  const { revisedQuotes: _q, revisedRanges: _r, ...base } = collapsed;
  void _q;
  void _r;
  const actionCount = Math.min(splitParagraphActions(collapsed.advice).length, MAX_ACTIONS_WITH_QUOTES);
  if (actionCount === 0) {
    const emptyQuotes: Array<string | string[]> = [];
    const emptyRanges: PersistedQuoteRange[] = [];
    return [{
      ...base,
      revisedQuotes: emptyQuotes,
      ...(hadRanges ? { revisedRanges: emptyRanges } : {}),
    } as unknown as T];
  }

  const exactPrev = locateRevisedQuotes(prevRevisedText, [collapsed]);
  const prevRanges = exactPrev
    ?? locateAvailableRanges(prevRevisedText, [collapsed], actionCount);
  if (!hadRanges && exactPrev === null && prevRanges.length === 0) {
    return [{ ...base } as unknown as T];
  }
  const blocks = computeCodePointDiffBlocks(prevRevisedText, nextRevisedText, editHint);

  const mapped: QuoteRange[] = [];
  for (const range of prevRanges) {
    let minNextStart = Number.POSITIVE_INFINITY;
    let maxNextEnd = -1;
    for (const block of blocks) {
      if (block.kind === "equal") {
        const ovStart = Math.max(range.start, block.prevStart);
        const ovEnd = Math.min(range.end, block.prevEnd);
        if (ovEnd > ovStart) {
          const nStart = block.nextStart + (ovStart - block.prevStart);
          const nEnd = block.nextStart + (ovEnd - block.prevStart);
          minNextStart = Math.min(minNextStart, nStart);
          maxNextEnd = Math.max(maxNextEnd, nEnd);
        }
      } else if (block.prevStart === block.prevEnd) {
        if (range.start < block.prevStart && block.prevStart < range.end && block.nextEnd > block.nextStart) {
          minNextStart = Math.min(minNextStart, block.nextStart);
          maxNextEnd = Math.max(maxNextEnd, block.nextEnd);
        }
      } else if (range.start <= block.prevStart && block.prevEnd <= range.end && block.nextEnd > block.nextStart) {
        minNextStart = Math.min(minNextStart, block.nextStart);
        maxNextEnd = Math.max(maxNextEnd, block.nextEnd);
      }
    }
    if (maxNextEnd > minNextStart && Number.isFinite(minNextStart)) {
      mapped.push({ start: minNextStart, end: maxNextEnd, actionIndex: range.actionIndex });
    }
  }

  return [{
    ...base,
    ...buildQuoteFields(nextRevisedText, mapped, actionCount, hadRanges),
  } as unknown as T];
}

/** 新报告落库前：摘录与 revisedText / 动作条数对不上就整条删掉，渲染时退回单下划线。 */
export function sanitizeRevisedQuotes<T extends { suggestions: SuggestionLike[]; revisedText: string }>(review: T): T {
  if (!review.suggestions.some((suggestion) => suggestion.revisedQuotes !== undefined || suggestion.revisedRanges !== undefined)) {
    return review;
  }
  if (locateRevisedQuotes(review.revisedText, review.suggestions)) return review;
  return {
    ...review,
    suggestions: review.suggestions.map((suggestion) => {
      const { revisedQuotes: _droppedQuotes, revisedRanges: _droppedRanges, ...rest } = suggestion;
      void _droppedQuotes;
      void _droppedRanges;
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
  if (suggestions.length > 0 && paragraphActions(suggestions).length === 0) {
    return revisedText ? [{ kind: "unchanged", text: revisedText }] : [];
  }
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
