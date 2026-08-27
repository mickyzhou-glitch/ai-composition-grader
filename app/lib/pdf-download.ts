import { isLegacyEvaluationReport } from "@/src/domain/contracts";
import { DELIVERY_STYLE, type DeliveryCrop, type DeliveryDocument } from "@/src/delivery/contracts";
import type { RevisionRun } from "@/src/revisions/revision-diff";

import { apiFetch } from "./api";
import { buildDeliveryDocument } from "./delivery-document";
import {
  paginateDeliveryDocument,
  type DeliveryPage,
  type DeliveryPageBlock,
} from "./delivery-pagination";
import type { ReviewView } from "./types";

const PDF_WIDTH = 595.28;
const PDF_HEIGHT = 841.89;
const POINTS_PER_MM = 72 / 25.4;
const RENDER_SCALE = 2;
const TITLE_HEIGHT_MM = 14;
const SANS_FONT = '"SimHei", "Heiti SC", "Microsoft YaHei", sans-serif';
const KAITI_FONT_FACE = '"LXGW WenKai"';
const KAITI_FONT = `${KAITI_FONT_FACE}, "KaiTi", "STKaiti", "Kaiti SC", serif`;
const TEXT_COLOR = "#171717";
const CHANGE_COLOR = "#c91f32";
const SUGGESTION_COLOR = "#fff0bd";

type CanvasPage = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
};

export class ReviewPdfError extends Error {
  constructor(
    readonly code: "LEGACY_REPORT" | "PDF_CONTENT_INCOMPLETE",
    message: string,
  ) {
    super(message);
    this.name = "ReviewPdfError";
  }
}

function mm(value: number): number {
  return value * POINTS_PER_MM;
}

