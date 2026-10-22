import type { ParagraphReview } from "./contracts";

export interface SourceParagraph {
  id: string;
  paragraphIndex: number;
  text: string;
  segments: Array<{ pageIndex: number }>;
}

export interface ResolvedReviewGroup<T extends SourceParagraph = SourceParagraph> {
  reviewIndex: number;
  review: ParagraphReview;
  paragraphs: T[];
  sourceText: string;
  sourceLabel: string | null;
  pageIndex: number | undefined;
}

type ReviewRange = Pick<ParagraphReview, "paragraphId" | "sourceParagraphStart" | "sourceParagraphEnd" | "noSourceParagraph">;

export const NO_SOURCE_PARAGRAPH_LABEL = "原文无对应段，整段新增";
export const NO_SOURCE_PARAGRAPH_ACTION = "原文没有对应的段落，本段按完整范文整段新增。";

export function paragraphReviewUsesGroups(reviews: readonly ReviewRange[]): boolean {
  return reviews.some((review) => (
    review.sourceParagraphStart !== undefined
    || review.sourceParagraphEnd !== undefined
    || review.noSourceParagraph === true
  ));
}

/**
 * 把原文 paragraphCount 个自然段分给 groupCount 个范文段。
 * 原文段数够时连续均分；不够时把原文段均匀摊到范文段上，其余范文段返回 null（原文无对应段）。
 */
export function allocateSourceRanges(
  paragraphCount: number,
  groupCount: number,
): Array<{ start: number; end: number } | null> {
  if (groupCount < 1) return [];
  if (paragraphCount >= groupCount) {
    const base = Math.floor(paragraphCount / groupCount);
    let remainder = paragraphCount % groupCount;
    let start = 1;
    return Array.from({ length: groupCount }, () => {
      const size = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      const range = { start, end: start + size - 1 };
      start = range.end + 1;
      return range;
    });
  }
  const slots: Array<{ start: number; end: number } | null> = Array.from({ length: groupCount }, () => null);
  for (let index = 0; index < paragraphCount; index += 1) {
    const position = paragraphCount === 1 ? 0 : Math.round((index * (groupCount - 1)) / (paragraphCount - 1));
    slots[position] = { start: index + 1, end: index + 1 };
  }
  return slots;
}

export function sourceParagraphLabel(start: number, end: number): string {
  return start === end
    ? `对应原文第 ${start} 段`
    : `对应原文第 ${start}–${end} 段`;
}

export function paragraphReviewCoverageMessage(
  reviews: readonly ReviewRange[],
  expectedIds: readonly string[],
): string | null {
  if (!paragraphReviewUsesGroups(reviews)) {
    const actualIds = reviews.map(({ paragraphId }) => paragraphId);
    if (new Set(actualIds).size !== actualIds.length) {
      return "paragraphReviews must use unique paragraphId values";
    }
    if (
      actualIds.length !== expectedIds.length
      || actualIds.some((paragraphId, index) => paragraphId !== expectedIds[index])
    ) {
      return "paragraphReviews paragraphId values must exactly match OCR paragraphs in order";
    }
    return null;
  }

  if (reviews.some((review) => (
    !review.noSourceParagraph
    && (review.sourceParagraphStart === undefined || review.sourceParagraphEnd === undefined)
  ))) {
    return "paragraphReviews must cover original paragraphs in order";
  }
  const actualIds = reviews.map(({ paragraphId }) => paragraphId);
  if (new Set(actualIds).size !== actualIds.length) {
    return "paragraphReviews must use unique paragraphId values";
  }
  const sourced = reviews.filter((review) => !review.noSourceParagraph);
  if (sourced.length === 0) return "paragraphReviews must cover original paragraphs in order";
  if (reviews.some((review) => review.noSourceParagraph && expectedIds.includes(review.paragraphId))) {
    return "paragraphReviews must use unique paragraphId values";
  }
  let cursor = 0;
  for (const review of sourced) {
    const start = review.sourceParagraphStart ?? 0;
    const end = review.sourceParagraphEnd ?? 0;
    if (start !== cursor + 1 || end < start || end > expectedIds.length) {
      return "paragraphReviews must cover original paragraphs in order";
    }
    if (review.paragraphId !== expectedIds[start - 1]) {
      return "paragraphReviews must cover original paragraphs in order";
    }
    cursor = end;
  }
  if (cursor !== expectedIds.length) {
    return "paragraphReviews must cover original paragraphs in order";
  }
  return null;
}

export function resolveReviewGroups<T extends SourceParagraph>(
  reviews: readonly ParagraphReview[],
  paragraphs: readonly T[],
): ResolvedReviewGroup<T>[] {
  const ordered = [...paragraphs].sort((left, right) => left.paragraphIndex - right.paragraphIndex);
  if (!paragraphReviewUsesGroups(reviews)) {
    return ordered.flatMap((paragraph) => {
      const reviewIndex = reviews.findIndex(({ paragraphId }) => paragraphId === paragraph.id);
      const review = reviews[reviewIndex];
      if (!review) return [];
      return [{
        reviewIndex,
        review,
        paragraphs: [paragraph],
        sourceText: paragraph.text,
        sourceLabel: null,
        pageIndex: paragraph.segments[0]?.pageIndex,
      }];
    });
  }

  const resolved = reviews.map((review, reviewIndex) => {
    if (review.noSourceParagraph) {
      return {
        reviewIndex,
        review,
        paragraphs: [] as T[],
        sourceText: "",
        sourceLabel: NO_SOURCE_PARAGRAPH_LABEL,
        pageIndex: undefined as number | undefined,
      };
    }
    const start = review.sourceParagraphStart ?? 0;
    const end = review.sourceParagraphEnd ?? 0;
    const group = ordered.filter((paragraph) => {
      const number = paragraph.paragraphIndex + 1;
      return number >= start && number <= end;
    });
    return {
      reviewIndex,
      review,
      paragraphs: group,
      sourceText: group.map(({ text }) => text).join(""),
      sourceLabel: start > 0 && end >= start ? sourceParagraphLabel(start, end) : null,
      pageIndex: group[0]?.segments[0]?.pageIndex,
    };
  });
  // 没有原文的段跟在前一组（或后一组）的页上，导出时才有位置可放。
  return resolved.map((group, index) => {
    if (!group.review.noSourceParagraph) return group;
    const before = resolved.slice(0, index).reverse().find((item) => item.pageIndex !== undefined);
    const after = resolved.slice(index + 1).find((item) => item.pageIndex !== undefined);
    return { ...group, pageIndex: before?.pageIndex ?? after?.pageIndex };
  });
}
