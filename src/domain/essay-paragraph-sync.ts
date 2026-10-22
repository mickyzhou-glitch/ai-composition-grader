import {
  paragraphEvaluationReportSchema,
  type ParagraphEvaluationReport,
} from "./contracts";

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

export function essayDiffersFromParagraphReviews(
  report: Pick<ParagraphEvaluationReport, "rewrittenEssay" | "paragraphReviews">,
): boolean {
  const essay = report.rewrittenEssay;
  if (!essay?.length) return false;
  const texts = splitEssayIntoReviewParagraphs(essay, report.paragraphReviews.length);
  if (!texts) return true;
  return report.paragraphReviews.some((review, index) => review.revisedText !== texts[index]);
}

export function applyEssayToParagraphReviews(
  report: ParagraphEvaluationReport,
): ParagraphEvaluationReport {
  const essay = report.rewrittenEssay;
  if (!essay?.length) return report;
  const texts = splitEssayIntoReviewParagraphs(essay, report.paragraphReviews.length);
  if (!texts) return report;
  if (report.paragraphReviews.every((review, index) => review.revisedText === texts[index])) {
    return report;
  }
  return {
    ...report,
    paragraphReviews: report.paragraphReviews.map((review, index) => (
      review.revisedText === texts[index]
        ? review
        : { ...review, revisedText: texts[index] ?? review.revisedText }
    )),
  };
}

export interface ReviewedEssaySource {
  id: string;
  studentName: string;
  title: string;
  teacherReviewedAt: Date | number | string | null;
  deletingAt?: Date | number | string | null;
  report: unknown;
}

export interface ReviewedEssayRepair {
  id: string;
  studentName: string;
  title: string;
  report: ParagraphEvaluationReport;
}

/** 只修复已经审核过、且改后全段与完整范文按同一切分对不上的作文。 */
export function planReviewedEssayRepair(source: ReviewedEssaySource): ReviewedEssayRepair | null {
  if (source.teacherReviewedAt == null || source.deletingAt != null) return null;
  const parsed = paragraphEvaluationReportSchema.safeParse(source.report);
  if (!parsed.success || !parsed.data.rewrittenEssay?.length) return null;
  if (!essayDiffersFromParagraphReviews(parsed.data)) return null;
  const report = applyEssayToParagraphReviews(parsed.data);
  if (report === parsed.data) return null;
  return {
    id: source.id,
    studentName: source.studentName,
    title: source.title,
    report,
  };
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
