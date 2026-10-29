import {
  isLegacyEvaluationReport,
  paragraphEvaluationReportSchema,
  type ParagraphSuggestion,
} from "@/src/domain/contracts";
import { mergedParagraphAction } from "@/src/domain/paragraph-actions";
import { paragraphReviewUsesGroups, resolveReviewGroups } from "@/src/domain/paragraph-review-groups";
import {
  deliveryReadiness,
  type DeliveryReadinessInput,
} from "@/src/delivery/readiness";
import type { PublicOcrView } from "@/src/ocr/contracts";
import { buildSentenceRevisionRuns } from "@/src/revisions/revision-diff";

export const EXPORT_KAITI_FACE = '"LXGW WenKai"';
export const EXPORT_KAITI_FONT = `${EXPORT_KAITI_FACE}, "KaiTi", "STKaiti", "Kaiti SC", serif`;
export const REVISED_PARAGRAPH_LABEL = "改后全段：";
export const REWRITTEN_ESSAY_TITLE = "按要求重写的完整范文";
export const REWRITTEN_ESSAY_INDENT = "　　";

const ESSAY_PAGE_WIDTH = 841.89;
const ESSAY_PAGE_HEIGHT = 595.28;
const ESSAY_MARGIN = 32;
const ESSAY_LINE_HEIGHT = 24;
const graphemeSegmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

export class ExportContentError extends Error {
  constructor(
    readonly code: "LEGACY_REPORT" | "PDF_CONTENT_INCOMPLETE",
    message: string,
  ) {
    super(message);
    this.name = "ExportContentError";
  }
}

export type ExportRevisionRun = {
  text: string;
  changed: boolean;
};

export type ExportParagraph = {
  suggestions: ParagraphSuggestion[];
  revisionRuns: ExportRevisionRun[];
  sourceLabel?: string;
};

export type ExportRunStyle = "suggestion" | "demonstration" | "changed" | "plain";

export type ExportTextRun = {
  text: string;
  style: ExportRunStyle;
};

export type ExportImage = {
  id: number;
  position: number;
  width: number;
  height: number;
  mimeType?: string;
};

export type ExportReportPage = {
  image: ExportImage;
  paragraphs: ExportParagraph[];
};

export type ExportReportContent = {
  documentTitle: string;
  pages: ExportReportPage[];
  rewrittenEssay: string[];
};

export type RewrittenEssayPage = {
  title: string;
  lines: string[];
};

export type ExportReviewSource = DeliveryReadinessInput & {
  id: string;
  studentName: string;
  config: { title: string };
  images: ExportImage[];
  ocr: PublicOcrView | null;
};

