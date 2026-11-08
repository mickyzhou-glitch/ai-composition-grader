import {
  isLegacyEvaluationReport,
  paragraphEvaluationReportSchema,
  type ParagraphSuggestion,
} from "@/src/domain/contracts";
import { assertEssayDraftResolved, deriveEssayFromParagraphReviews } from "@/src/domain/essay-paragraph-sync";
import { mergedParagraphAction } from "@/src/domain/paragraph-actions";
import { paragraphReviewUsesGroups, resolveReviewGroups } from "@/src/domain/paragraph-review-groups";
import {
  deliveryReadiness,
  type DeliveryReadinessInput,
} from "@/src/delivery/readiness";
import type { PublicOcrView } from "@/src/ocr/contracts";
import { adviceActionUnderlines, buildAdviceRevisionRuns, splitParagraphActions } from "@/src/revisions/advice-underlines";
import type { RevisionUnderline } from "@/src/revisions/revision-diff";

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
  /** 改动句线型：第 1/2/3 条修改动作 → 单线/波浪线/点划线；缺省单线。 */
  underline?: RevisionUnderline;
};

export type ExportParagraph = {
  suggestions: ParagraphSuggestion[];
  revisionRuns: ExportRevisionRun[];
  /** 每条修改动作的线型（与它在改后全段里的落实句一致）；null 不划线。缺省整框不划线。 */
  actionUnderlines?: Array<RevisionUnderline | null>;
};

export type ExportRunStyle = "suggestion" | "demonstration" | "changed" | "plain";

export type ExportTextRun = {
  text: string;
  style: ExportRunStyle;
  /** style 为 changed 时缺省单线；style 为 suggestion 时只有带线型的修改动作才有。 */
  underline?: RevisionUnderline;
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

/**
 * 导出给家长/学生看的段落框：只有建议正文 +「改后全段：」+ 改后正文。
 * 不得输出「第 N 段」「对应原文第×段」「修改动作：」等标签（2026-10-29、11-05 两次投诉）。
 */
export function exportParagraphRuns(paragraph: ExportParagraph): ExportTextRun[] {
  return [
    ...suggestionRuns(paragraph),
    { text: REVISED_PARAGRAPH_LABEL, style: "demonstration" as const },
    ...paragraph.revisionRuns.map((run): ExportTextRun => (run.changed
      ? { text: run.text, style: "changed", underline: run.underline ?? "single" }
      : { text: run.text, style: "plain" })),
  ];
}

/**
 * 修改动作按条划线：编号不划，动作正文划与改后全段落实句相同的线。
 * 拆条后拼不回原文（编号写法特殊）时整框不划线，保证文字不变。
 */
function suggestionRuns(paragraph: ExportParagraph): ExportTextRun[] {
  const text = suggestionText(paragraph.suggestions);
  const plain: ExportTextRun[] = [{ text: `${text}\n`, style: "suggestion" }];
  const underlines = paragraph.actionUnderlines;
  if (!underlines?.some(Boolean)) return plain;
  const actions = splitParagraphActions(text);
  if (actions.length !== underlines.length) return plain;
  const runs: ExportTextRun[] = [];
  actions.forEach((action, index) => {
    const prefix = actions.length > 1 ? `${index + 1}. ` : "";
    if (prefix) runs.push({ text: prefix, style: "suggestion" });
    const underline = underlines[index];
    runs.push(underline ? { text: action, style: "suggestion", underline } : { text: action, style: "suggestion" });
    runs.push({ text: "\n", style: "suggestion" });
  });
  if (runs.map((run) => run.text).join("") !== `${text}\n`) return plain;
  return runs;
}

export function exportFontSample(content: ExportReportContent) {
  return content.pages.flatMap((page) => (
    page.paragraphs.flatMap((paragraph) => exportParagraphRuns(paragraph).map((run) => run.text))
  )).join("")
    + content.rewrittenEssay.join("")
    + (content.rewrittenEssay.length ? rewrittenEssayHeading(true) : "");
}

function buildExportRevisionRuns(
  source: string,
  revised: string,
  suggestions: readonly ParagraphSuggestion[],
): ExportRevisionRun[] {
  const runs = buildAdviceRevisionRuns(source, revised, suggestions).map((run): ExportRevisionRun => (
    run.kind === "inserted"
      ? { text: run.text, changed: true, underline: run.underline ?? "single" }
      : { text: run.text, changed: false }
  ));
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

  const report = paragraphEvaluationReportSchema.parse(review.report);
  assertEssayDraftResolved(report);
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
      suggestions: group.review.suggestions,
      revisionRuns: buildExportRevisionRuns(group.sourceText, group.review.revisedText, group.review.suggestions),
      actionUnderlines: adviceActionUnderlines(group.review.revisedText, group.review.suggestions),
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
    rewrittenEssay: report.rewrittenEssay?.length ? deriveEssayFromParagraphReviews(report.paragraphReviews) : [],
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
