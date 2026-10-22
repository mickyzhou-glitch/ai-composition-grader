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

type ReviewRange = Pick<ParagraphReview, "paragraphId" | "sourceParagraphStart" | "sourceParagraphEnd">;

export function paragraphReviewUsesGroups(reviews: readonly ReviewRange[]): boolean {
  return reviews.some((review) => (
    review.sourceParagraphStart !== undefined || review.sourceParagraphEnd !== undefined
  ));
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
    review.sourceParagraphStart === undefined || review.sourceParagraphEnd === undefined
  ))) {
    return "paragraphReviews must cover original paragraphs in order";
  }
  const actualIds = reviews.map(({ paragraphId }) => paragraphId);
  if (new Set(actualIds).size !== actualIds.length) {
    return "paragraphReviews must use unique paragraphId values";
  }
  let cursor = 0;
  for (const review of reviews) {
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

  return reviews.map((review, reviewIndex) => {
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
}
