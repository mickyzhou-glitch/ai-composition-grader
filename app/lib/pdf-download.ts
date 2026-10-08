import { deliveryReadiness } from "@/src/delivery/readiness";
import {
  isLegacyEvaluationReport,
  paragraphEvaluationReportSchema,
  type ParagraphSuggestion,
} from "@/src/domain/contracts";
import { diffArrays } from "diff";

import { apiFetch } from "./api";
import type { ReviewImageView, ReviewView } from "./types";

const PDF_WIDTH = 841.89;
const PDF_HEIGHT = 595.28;
const RENDER_SCALE = 2;
const IMAGE_AREA_RATIO = 0.5;
const PAGE_INSET = 8;
const IMAGE_TEXT_GAP = 10;
const BOX_GAP = 6;
const BOX_PADDING = 7;
const MAX_TEXT_PT = 10.5;
const MIN_TEXT_PT = 7;
const FONT_STEP_PT = 0.25;
const KAITI_FONT_FACE = '"LXGW WenKai"';
const KAITI_FONT = `${KAITI_FONT_FACE}, "KaiTi", "STKaiti", "Kaiti SC", serif`;
const TEXT_COLOR = "#000000";
const SUGGESTION_COLOR = "#c00000";
const CHANGE_COLOR = "#1f4e78";
const TEXT_BOX_COLOR = "#e7d4a8";

type CanvasPage = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
};

type PdfParagraph = {
  suggestions: ParagraphSuggestion[];
  revisionRuns: PdfRevisionRun[];
};

type PdfRevisionRun = {
  text: string;
  changed: boolean;
};

type PdfPage = {
  image: ReviewImageView;
  paragraphs: PdfParagraph[];
};

type Rectangle = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type TextStyle = {
  color: string;
  weight: 400 | 700;
  underline: boolean;
};

type RichTextRun = TextStyle & {
  text: string;
};

type LineFragment = TextStyle & {
  text: string;
  width: number;
};

type RichTextLine = {
  fragments: LineFragment[];
  width: number;
};

type PositionedTextBox = Rectangle & {
  fontPt: number;
  paragraph: PdfParagraph;
};

type LoadedImage = {
  element: HTMLImageElement;
  objectUrl: string;
};

const graphemeSegmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });
const sentenceSegmenter = new Intl.Segmenter("zh-CN", { granularity: "sentence" });

export class ReviewPdfError extends Error {
  constructor(
    readonly code: "LEGACY_REPORT" | "PDF_CONTENT_INCOMPLETE",
    message: string,
  ) {
    super(message);
    this.name = "ReviewPdfError";
  }
}