function safeFilenamePart(value: string) {
  return value
    .replace(/[\\/:*?"<>|]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 60) || "未命名作文";
}

function reviewPdfFilename(review: ReviewView) {
  const student = safeFilenamePart(review.studentName || "未填写学生姓名");
  return `作文批改-${safeFilenamePart(review.config.title)}-${student}.pdf`;
}

function createCanvasPage(): CanvasPage {
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(PDF_WIDTH * RENDER_SCALE);
  canvas.height = Math.ceil(PDF_HEIGHT * RENDER_SCALE);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器不支持生成 PDF");
  context.scale(RENDER_SCALE, RENDER_SCALE);
  context.textBaseline = "top";
  return { canvas, context };
}

function paintPageBackground(context: CanvasRenderingContext2D) {
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, PDF_WIDTH, PDF_HEIGHT);
}

function setFont(
  context: CanvasRenderingContext2D,
  sizePt: number,
  family: "sans" | "kaiti",
  weight: 400 | 700 = 400,
) {
  context.font = `${weight} ${sizePt}pt ${family === "kaiti" ? KAITI_FONT : SANS_FONT}`;
}

function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.replace(/\r\n?/gu, "\n").split("\n")) {
    let line = "";
    for (const character of Array.from(rawLine)) {
      if (line && context.measureText(`${line}${character}`).width > maxWidth) {
        lines.push(line);
        line = character;
      } else {
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawWrappedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): number {
  for (const line of wrapText(context, text, maxWidth)) {
    context.fillText(line, x, y);
    y += lineHeight;
  }
  return y;
}

async function loadExportKaiti(document: DeliveryDocument) {
  const text = [
    document.title,
    ...document.paragraphs.flatMap(({ revisionRuns }) => revisionRuns.map(({ text }) => text)),
  ].join("");
  await Promise.all([
    window.document.fonts.load(`400 16px ${KAITI_FONT_FACE}`, text),
    window.document.fonts.load(`700 16px ${KAITI_FONT_FACE}`, text),
  ]);
}

async function loadCropImage(crop: DeliveryCrop): Promise<HTMLImageElement> {
  const blob = new Blob([crop.bytes.slice().buffer as ArrayBuffer], { type: "image/png" });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function paragraphForBlock(document: DeliveryDocument, paragraphNumber: number) {
  const paragraph = document.paragraphs.find((candidate) => (
    candidate.paragraphNumber === paragraphNumber
  ));
  if (!paragraph) throw new Error("逐段交付内容不完整");
  return paragraph;
}

function drawHeading(context: CanvasRenderingContext2D, text: string, x: number, y: number) {
  setFont(context, DELIVERY_STYLE.fontPt.section, "sans", 400);
  context.fillStyle = TEXT_COLOR;
  context.textAlign = "left";
  context.fillText(text, x, y);
}

function drawSuggestion(
  context: CanvasRenderingContext2D,
  document: DeliveryDocument,
  paragraphNumber: number,
  block: Extract<DeliveryPageBlock, { kind: "suggestion" }>,
  x: number,
  y: number,
  width: number,
) {
  const suggestion = paragraphForBlock(document, paragraphNumber).suggestions[block.suggestionIndex];
  if (!suggestion) throw new Error("修改建议内容不完整");
  context.fillStyle = SUGGESTION_COLOR;
  context.fillRect(x, y, width, mm(block.heightMm));
  setFont(context, DELIVERY_STYLE.fontPt.suggestion, "sans", 400);
  context.fillStyle = TEXT_COLOR;
  const padding = mm(3);
  const lineHeight = mm(5);
  let cursor = y + padding;
  const contentWidth = width - padding * 2;
  cursor = drawWrappedText(context, `问题：${suggestion.problem}`, x + padding, cursor, contentWidth, lineHeight);
  cursor = drawWrappedText(context, `动作：${suggestion.advice}`, x + padding, cursor, contentWidth, lineHeight);
  drawWrappedText(context, `示例：${suggestion.example}`, x + padding, cursor, contentWidth, lineHeight);
}

function drawRevisionRuns(
  context: CanvasRenderingContext2D,
  runs: RevisionRun[],
  x: number,
  y: number,
  maxWidth: number,
) {
  setFont(context, DELIVERY_STYLE.fontPt.revision, "kaiti", 400);
  context.textAlign = "left";
  const lineHeight = mm(5.6);
  let cursorX = x;
  let cursorY = y;

  for (const run of runs) {
    const color = run.kind === "inserted" || run.kind === "deleted" ? CHANGE_COLOR : TEXT_COLOR;
    let chunk = "";
    const flush = () => {
      if (!chunk) return;
      const startX = cursorX;
      context.fillStyle = color;
      context.fillText(chunk, cursorX, cursorY);
      cursorX += context.measureText(chunk).width;
      if (run.kind === "deleted") {
        context.strokeStyle = CHANGE_COLOR;
        context.lineWidth = 1.2;
        context.beginPath();
        context.moveTo(startX, cursorY + mm(2.7));
        context.lineTo(cursorX, cursorY + mm(2.7));
        context.stroke();
      }
      chunk = "";
    };

    for (const character of Array.from(run.text.replace(/\r\n?/gu, "\n"))) {
      if (character === "\n") {
        flush();
        cursorX = x;
        cursorY += lineHeight;
        continue;
      }
      const nextWidth = context.measureText(`${chunk}${character}`).width;
      if (chunk && cursorX + nextWidth > x + maxWidth) {
        flush();
        cursorX = x;
        cursorY += lineHeight;
      }
      chunk += character;
    }
    flush();
  }
}

async function drawDeliveryPage(canvasPage: CanvasPage, document: DeliveryDocument, page: DeliveryPage) {
  const { canvas, context } = canvasPage;
  paintPageBackground(context);
  const x = mm(DELIVERY_STYLE.page.marginXmm);
  const width = mm(DELIVERY_STYLE.page.widthMm - DELIVERY_STYLE.page.marginXmm * 2);
  let y = mm(DELIVERY_STYLE.page.marginYmm);
  if (page.hasDocumentTitle) {
    setFont(context, DELIVERY_STYLE.fontPt.title, "kaiti", 700);
    context.fillStyle = TEXT_COLOR;
    context.textAlign = "center";
    context.fillText(document.title, PDF_WIDTH / 2, y);
    context.textAlign = "left";
    y += mm(TITLE_HEIGHT_MM);
  }

  let paragraphNumber = 0;
  for (const block of page.blocks) {
    if (block.kind === "paragraph-heading") {
      paragraphNumber = block.paragraphNumber;
      drawHeading(context, `【第 ${block.paragraphNumber} 段${block.continued ? "（续）" : ""}】`, x, y);
    } else if (block.kind === "crop") {
      const crop = paragraphForBlock(document, paragraphNumber).crops[block.cropIndex];
      if (!crop) throw new Error("原文裁图内容不完整");
      const image = await loadCropImage(crop);
      const drawWidth = mm(block.widthMm);
      const drawHeight = mm(block.heightMm);
      context.drawImage(image, x + (width - drawWidth) / 2, y, drawWidth, drawHeight);
    } else if (block.kind === "suggestion-heading") {
      drawHeading(context, `【修改建议${block.continued ? "（续）" : ""}】`, x, y);
    } else if (block.kind === "suggestion") {
      drawSuggestion(context, document, paragraphNumber, block, x, y, width);
    } else if (block.kind === "revision-heading") {
      drawHeading(context, `【修改后段落${block.continued ? "（续）" : ""}】`, x, y);
    } else {
      drawRevisionRuns(context, block.runs, x, y, width);
    }
    y += mm(block.heightMm);
  }
  return canvas;
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

  const document = await buildDeliveryDocument(review);
  await loadExportKaiti(document);
  const firstCanvasPage = createCanvasPage();
  const pages = paginateDeliveryDocument(document, {
    measureText: (text, fontPt, family) => {
      setFont(firstCanvasPage.context, fontPt, family, 400);
      return firstCanvasPage.context.measureText(text).width / POINTS_PER_MM;
    },
  });
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4", compress: true });
  pdf.setProperties({
    title: review.config.title,
    subject: "作文逐段批改",
    author: "AI 作业批改助手",
  });
  for (let index = 0; index < pages.length; index += 1) {
    const canvasPage = index === 0 ? firstCanvasPage : createCanvasPage();
    const canvas = await drawDeliveryPage(canvasPage, document, pages[index]);
    if (index > 0) pdf.addPage("a4", "portrait");
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.94), "JPEG", 0, 0, PDF_WIDTH, PDF_HEIGHT, undefined, "FAST");
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
