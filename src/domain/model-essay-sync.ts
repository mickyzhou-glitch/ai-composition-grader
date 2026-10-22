import {
  paragraphEvaluationReportSchema,
  type ParagraphEvaluationReport,
  type ParagraphReview,
  type ParagraphSuggestion,
} from "./contracts";
import { UNCHANGED_PARAGRAPH_ACTION } from "./paragraph-actions";
import { buildModelParagraphReviews, splitEssayIntoReviewParagraphs } from "./essay-paragraph-sync";
import {
  paragraphReviewCoverageMessage,
  paragraphReviewUsesGroups,
} from "./paragraph-review-groups";

/** 老师没写明段数时，段数不同的范文按五段结构切开。 */
export const DEFAULT_MODEL_ESSAY_PARAGRAPH_COUNT = 5;

const structureNumbers: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

/**
 * 与批改时识别结构段数的规则相同：段式、严格 N 段、改为 N 段，
 * 或结构要求里连续的「第1段…第N段」。没有写明则返回 undefined。
 */
export function explicitStructureParagraphCount(text: string | undefined): number | undefined {
  const source = text?.trim() ?? "";
  if (!source) return undefined;
  const valueOf = (value: string) => structureNumbers[value] ?? Number(value);
  const count = "([一二两三四五六七八九十]|10|[1-9])";
  const explicit = new RegExp(
    `(?:^|[^第\\d])${count}(?:段式|个(?:自然段|段落))|(?:^|共|分成|分为|改成|改为|写成|调整为|严格|恰好|必须|要求)\\s*${count}\\s*(?:个)?(?:自然)?段(?:落)?`,
    "gu",
  );
  const last = [...source.matchAll(explicit)].at(-1);
  const raw = last?.[1] ?? last?.[2];
  if (raw) {
    const value = valueOf(raw);
    if (value >= 1 && value <= 10) return value;
  }
  const headings = [...source.matchAll(/第([一二三四五六七八九十]|10|[1-9])段/gu)]
    .map((match) => valueOf(match[1] ?? ""));
  const unique = [...new Set(headings)].sort((left, right) => left - right);
  if (unique.length >= 2 && unique.length <= 10 && unique.every((value, index) => value === index + 1)) {
    return unique.length;
  }
  return undefined;
}

export function modelEssayParagraphCount(structureRequirements: string | undefined): number {
  return explicitStructureParagraphCount(structureRequirements) ?? DEFAULT_MODEL_ESSAY_PARAGRAPH_COUNT;
}

export interface ModelEssaySyncSource {
  id: string;
  studentName: string;
  title: string;
  structureRequirements?: string;
  teacherReviewedAt: Date | number | string | null;
  deletingAt?: Date | number | string | null;
  report: unknown;
  /** 原文自然段 id，按阅读顺序。段数要改时用来重排覆盖范围。 */
  ocrParagraphIds?: readonly string[] | null;
}

export interface ModelEssaySyncChange {
  id: string;
  studentName: string;
  title: string;
  beforeEssayCount: number;
  beforeReviewCount: number;
  afterEssayCount: number;
  afterReviewCount: number;
  summary: string;
  report: ParagraphEvaluationReport;
}

export type ModelEssaySyncPlan =
  | { status: "out_of_scope" }
  | { status: "unchanged" }
  | { status: "skipped"; reason: string }
  | { status: "blocked"; reason: string }
  | { status: "change"; change: ModelEssaySyncChange };

function asJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** 从已保存的 OCR 检查点读出原文段落 id。没有 id 时按 paragraph-1 起补。 */
export function ocrParagraphIdsFromCheckpoint(value: unknown): string[] | null {
  const checkpoint = asJson(value);
  if (!checkpoint || typeof checkpoint !== "object") return null;
  const paragraphs = (checkpoint as { paragraphs?: unknown }).paragraphs;
  if (!Array.isArray(paragraphs) || paragraphs.length < 1) return null;
  return paragraphs.map((paragraph, index) => {
    if (paragraph && typeof paragraph === "object") {
      const id = (paragraph as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0) return id;
    }
    return `paragraph-${index + 1}`;
  });
}

function inferOcrParagraphIds(reviews: readonly ParagraphReview[]): string[] | null {
  if (paragraphReviewUsesGroups(reviews)) {
    let cursor = 0;
    const ids: string[] = [];
    for (const review of reviews) {
      const start = review.sourceParagraphStart;
      const end = review.sourceParagraphEnd;
      if (start === undefined || end === undefined || start !== cursor + 1 || end < start) return null;
      if (review.paragraphId !== `paragraph-${start}`) return null;
      for (let number = start; number <= end; number += 1) ids.push(`paragraph-${number}`);
      cursor = end;
    }
    return ids.length > 0 ? ids : null;
  }
  if (reviews.every((review, index) => review.paragraphId === `paragraph-${index + 1}`)) {
    return reviews.map((review) => review.paragraphId);
  }
  return null;
}