function safeFilenamePart(value: string, fallback: string) {
  return value
    .replace(/[\\/:*?"<>|]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 60) || fallback;
}

function reviewPdfTitle(review: ReviewView) {
  const student = safeFilenamePart(review.studentName, "未填写学生姓名");
  const title = safeFilenamePart(review.config.title, "未命名作文");
  return `${student}${title}`;
}

function reviewPdfFilename(review: ReviewView) {
  return `${reviewPdfTitle(review)}.pdf`;
}

function graphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

function sentences(value: string): string[] {
  return Array.from(sentenceSegmenter.segment(value), ({ segment }) => segment);
}

function buildPdfRevisionRuns(source: string, revised: string): PdfRevisionRun[] {
  const runs: PdfRevisionRun[] = [];
  for (const change of diffArrays(sentences(source), sentences(revised))) {
    if (change.removed) continue;
    const text = change.value.join("");
    if (text.length === 0) continue;
    const changed = Boolean(change.added);
    const previous = runs.at(-1);
    if (previous?.changed === changed) {
      previous.text += text;
    } else {
      runs.push({ text, changed });
    }
  }
  if (runs.map((run) => run.text).join("") !== revised) {
    throw new ReviewPdfError("PDF_CONTENT_INCOMPLETE", "示范文本未能完整排版，请重试");
  }
  return runs;
}

function createCanvasPage(): CanvasPage {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(PDF_WIDTH * RENDER_SCALE);
  canvas.height = Math.ceil(PDF_HEIGHT * RENDER_SCALE);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器不支持生成 PDF");
  context.scale(RENDER_SCALE, RENDER_SCALE);
  context.textBaseline = "top";
  context.textAlign = "left";
  return { canvas, context };
}

function paintPageBackground(context: CanvasRenderingContext2D) {
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, PDF_WIDTH, PDF_HEIGHT);
}

function setKaitiFont(
  context: CanvasRenderingContext2D,
  sizePt: number,
  weight: 400 | 700,
) {
  context.font = `${weight} ${sizePt}px ${KAITI_FONT}`;
}

function imageUrl(reviewId: string, imageId: number) {
  return `/api/reviews/${encodeURIComponent(reviewId)}/files?imageId=${imageId}&variant=original`;
}

async function loadOriginalImage(reviewId: string, imageId: number): Promise<LoadedImage> {
  const response = await fetch(imageUrl(reviewId, imageId));
  if (!response.ok) throw new Error(`作文照片读取失败（${response.status}）`);
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    const element = new Image();
    element.src = objectUrl;
    await element.decode();
    return { element, objectUrl };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function buildPdfPages(review: ReviewView): PdfPage[] {
  const readiness = deliveryReadiness(review);
  if (!readiness.ready) {
    throw new ReviewPdfError(
      readiness.code === "LEGACY_REPORT" ? "LEGACY_REPORT" : "PDF_CONTENT_INCOMPLETE",
      readiness.message,
    );
  }
  if (!review.ocr || review.ocr.version !== 2) {
    throw new ReviewPdfError("PDF_CONTENT_INCOMPLETE", "需要自然段识别结果");
  }

  const report = paragraphEvaluationReportSchema.parse(review.report);
  const reportByParagraph = new Map(
    report.paragraphReviews.map((paragraph) => [paragraph.paragraphId, paragraph]),
  );
  const paragraphsByPage = new Map<number, PdfParagraph[]>();

  for (const paragraph of [...review.ocr.paragraphs].sort(
    (left, right) => left.paragraphIndex - right.paragraphIndex,
  )) {
    const paragraphReport = reportByParagraph.get(paragraph.id);
    const pageIndex = paragraph.segments[0]?.pageIndex;
    if (!paragraphReport || pageIndex === undefined) {
      throw new ReviewPdfError("PDF_CONTENT_INCOMPLETE", "逐段批改内容不完整");
    }
    const pageParagraphs = paragraphsByPage.get(pageIndex) ?? [];
    pageParagraphs.push({
      suggestions: paragraphReport.suggestions,
      revisionRuns: buildPdfRevisionRuns(paragraph.text, paragraphReport.revisedText),
    });
    paragraphsByPage.set(pageIndex, pageParagraphs);
  }

  return [...review.images]
    .sort((left, right) => left.position - right.position)
    .map((image) => ({
      image,
      paragraphs: paragraphsByPage.get(image.position) ?? [],
    }));
}

function paragraphRuns(paragraph: PdfParagraph): RichTextRun[] {
  const suggestionText = paragraph.suggestions.map((suggestion) => (
    `${suggestion.problem}；${suggestion.advice}；${suggestion.example}`
  )).join("\n");
  const runs: RichTextRun[] = [{
    text: `修改建议：${suggestionText}\n`,
    color: SUGGESTION_COLOR,
    weight: 700,
    underline: false,
  }, {
    text: "示范文本：",
    color: TEXT_COLOR,
    weight: 700,
    underline: false,
  }];

  for (const run of paragraph.revisionRuns) {
    runs.push({
      text: run.text,
      color: run.changed ? CHANGE_COLOR : TEXT_COLOR,
      weight: 400,
      underline: run.changed,
    });
  }
  return runs;
}

async function loadExportKaiti(pages: PdfPage[]) {
  const text = pages.flatMap(({ paragraphs }) => (
    paragraphs.flatMap((paragraph) => paragraphRuns(paragraph).map((run) => run.text))
  )).join("");
  await Promise.all([
    window.document.fonts.load(`400 16px ${KAITI_FONT_FACE}`, text),
    window.document.fonts.load(`700 16px ${KAITI_FONT_FACE}`, text),
  ]);
}

function maximumImagePlacement(imageWidth: number, imageHeight: number): Rectangle {
  if (!Number.isFinite(imageWidth) || imageWidth <= 0
    || !Number.isFinite(imageHeight) || imageHeight <= 0) {
    throw new ReviewPdfError("PDF_CONTENT_INCOMPLETE", "作文照片尺寸无效，无法生成 PDF");
  }
  const safeWidth = imageWidth;
  const safeHeight = imageHeight;
  const maximumScale = Math.min(PDF_WIDTH / safeWidth, PDF_HEIGHT / safeHeight);
  const maximumArea = safeWidth * safeHeight * maximumScale * maximumScale;
  const targetArea = PDF_WIDTH * PDF_HEIGHT * IMAGE_AREA_RATIO;
  if (maximumArea + 0.01 < targetArea) {
    throw new ReviewPdfError(
      "PDF_CONTENT_INCOMPLETE",
      "作文照片长宽比过于极端，无法在横向 A4 单页内完整显示且占满至少半页",
    );
  }
  const targetScale = Math.sqrt(targetArea / (safeWidth * safeHeight));
  return {
    x: 0,
    y: 0,
    width: safeWidth * targetScale,
    height: safeHeight * targetScale,
  };
}

function availableTextRegions(image: Rectangle): Rectangle[] {
  const right: Rectangle = {
    x: image.width + IMAGE_TEXT_GAP,
    y: PAGE_INSET,
    width: PDF_WIDTH - image.width - IMAGE_TEXT_GAP - PAGE_INSET,
    height: PDF_HEIGHT - PAGE_INSET * 2,
  };
  const bottom: Rectangle = {
    x: PAGE_INSET,
    y: image.height + IMAGE_TEXT_GAP,
    width: image.width - PAGE_INSET * 2,
    height: PDF_HEIGHT - image.height - IMAGE_TEXT_GAP - PAGE_INSET,
  };
  return [right, bottom]
    .filter(({ width, height }) => width > BOX_PADDING * 2 + 8 && height > BOX_PADDING * 2 + 8)
    .sort((left, rightRegion) => (
      rightRegion.width * rightRegion.height - left.width * left.height
    ));
}

function sameStyle(left: TextStyle, right: TextStyle) {
  return left.color === right.color
    && left.weight === right.weight
    && left.underline === right.underline;
}

function wrapRichText(
  context: CanvasRenderingContext2D,
  runs: RichTextRun[],
  maxWidth: number,
  fontPt: number,
): RichTextLine[] {
  const lines: RichTextLine[] = [];
  let fragments: LineFragment[] = [];
  let lineWidth = 0;
  const finishLine = () => {
    lines.push({ fragments, width: lineWidth });
    fragments = [];
    lineWidth = 0;
  };

  for (const run of runs) {
    for (const character of graphemes(run.text.replace(/\r\n?/gu, "\n"))) {
      if (character === "\n") {
        finishLine();
        continue;
      }
      setKaitiFont(context, fontPt, run.weight);
      const characterWidth = context.measureText(character).width;
      let previous = fragments.at(-1);
      let nextFragmentWidth = previous && sameStyle(previous, run)
        ? context.measureText(`${previous.text}${character}`).width
        : characterWidth;
      let addedWidth = previous && sameStyle(previous, run)
        ? nextFragmentWidth - previous.width
        : characterWidth;
      if (fragments.length > 0 && lineWidth + addedWidth > maxWidth) {
        finishLine();
        previous = undefined;
        nextFragmentWidth = characterWidth;
        addedWidth = characterWidth;
      }
      if (previous && sameStyle(previous, run)) {
        previous.text += character;
        previous.width = nextFragmentWidth;
      } else {
        fragments.push({
          text: character,
          width: characterWidth,
          color: run.color,
          weight: run.weight,
          underline: run.underline,
        });
      }
      lineWidth += addedWidth;
    }
  }
  if (fragments.length > 0 || lines.length === 0) finishLine();
  return lines;
}

function textBoxHeight(
  context: CanvasRenderingContext2D,
  paragraph: PdfParagraph,
  width: number,
  fontPt: number,
) {
  const padding = Math.min(BOX_PADDING, Math.max(1, fontPt * 0.7));
  const contentWidth = Math.max(1, width - padding * 2);
  const lineHeight = fontPt * 1.45;
  const lines = wrapRichText(context, paragraphRuns(paragraph), contentWidth, fontPt);
  if (lines.some((line) => line.width > contentWidth + 0.01)) {
    return Number.POSITIVE_INFINITY;
  }
  return padding * 2 + lines.length * lineHeight;
}

function regionLayout(
  context: CanvasRenderingContext2D,
  paragraphs: PdfParagraph[],
  region: Rectangle,
  fontPt: number,
): PositionedTextBox[] | null {
  const gap = Math.min(BOX_GAP, Math.max(1, fontPt * 0.6));
  const heights = paragraphs.map((paragraph) => (
    textBoxHeight(context, paragraph, region.width, fontPt)
  ));
  const requiredHeight = heights.reduce((sum, height) => sum + height, 0)
    + Math.max(0, paragraphs.length - 1) * gap;
  if (requiredHeight > region.height + 0.01) return null;

  let y = region.y;
  return paragraphs.map((paragraph, index) => {
    const textBox = {
      x: region.x,
      y,
      width: region.width,
      height: heights[index],
      fontPt,
      paragraph,
    };
    y += heights[index] + gap;
    return textBox;
  });
}

function layoutAtFontSize(
  context: CanvasRenderingContext2D,
  paragraphs: PdfParagraph[],
  regions: Rectangle[],
  fontPt: number,
): PositionedTextBox[] | null {
  if (regions.length === 0) return paragraphs.length === 0 ? [] : null;
  if (regions.length === 1) {
    return regionLayout(context, paragraphs, regions[0], fontPt);
  }

  let best: { boxes: PositionedTextBox[]; remainingArea: number } | null = null;
  for (let split = 0; split <= paragraphs.length; split += 1) {
    const first = regionLayout(context, paragraphs.slice(0, split), regions[0], fontPt);
    const second = regionLayout(context, paragraphs.slice(split), regions[1], fontPt);
    if (!first || !second) continue;
    const usedArea = [...first, ...second].reduce(
      (sum, box) => sum + box.width * box.height,
      0,
    );
    const availableArea = regions[0].width * regions[0].height
      + regions[1].width * regions[1].height;
    const candidate = { boxes: [...first, ...second], remainingArea: availableArea - usedArea };
    if (!best || candidate.remainingArea < best.remainingArea) best = candidate;
  }
  return best?.boxes ?? null;
}

function layoutTextBoxes(
  context: CanvasRenderingContext2D,
  paragraphs: PdfParagraph[],
  regions: Rectangle[],
): PositionedTextBox[] {
  if (paragraphs.length === 0) return [];
  for (let fontPt = MAX_TEXT_PT; fontPt >= MIN_TEXT_PT; fontPt -= FONT_STEP_PT) {
    const layout = layoutAtFontSize(context, paragraphs, regions, fontPt);
    if (layout) return layout;
  }
  throw new ReviewPdfError(
    "PDF_CONTENT_INCOMPLETE",
    "完整段落内容无法放入照片页空白区域，请缩短修改建议后重试",
  );
}

function drawTextBox(
  context: CanvasRenderingContext2D,
  box: PositionedTextBox,
) {
  const padding = Math.min(BOX_PADDING, Math.max(1, box.fontPt * 0.7));
  context.fillStyle = TEXT_BOX_COLOR;
  context.fillRect(box.x, box.y, box.width, box.height);

  const lineHeight = box.fontPt * 1.45;
  const lines = wrapRichText(
    context,
    paragraphRuns(box.paragraph),
    box.width - padding * 2,
    box.fontPt,
  );
  const contentWidth = box.width - padding * 2;
  if (lines.some((line) => line.width > contentWidth + 0.01)
    || padding * 2 + lines.length * lineHeight > box.height + 0.01) {
    throw new ReviewPdfError(
      "PDF_CONTENT_INCOMPLETE",
      "文本框无法完整呈现全部文字，请调整批改内容后重试",
    );
  }
  let y = box.y + padding;
  for (const line of lines) {
    let x = box.x + padding;
    for (const fragment of line.fragments) {
      setKaitiFont(context, box.fontPt, fragment.weight);
      context.fillStyle = fragment.color;
      context.fillText(fragment.text, x, y);
      if (fragment.underline && fragment.text.length > 0) {
        context.strokeStyle = fragment.color;
        context.lineWidth = Math.max(0.55, box.fontPt * 0.06);
        context.beginPath();
        context.moveTo(x, y + box.fontPt * 1.18);
        context.lineTo(x + fragment.width, y + box.fontPt * 1.18);
        context.stroke();
      }
      x += fragment.width;
    }
    y += lineHeight;
  }
}

async function drawPdfPage(
  canvasPage: CanvasPage,
  reviewId: string,
  page: PdfPage,
) {
  const { canvas, context } = canvasPage;
  paintPageBackground(context);
  const loaded = await loadOriginalImage(reviewId, page.image.id);
  try {
    const imageWidth = loaded.element.naturalWidth || page.image.width;
    const imageHeight = loaded.element.naturalHeight || page.image.height;
    const image = maximumImagePlacement(imageWidth, imageHeight);
    context.drawImage(loaded.element, image.x, image.y, image.width, image.height);
    const textBoxes = layoutTextBoxes(context, page.paragraphs, availableTextRegions(image));
    textBoxes.forEach((box) => drawTextBox(context, box));
    return canvas;
  } finally {
    URL.revokeObjectURL(loaded.objectUrl);
  }
}

export async function createReviewPdf(review: ReviewView): Promise<Blob> {
  if (!review.report || review.images.length === 0) {
    throw new ReviewPdfError("PDF_CONTENT_INCOMPLETE", "批改尚未完成，暂不能导出 PDF");
  }
  if (isLegacyEvaluationReport(review.report)) {
    throw new ReviewPdfError(
      "LEGACY_REPORT",
      "旧版示范段落报告需要完整重新分析后才能导出新格式",
    );
  }

  const pages = buildPdfPages(review);
  await loadExportKaiti(pages);
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4", compress: true });
  pdf.setProperties({ title: reviewPdfTitle(review) });
  for (let index = 0; index < pages.length; index += 1) {
    const canvas = await drawPdfPage(createCanvasPage(), review.id, pages[index]);
    if (index > 0) pdf.addPage("a4", "landscape");
    pdf.addImage(
      canvas.toDataURL("image/jpeg", 0.97),
      "JPEG",
      0,
      0,
      PDF_WIDTH,
      PDF_HEIGHT,
      undefined,
      "FAST",
    );
  }
  return pdf.output("blob");
}

export function triggerFileDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function fetchReview(reviewId: string) {
  return apiFetch<ReviewView>(`/api/reviews/${encodeURIComponent(reviewId)}`);
}

async function assertReviewsExportable(reviews: ReviewView[]) {
  if (reviews.some(({ teacherReviewedAt }) => teacherReviewedAt === null)) {
    throw new Error("作文必须经过老师审核后才能导出");
  }
  await apiFetch<{ exportable: true }>("/api/reviews/export-check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reviews: reviews.map(({ id, revision }) => ({ id, revision })) }),
  });
}

export async function markReviewExported(reviewId: string) {
  return apiFetch<unknown>(`/api/reviews/${encodeURIComponent(reviewId)}/exported`, { method: "POST" });
}

export async function downloadReviewPdf(reviewId: string): Promise<string> {
  const review = await fetchReview(reviewId);
  await assertReviewsExportable([review]);
  const filename = reviewPdfFilename(review);
  triggerFileDownload(await createReviewPdf(review), filename);
  await markReviewExported(reviewId);
  return filename;
}

export async function downloadReviewPdfArchive(reviewIds: string[]): Promise<string> {
  if (reviewIds.length === 0) throw new Error("请先选择批改记录");
  if (reviewIds.length === 1) return downloadReviewPdf(reviewIds[0]);
  const reviews = await Promise.all(reviewIds.map(fetchReview));
  await assertReviewsExportable(reviews);
  const { default: JSZip } = await import("jszip");
  const archive = new JSZip();
  for (const review of reviews) {
    archive.file(reviewPdfFilename(review), await createReviewPdf(review));
  }
  const filename = "作文批改批量导出-PDF.zip";
  triggerFileDownload(await archive.generateAsync({ type: "blob", compression: "DEFLATE" }), filename);
  await Promise.all(reviewIds.map((reviewId) => markReviewExported(reviewId)));
  return filename;
}
