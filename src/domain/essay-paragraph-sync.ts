import {
  isParagraphEvaluationReport,
  type EvaluationReport,
  type ParagraphEvaluationReport,
  type ParagraphReview,
  type ParagraphSuggestion,
} from "./contracts";
import { UNCHANGED_PARAGRAPH_ACTION } from "./paragraph-actions";
import {
  NO_SOURCE_PARAGRAPH_ACTION,
  allocateSourceRanges,
  paragraphReviewUsesGroups,
} from "./paragraph-review-groups";

const sentenceTerminal = /[.!?。！？…](?:["'”’」』】）》〉）])*\s*$/u;

/**
 * 以完整范文为唯一来源，切成与逐段「改后全段」同样数量的段落。
 * 段数相同（常见是五段对五段）时逐段原样复制，不再把一段拆开。
 * 范文段数更多时，按顺序均匀并进现有框。
 * 范文段数更少时，先按句子切开，句子仍不够再按字均分，保证每一框都被覆盖。
 * 字数少到无法分成那么多非空段时返回 null。
 */
export function splitEssayIntoReviewParagraphs(
  essay: readonly string[],
  reviewCount: number,
): string[] | null {
  if (reviewCount < 1 || essay.length === 0) return null;
  if (essay.length === reviewCount) return [...essay];
  if (essay.length > reviewCount) return groupUnits(essay, reviewCount);
  const sentences = essay.flatMap((paragraph) => splitSentences(paragraph));
  const units = sentences.length >= reviewCount
    ? sentences
    : graphemes(essay.join(""));
  if (units.length < reviewCount) return null;
  return groupUnits(units, reviewCount);
}

/** 逐段与完整范文段数或文字不同就算不一致。分段一律以完整范文为准。 */
export function essayDiffersFromParagraphReviews(
  report: Pick<ParagraphEvaluationReport, "rewrittenEssay" | "paragraphReviews">,
): boolean {
  const essay = report.rewrittenEssay;
  if (!essay?.length) return false;
  if (essay.length !== report.paragraphReviews.length) return true;
  return report.paragraphReviews.some((review, index) => review.revisedText !== essay[index]);
}

/** 原有报告里各段在原文中的段号（1 起）。读不到时返回 null。 */
function reviewSourceNumbers(review: ParagraphReview, reviewIndex: number, grouped: boolean): number[] {
  if (!grouped) return [reviewIndex + 1];
  if (review.noSourceParagraph) return [];
  const start = review.sourceParagraphStart ?? 0;
  const end = review.sourceParagraphEnd ?? 0;
  const numbers: number[] = [];
  for (let number = start; number <= end && number > 0; number += 1) numbers.push(number);
  return numbers;
}

function mergedSuggestions(covered: readonly ParagraphReview[]): ParagraphSuggestion[] {
  if (covered.length === 1) return covered[0]!.suggestions.slice(0, 4);
  const lines = covered.flatMap((review) => review.suggestions.map((item) => item.advice.trim())).filter(Boolean);
  const unique = [...new Set(lines)];
  if (unique.length === 0) return [{ advice: UNCHANGED_PARAGRAPH_ACTION }];
  if (unique.length === 1) return [{ advice: unique[0]! }];
  return [{ advice: unique.map((line, index) => `${index + 1}. ${line}`).join("\n") }];
}

/**
 * 按完整范文的段数重建逐段：第 i 段改后全段就是范文第 i 段。
 * 原文段数够时连续均分覆盖全部原文；不够时原文段均匀摊开，其余段标为原文无对应段（整段新增）。
 * 原文段数与范文相同时保持一一对应，不写段号范围。
 */
export function buildModelParagraphReviews(
  existing: readonly ParagraphReview[],
  essay: readonly string[],
  ocrParagraphIds: readonly string[],
): ParagraphReview[] {
  const grouped = paragraphReviewUsesGroups(existing);
  const ranges = allocateSourceRanges(ocrParagraphIds.length, essay.length);
  let extra = ocrParagraphIds.length;
  const taken = new Set(ocrParagraphIds);
  const nextExtraId = () => {
    let id: string;
    do {
      extra += 1;
      id = `paragraph-${extra}`;
    } while (taken.has(id));
    taken.add(id);
    return id;
  };
  return essay.map((text, index) => {
    const range = ranges[index] ?? null;
    if (!range) {
      return {
        paragraphId: nextExtraId(),
        suggestions: [{ advice: NO_SOURCE_PARAGRAPH_ACTION }],
        revisedText: text,
        noSourceParagraph: true as const,
      };
    }
    const covered = existing.filter((review, reviewIndex) => (
      reviewSourceNumbers(review, reviewIndex, grouped).some((number) => number >= range.start && number <= range.end)
    ));
    const review: ParagraphReview = {
      paragraphId: ocrParagraphIds[range.start - 1] ?? `paragraph-${range.start}`,
      suggestions: covered.length ? mergedSuggestions(covered) : [{ advice: UNCHANGED_PARAGRAPH_ACTION }],
      revisedText: text,
    };
    if (ocrParagraphIds.length === essay.length) return review;
    return { ...review, sourceParagraphStart: range.start, sourceParagraphEnd: range.end };
  });
}

/**
 * 「同步到逐段」：以完整范文为准。段数相同只覆盖改后全段；段数不同按范文段数重建逐段。
 * 重建需要原文段落 id；没有传入时只在段数相同时覆盖文字。
 */
export function applyEssayToParagraphReviews(
  report: ParagraphEvaluationReport,
  ocrParagraphIds?: readonly string[],
): ParagraphEvaluationReport {
  const essay = report.rewrittenEssay;
  if (!essay?.length) return report;
  if (essay.length === report.paragraphReviews.length) {
    if (report.paragraphReviews.every((review, index) => review.revisedText === essay[index])) return report;
    return {
      ...report,
      paragraphReviews: report.paragraphReviews.map((review, index) => (
        review.revisedText === essay[index] ? review : { ...review, revisedText: essay[index]! }
      )),
    };
  }
  if (!ocrParagraphIds?.length) return report;
  return { ...report, paragraphReviews: buildModelParagraphReviews(report.paragraphReviews, essay, ocrParagraphIds) };
}

function groupUnits(units: readonly string[], groups: number): string[] {
  const base = Math.floor(units.length / groups);
  let remainder = units.length % groups;
  const result: string[] = [];
  let cursor = 0;
  for (let index = 0; index < groups; index += 1) {
    const size = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    result.push(units.slice(cursor, cursor + size).join(""));
    cursor += size;
  }
  return result;
}

function splitSentences(value: string): string[] {
  const result: string[] = [];
  let pending = "";
  for (const { segment } of new Intl.Segmenter("zh-CN", { granularity: "sentence" }).segment(value)) {
    pending += segment;
    if (sentenceTerminal.test(pending)) {
      result.push(pending);
      pending = "";
    }
  }
  if (pending.length > 0) result.push(pending);
  return result.length > 0 ? result : [value];
}

function graphemes(value: string): string[] {
  return Array.from(
    new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(value),
    ({ segment }) => segment,
  );
}

/**
 * 以逐段 `paragraphReviews[].revisedText` 为唯一编辑源，派生完整范文数组。
 */
export function deriveEssayFromParagraphReviews(
  paragraphReviews: readonly Pick<ParagraphReview, "revisedText">[],
): string[] {
  return paragraphReviews.map((review) => review.revisedText);
}

/**
 * 以 `paragraphReviews[].revisedText` 刷新 `rewrittenEssay`。
 * 已一致时原样返回同一对象。
 */
export function syncEssayFromParagraphReviews<T extends ParagraphEvaluationReport>(
  report: T,
): T {
  const derived = deriveEssayFromParagraphReviews(report.paragraphReviews);
  const existing = report.rewrittenEssay;
  if (
    existing
    && existing.length === derived.length
    && existing.every((paragraph, index) => paragraph === derived[index])
  ) {
    return report;
  }
  return {
    ...report,
    rewrittenEssay: derived,
  };
}

/**
 * 审核通过、保存或导出前以 `paragraphReviews[].revisedText` 为唯一权威来源刷新 `rewrittenEssay`，
 * 严禁再用旧的 `rewrittenEssay` 反向覆盖老师修改过的逐段文本。
 */
export function syncEssayBeforeApproval<T extends EvaluationReport>(
  report: T,
  _ocr?: object | null,
): T {
  if (!isParagraphEvaluationReport(report) || !report.rewrittenEssay?.length) return report;
  return syncEssayFromParagraphReviews(report) as T;
}