function safeFilenamePart(value: string, fallback: string) {
  return value
    .replace(/[\\/:*?"<>|]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 60) || fallback;
}

export function exportDocumentTitle(review: Pick<ExportReviewSource, "studentName" | "config">) {
  const student = safeFilenamePart(review.studentName, "未填写学生姓名");
  const title = safeFilenamePart(review.config.title, "未命名作文");
  return `${student}${title}`;
}

export function exportOriginalImageUrl(reviewId: string, imageId: number) {
  return `/api/reviews/${encodeURIComponent(reviewId)}/files?imageId=${imageId}&variant=original`;
}

export function rewrittenEssayHeading(continued: boolean) {
  return continued ? `${REWRITTEN_ESSAY_TITLE}（续）` : REWRITTEN_ESSAY_TITLE;
}

export function rewrittenEssayLineText(paragraph: string) {
  return `${REWRITTEN_ESSAY_INDENT}${paragraph}`;
}

function graphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

function suggestionText(suggestions: ParagraphSuggestion[]) {
  return mergedParagraphAction(suggestions);
}

export function exportParagraphRuns(paragraph: ExportParagraph): ExportTextRun[] {
  return [
    { text: `${suggestionText(paragraph.suggestions)}\n`, style: "suggestion" as const },
    { text: REVISED_PARAGRAPH_LABEL, style: "demonstration" as const },
    ...paragraph.revisionRuns.map((run) => ({
      text: run.text,
      style: run.changed ? "changed" as const : "plain" as const,
    })),
  ];
}

export function exportFontSample(content: ExportReportContent) {
  return content.pages.flatMap((page) => (
    page.paragraphs.flatMap((paragraph) => exportParagraphRuns(paragraph).map((run) => run.text))
  )).join("")
    + content.rewrittenEssay.join("")
    + (content.rewrittenEssay.length ? rewrittenEssayHeading(true) : "");
}

function buildExportRevisionRuns(source: string, revised: string): ExportRevisionRun[] {
  const runs = buildSentenceRevisionRuns(source, revised).map((run) => ({
    text: run.text,
    changed: run.kind === "inserted",
  }));
  if (runs.map((run) => run.text).join("") !== revised) {
    throw new ExportContentError("PDF_CONTENT_INCOMPLETE", "改后全段未能完整排版，请重试");
  }
  return runs;
}

export function buildExportReportContent(review: ExportReviewSource): ExportReportContent {
  if (!review.report || review.images.length === 0) {
    throw new ExportContentError("PDF_CONTENT_INCOMPLETE", "批改尚未完成，暂不能导出 PDF");
  }
  if (isLegacyEvaluationReport(review.report)) {
    throw new ExportContentError(
      "LEGACY_REPORT",
      "旧版示范段落报告需要完整重新分析后才能导出新格式",
    );
  }

  const readiness = deliveryReadiness(review);
  if (!readiness.ready) {
    throw new ExportContentError(
      readiness.code === "LEGACY_REPORT" ? "LEGACY_REPORT" : "PDF_CONTENT_INCOMPLETE",
      readiness.message,
    );
  }
  if (!review.ocr || review.ocr.version !== 2) {
    throw new ExportContentError("PDF_CONTENT_INCOMPLETE", "需要自然段识别结果");
  }

  const report = paragraphEvaluationReportSchema.parse(review.report);
  const groups = resolveReviewGroups(report.paragraphReviews, review.ocr.paragraphs);
  const expectedGroups = paragraphReviewUsesGroups(report.paragraphReviews)
    ? report.paragraphReviews.length
    : review.ocr.paragraphs.length;
  if (
    groups.length !== expectedGroups
    || groups.some((group) => (group.paragraphs.length === 0 && !group.review.noSourceParagraph) || group.pageIndex === undefined)
  ) {
    throw new ExportContentError("PDF_CONTENT_INCOMPLETE", "逐段批改内容不完整");
  }
  const paragraphsByPage = new Map<number, ExportParagraph[]>();

  for (const group of groups) {
    const pageIndex = group.pageIndex;
    if (pageIndex === undefined) {
      throw new ExportContentError("PDF_CONTENT_INCOMPLETE", "逐段批改内容不完整");
    }
    const pageParagraphs = paragraphsByPage.get(pageIndex) ?? [];
    pageParagraphs.push({
      ...(group.sourceLabel ? { sourceLabel: group.sourceLabel } : {}),
      suggestions: group.review.suggestions,
      revisionRuns: buildExportRevisionRuns(group.sourceText, group.review.revisedText),
    });
    paragraphsByPage.set(pageIndex, pageParagraphs);
  }

  return {
    documentTitle: exportDocumentTitle(review),
    pages: [...review.images]
      .sort((left, right) => left.position - right.position)
      .map((image) => ({
        image,
        paragraphs: paragraphsByPage.get(image.position) ?? [],
      })),
    rewrittenEssay: report.rewrittenEssay ?? [],
  };
}

function wrapMeasuredText(
  text: string,
  maxWidth: number,
  measure: (value: string) => number,
): string[] {
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  const finish = () => {
    lines.push(current);
    current = "";
    currentWidth = 0;
  };

  for (const character of graphemes(text.replace(/\r\n?/gu, "\n"))) {
    if (character === "\n") {
      finish();
      continue;
    }
    const characterWidth = measure(character);
    const nextWidth = current ? measure(`${current}${character}`) : characterWidth;
    const addedWidth = current ? nextWidth - currentWidth : characterWidth;
    if (current && currentWidth + addedWidth > maxWidth) {
      finish();
      current = character;
      currentWidth = characterWidth;
      continue;
    }
    current = `${current}${character}`;
    currentWidth = nextWidth;
  }
  if (current.length > 0 || lines.length === 0) finish();
  return lines;
}

export function layoutRewrittenEssay(
  paragraphs: string[],
  measure: (text: string) => number,
): RewrittenEssayPage[] {
  const contentWidth = ESSAY_PAGE_WIDTH - ESSAY_MARGIN * 2;
  const pages: RewrittenEssayPage[] = [];
  let y = 0;
  const nextPage = () => {
    pages.push({ title: rewrittenEssayHeading(pages.length > 0), lines: [] });
    y = ESSAY_MARGIN + 40;
  };

  nextPage();
  for (const text of paragraphs) {
    const lines = wrapMeasuredText(rewrittenEssayLineText(text), contentWidth, measure);
    const paragraphHeight = lines.length * ESSAY_LINE_HEIGHT;
    if (
      y + paragraphHeight > ESSAY_PAGE_HEIGHT - ESSAY_MARGIN
      && paragraphHeight <= ESSAY_PAGE_HEIGHT - ESSAY_MARGIN * 2 - 40
    ) {
      nextPage();
    }
    for (const line of lines) {
      if (y + ESSAY_LINE_HEIGHT > ESSAY_PAGE_HEIGHT - ESSAY_MARGIN) nextPage();
      pages[pages.length - 1].lines.push(line);
      y += ESSAY_LINE_HEIGHT;
    }
    y += 12;
  }
  return pages;
}

export function visibleExportText(
  content: ExportReportContent,
  measure: (text: string) => number,
) {
  const paragraphText = content.pages.flatMap((page) => (
    page.paragraphs.flatMap((paragraph) => (
      exportParagraphRuns(paragraph).map((run) => run.text.replaceAll("\n", ""))
    ))
  )).join("");
  if (content.rewrittenEssay.length === 0) return paragraphText;
  return paragraphText + layoutRewrittenEssay(content.rewrittenEssay, measure)
    .flatMap((page) => [page.title, ...page.lines])
    .join("");
}
