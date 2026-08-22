import { apiFetch } from "./api";
import type { ReviewView } from "./types";

const PDF_WIDTH = 841.89;
const PDF_HEIGHT = 595.28;
const RENDER_SCALE = 2;
const HEITI_FONT = '"SimHei", "Heiti SC", "Microsoft YaHei", sans-serif';
const KAITI_FONT = '"KaiTi", "STKaiti", "Kaiti SC", serif';
const BLUE = "#1557b0";
const RED = "#c62828";

type CanvasPage = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
};
type PdfSample = NonNullable<ReviewView["report"]>["sampleParagraphs"][number];

function safeFilenamePart(value: string) {
  return value
    .replace(/[\\/:*?"<>|]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 60) || "未命名作文";
}

function reviewPdfFilename(review: ReviewView) {
  const student = safeFilenamePart(review.studentName || "未填写学生姓名");
  return `${safeFilenamePart(review.config.title)}-${student}.pdf`;
}

function createCanvasPage(): CanvasPage {
  const canvas = document.createElement("canvas");
  canvas.width = PDF_WIDTH * RENDER_SCALE;
  canvas.height = PDF_HEIGHT * RENDER_SCALE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器不支持生成 PDF");
  context.scale(RENDER_SCALE, RENDER_SCALE);
  context.textBaseline = "top";
  return { canvas, context };
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const corner = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + corner, y);
  context.arcTo(x + width, y, x + width, y + height, corner);
  context.arcTo(x + width, y + height, x, y + height, corner);
  context.arcTo(x, y + height, x, y, corner);
  context.arcTo(x, y, x + width, y, corner);
  context.closePath();
}

function wrapLines(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  for (const rawLine of text.replace(/\r\n?/gu, "\n").split("\n")) {
    let line = "";
    for (const character of rawLine || " ") {
      if (line && context.measureText(`${line}${character}`).width > maxWidth) {
        lines.push(line);
        line = character;
      } else {
        line += character;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function drawLines(
  context: CanvasRenderingContext2D,
  lines: string[],
  x: number,
  y: number,
  lineHeight: number,
) {
  lines.forEach((line, index) => context.fillText(line, x, y + index * lineHeight));
  return y + lines.length * lineHeight;
}

function paintPageBackground(context: CanvasRenderingContext2D) {
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, PDF_WIDTH, PDF_HEIGHT);
}

function samplesForImage<T>(samples: T[], imageIndex: number, imageCount: number) {
  if (samples.length === 0) return [];
  return samples.filter((_, index) => Math.floor((index * imageCount) / samples.length) === imageIndex);
}

async function loadReviewImage(reviewId: string, imageId: number) {
  const response = await fetch(`/api/reviews/${encodeURIComponent(reviewId)}/files?imageId=${imageId}&variant=original`);
  if (!response.ok) throw new Error("作文原图读取失败，无法生成 PDF");
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function drawFittedImage(context: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number) {
  const imageRatio = image.naturalWidth / image.naturalHeight;
  const frameRatio = width / height;
  const drawWidth = imageRatio > frameRatio ? width : height * imageRatio;
  const drawHeight = imageRatio > frameRatio ? width / imageRatio : height;
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function fittedTextSize(
  context: CanvasRenderingContext2D,
  samples: PdfSample[],
  field: "suggestion" | "text",
  width: number,
  height: number,
  fontFamily: string,
  maximum: number,
) {
  for (let size = maximum; size >= 8; size -= 0.5) {
    let totalHeight = 0;
    for (const sample of samples) {
      context.font = `700 ${size}px ${fontFamily}`;
      totalHeight += wrapLines(context, sample.title, width).length * size * 1.35;
      context.font = `400 ${size}px ${fontFamily}`;
      totalHeight += wrapLines(context, sample[field], width).length * size * 1.5 + size * 0.85;
    }
    if (totalHeight <= height) return size;
  }
  return 8;
}

function drawSampleColumn(
  context: CanvasRenderingContext2D,
  samples: PdfSample[],
  field: "suggestion" | "text",
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
  fontFamily: string,
  maximumSize: number,
) {
  const size = fittedTextSize(context, samples, field, width, height, fontFamily, maximumSize);
  let cursor = y;
  for (const sample of samples) {
    context.fillStyle = color;
    context.font = `700 ${size}px ${fontFamily}`;
    cursor = drawLines(context, wrapLines(context, sample.title, width), x, cursor, size * 1.35);
    context.font = `400 ${size}px ${fontFamily}`;
    cursor = drawLines(context, wrapLines(context, sample[field], width), x, cursor, size * 1.5) + size * 0.85;
  }
}

async function drawFeedbackPage(review: ReviewView, imageIndex: number) {
  const report = review.report;
  const imageMeta = review.images[imageIndex];
  if (!report || !imageMeta) throw new Error("批改内容不完整，暂不能导出 PDF");
  const image = await loadReviewImage(review.id, imageMeta.id);
  const { canvas, context } = createCanvasPage();
  paintPageBackground(context);

  const top = 18;
  const height = PDF_HEIGHT - top - 18;
  const leftX = 18;
  const leftWidth = 175;
  const imageX = leftX + leftWidth + 14;
  const imageWidth = 310;
  const rightX = imageX + imageWidth + 14;
  const rightWidth = PDF_WIDTH - rightX - 18;
  const samples = samplesForImage(report.sampleParagraphs, imageIndex, review.images.length);

  context.fillStyle = "#f7faff";
  roundedRect(context, leftX, top, leftWidth, height, 4);
  context.fill();
  context.fillStyle = "#f3f3f3";
  roundedRect(context, imageX, top, imageWidth, height, 4);
  context.fill();
  context.save();
  roundedRect(context, imageX, top, imageWidth, height, 4);
  context.clip();
  drawFittedImage(context, image, imageX, top, imageWidth, height);
  context.restore();
  context.fillStyle = "#fff8f8";
  roundedRect(context, rightX, top, rightWidth, height, 4);
  context.fill();

  context.fillStyle = BLUE;
  context.font = `700 13px ${HEITI_FONT}`;
  context.fillText("修改建议", leftX + 12, top + 12);
  context.fillStyle = RED;
  context.font = `700 15px ${KAITI_FONT}`;
  context.fillText("范文", rightX + 12, top + 12);
  drawSampleColumn(context, samples, "suggestion", leftX + 12, top + 40, leftWidth - 24, height - 52, BLUE, HEITI_FONT, 11.5);
  drawSampleColumn(context, samples, "text", rightX + 12, top + 42, rightWidth - 24, height - 54, RED, KAITI_FONT, 13);
  return canvas;
}

async function createReviewPdf(review: ReviewView) {
  if (!review.report || review.images.length === 0) {
    throw new Error("批改尚未完成，暂不能导出 PDF");
  }
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({
    orientation: "landscape",
    unit: "pt",
    format: "a4",
    compress: true,
  });
  pdf.setProperties({ title: review.config.title, subject: "作文批改报告", author: "青藤未来作文批改助手" });
  const pages: HTMLCanvasElement[] = [];
  for (let index = 0; index < review.images.length; index += 1) {
    pages.push(await drawFeedbackPage(review, index));
  }
  pages.forEach((canvas, index) => {
    if (index > 0) pdf.addPage("a4", "landscape");
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.94), "JPEG", 0, 0, PDF_WIDTH, PDF_HEIGHT, undefined, "FAST");
  });
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
    body: JSON.stringify({
      reviews: reviews.map(({ id, revision }) => ({ id, revision })),
    }),
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
  const filename = "作文批改批量导出.zip";
  triggerFileDownload(await archive.generateAsync({ type: "blob", compression: "DEFLATE" }), filename);
  await Promise.all(reviewIds.map((reviewId) => markReviewExported(reviewId)));
  return filename;
}