function clip(value: string): string {
  const flat = value.replace(/\s+/gu, "");
  return flat.length > 18 ? `${flat.slice(0, 18)}…` : flat;
}

function textSummary(reviews: readonly ParagraphReview[], essay: readonly string[]): string {
  const diffs = essay.filter((text, index) => reviews[index]?.revisedText !== text).length;
  const first = essay.findIndex((text, index) => reviews[index]?.revisedText !== text);
  const left = clip(reviews[first]?.revisedText ?? "");
  const right = clip(essay[first] ?? "");
  return `内容不一致：${diffs} 段改后全段与完整范文不同，将按完整范文逐字覆盖。段数保持 ${essay.length}。第 ${first + 1} 段「${left}」→「${right}」。`;
}

function countSummary(
  beforeEssay: readonly string[],
  beforeReviewCount: number,
  texts: readonly string[],
): string {
  const essayNote = beforeEssay.length === texts.length
    ? `完整范文已是 ${texts.length} 段，正文不改`
    : `完整范文原为 ${beforeEssay.length} 段，按原文切成 ${texts.length} 段`;
  return `段数不同：段落范文 ${beforeReviewCount} 段改为 ${texts.length} 段。${essayNote}。两边改为逐字相同。改后第 1 段起「${clip(texts[0] ?? "")}」。`;
}

function evenRanges(paragraphCount: number, groupCount: number): Array<{ start: number; end: number }> {
  const base = Math.floor(paragraphCount / groupCount);
  let remainder = paragraphCount % groupCount;
  let start = 1;
  return Array.from({ length: groupCount }, () => {
    const size = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    const end = start + size - 1;
    const range = { start, end };
    start = end + 1;
    return range;
  });
}

function suggestionsFor(covered: readonly ParagraphReview[]): ParagraphSuggestion[] {
  if (covered.length === 1) return covered[0]!.suggestions.slice(0, 4);
  const lines = covered.flatMap((review) => review.suggestions.map((item) => item.advice.trim())).filter(Boolean);
  const unique = [...new Set(lines)];
  if (unique.length === 0) return [{ advice: UNCHANGED_PARAGRAPH_ACTION }];
  if (unique.length === 1) return [{ advice: unique[0]! }];
  return [{ advice: unique.map((line, index) => `${index + 1}. ${line}`).join("\n") }];
}

function rebuildParagraphReviews(
  existing: readonly ParagraphReview[],
  texts: readonly string[],
  ocrParagraphIds: readonly string[],
): ParagraphReview[] {
  const grouped = paragraphReviewUsesGroups(existing);
  return evenRanges(ocrParagraphIds.length, texts.length).map((range, index) => {
    const covered = existing.filter((review, reviewIndex) => {
      if (!grouped) {
        const number = reviewIndex + 1;
        return number >= range.start && number <= range.end;
      }
      const start = review.sourceParagraphStart ?? 0;
      const end = review.sourceParagraphEnd ?? 0;
      return start <= range.end && end >= range.start;
    });
    const review: ParagraphReview = {
      paragraphId: ocrParagraphIds[range.start - 1] ?? `paragraph-${range.start}`,
      suggestions: suggestionsFor(covered),
      revisedText: texts[index] ?? "",
    };
    if (ocrParagraphIds.length === texts.length) return review;
    return {
      ...review,
      sourceParagraphStart: range.start,
      sourceParagraphEnd: range.end,
    };
  });
}

function finishChange(
  source: ModelEssaySyncSource,
  beforeEssayCount: number,
  beforeReviewCount: number,
  summary: string,
  report: ParagraphEvaluationReport,
): ModelEssaySyncPlan {
  const essay = report.rewrittenEssay ?? [];
  if (essay.length !== report.paragraphReviews.length) {
    return { status: "blocked", reason: "同步后完整范文与段落范文段数仍不同" };
  }
  if (essay.some((text, index) => text !== report.paragraphReviews[index]?.revisedText)) {
    return { status: "blocked", reason: "同步后两边文字仍不一致" };
  }
  const checked = paragraphEvaluationReportSchema.safeParse(report);
  if (!checked.success) return { status: "blocked", reason: "同步后的报告无法通过格式校验" };
  return {
    status: "change",
    change: {
      id: source.id,
      studentName: source.studentName,
      title: source.title,
      beforeEssayCount,
      beforeReviewCount,
      afterEssayCount: essay.length,
      afterReviewCount: report.paragraphReviews.length,
      summary,
      report: checked.data,
    },
  };
}

/**
 * 已审核作文以完整范文为准。
 * 段数相同只覆盖改后全段；段数不同则把完整范文切成老师结构段数（默认五段），两边写成同一份。
 * 未审核、已删除、已经逐字一致的不改。
 */
export interface ModelEssaySyncOptions {
  /**
   * 段数一律以完整范文为准，不受原文段数限制。
   * 原文段数不够时，对不上原文的范文段标为原文无对应段，导出时整段按新增划线。
   */
  followModelParagraphs?: boolean;
}

function followModelPlan(
  source: ModelEssaySyncSource,
  report: ParagraphEvaluationReport,
  essay: readonly string[],
): ModelEssaySyncPlan {
  const reviews = report.paragraphReviews;
  if (essay.some((text) => text.trim().length === 0 || /[\r\n]/u.test(text))) {
    return { status: "blocked", reason: "完整范文里有空段或段内换行" };
  }
  const ocrParagraphIds = source.ocrParagraphIds?.length
    ? [...source.ocrParagraphIds]
    : inferOcrParagraphIds(reviews);
  if (!ocrParagraphIds) {
    return { status: "blocked", reason: "段数不同，但读不到原文段落，无法重排段落范文" };
  }
  const paragraphReviews = buildModelParagraphReviews(reviews, essay, ocrParagraphIds);
  if (paragraphReviewCoverageMessage(paragraphReviews, ocrParagraphIds)) {
    return { status: "blocked", reason: "按范文分段后无法按原文顺序覆盖" };
  }
  const sourceless = paragraphReviews.filter((review) => review.noSourceParagraph).length;
  const note = sourceless > 0
    ? `原文只有 ${ocrParagraphIds.length} 段，${sourceless} 段范文没有对应原文，按整段新增处理`
    : `原文 ${ocrParagraphIds.length} 段按顺序分到 ${essay.length} 段`;
  return finishChange(
    source,
    essay.length,
    reviews.length,
    `段数不同：段落范文 ${reviews.length} 段改为完整范文的 ${essay.length} 段，正文不改。${note}。两边改为逐字相同。改后第 1 段起「${clip(essay[0] ?? "")}」。`,
    { ...report, paragraphReviews },
  );
}

export function planModelEssaySync(
  source: ModelEssaySyncSource,
  options: ModelEssaySyncOptions = {},
): ModelEssaySyncPlan {
  if (source.teacherReviewedAt == null || source.deletingAt != null) return { status: "out_of_scope" };
  const parsed = paragraphEvaluationReportSchema.safeParse(asJson(source.report));
  if (!parsed.success) return { status: "skipped", reason: "不是可读取的逐段批改报告" };
  const essay = parsed.data.rewrittenEssay;
  if (!essay?.length) return { status: "skipped", reason: "没有完整范文，无法作为准绳" };
  const reviews = parsed.data.paragraphReviews;
  if (essay.length === reviews.length && reviews.every((review, index) => review.revisedText === essay[index])) {
    return { status: "unchanged" };
  }
  if (essay.length === reviews.length) {
    return finishChange(
      source,
      essay.length,
      reviews.length,
      textSummary(reviews, essay),
      {
        ...parsed.data,
        paragraphReviews: reviews.map((review, index) => (
          review.revisedText === essay[index] ? review : { ...review, revisedText: essay[index]! }
        )),
      },
    );
  }

  if (options.followModelParagraphs) return followModelPlan(source, parsed.data, essay);

  const target = modelEssayParagraphCount(source.structureRequirements);
  const texts = essay.length === target ? [...essay] : splitEssayIntoReviewParagraphs(essay, target);
  if (!texts || texts.some((text) => text.trim().length === 0 || /[\r\n]/u.test(text))) {
    return { status: "blocked", reason: `完整范文无法切成 ${target} 段非空正文` };
  }
  const ocrParagraphIds = source.ocrParagraphIds?.length
    ? [...source.ocrParagraphIds]
    : inferOcrParagraphIds(reviews);
  if (!ocrParagraphIds) {
    return { status: "blocked", reason: "段数不同，但读不到原文段落，无法重排段落范文并仍覆盖原文" };
  }
  if (ocrParagraphIds.length < target) {
    return {
      status: "blocked",
      reason: `原文只有 ${ocrParagraphIds.length} 段，少于要切成的 ${target} 段，无法每段范文都对应到原文`,
    };
  }
  const paragraphReviews = rebuildParagraphReviews(reviews, texts, ocrParagraphIds);
  const coverage = paragraphReviewCoverageMessage(paragraphReviews, ocrParagraphIds);
  if (coverage) return { status: "blocked", reason: "切段后无法按原文顺序覆盖" };
  return finishChange(
    source,
    essay.length,
    reviews.length,
    countSummary(essay, reviews.length, texts),
    { ...parsed.data, rewrittenEssay: [...texts], paragraphReviews },
  );
}
