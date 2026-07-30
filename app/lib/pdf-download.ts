import { apiFetch } from "./api";
import type { ReviewView } from "./types";
import { gradeFromLegacyTotal } from "@/src/domain/contracts";

const PDF_WIDTH = 1152;
const PDF_HEIGHT = 648;
const RENDER_SCALE = 2;
const FONT_FAMILY = '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
export const PDF_HEADER = "青藤未来作文批改报告";

type CanvasPage = {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
};

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

function drawTextBlock(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines = Number.POSITIVE_INFINITY,
) {
  const lines = wrapLines(context, text, maxWidth).slice(0, maxLines);
  lines.forEach((line, index) => context.fillText(line, x, y + index * lineHeight));
  return y + lines.length * lineHeight;
}

function paintPageBackground(context: CanvasRenderingContext2D, title: string, review: ReviewView) {
  context.fillStyle = "#fbfefc";
  context.fillRect(0, 0, PDF_WIDTH, PDF_HEIGHT);
  context.fillStyle = "#007157";
  context.fillRect(0, 0, PDF_WIDTH, 12);
  context.fillStyle = "#43635a";
  context.font = `600 14px ${FONT_FAMILY}`;
  context.fillText(PDF_HEADER, 52, 32);
  context.textAlign = "right";
  context.fillText(`学生：${review.studentName || "未填写"}`, PDF_WIDTH - 52, 32);
  context.textAlign = "left";
  context.fillStyle = "#1f2d28";
  context.font = `700 34px ${FONT_FAMILY}`;
  context.fillText(title, 52, 67);
  context.strokeStyle = "#d4e5de";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(52, 116);
  context.lineTo(PDF_WIDTH - 52, 116);
  context.stroke();
}

function splitComment(value: string) {
  const marker = /(?:现在)?最需要(?:调整|改进|加强)(?:的是)?[：:，,]?/u;
  const match = marker.exec(value);
  if (!match || match.index === undefined) return { strengths: value, improvement: "" };
  return {
    strengths: value.slice(0, match.index).trim(),
    improvement: value.slice(match.index).trim(),
  };
}

function points(value: string | string[]) {
  const raw = Array.isArray(value) ? value : value.split(/\r?\n/gu);
  return raw.map((item) => item.trim()).filter(Boolean).slice(0, 6);
}

function drawSummaryPage(review: ReviewView, heading: string, items: string[], grade?: string) {
  const { canvas, context } = createCanvasPage();
  paintPageBackground(context, review.config.title, review);
  context.fillStyle = "#047354";
  context.font = `700 17px ${FONT_FAMILY}`;
  context.fillText(grade ? `等级评定 · ${grade}${grade === "C" ? "（重写）" : ""}` : "教师复核重点", 52, 142);
  context.fillStyle = "#c90000";
  context.font = `700 46px ${FONT_FAMILY}`;
  context.fillText(heading, 52, 177);
  context.font = `500 25px ${FONT_FAMILY}`;
  let y = 257;
  items.forEach((item, index) => {
    context.fillStyle = "#c90000";
    context.font = `700 25px ${FONT_FAMILY}`;
    context.fillText(`${["一", "二", "三", "四", "五", "六"][index]}、`, 70, y);
    context.fillStyle = "#2a312f";
    context.font = `500 25px ${FONT_FAMILY}`;
    const nextY = drawTextBlock(context, item, 115, y, PDF_WIDTH - 185, 37, 4);
    y = nextY + 24;
  });
  return canvas;
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

async function drawFeedbackPage(review: ReviewView, imageIndex: number) {
  const report = review.report;
  const imageMeta = review.images[imageIndex];
  if (!report || !imageMeta) throw new Error("批改内容不完整，暂不能导出 PDF");
  const image = await loadReviewImage(review.id, imageMeta.id);
  const { canvas, context } = createCanvasPage();
  paintPageBackground(context, `第 ${imageIndex + 1} 页批注`, review);

  const top = 142;
  const height = PDF_HEIGHT - top - 38;
  const leftX = 52;
  const leftWidth = 205;
  const imageX = leftX + leftWidth + 22;
  const imageWidth = 515;
  const rightX = imageX + imageWidth + 22;
  const rightWidth = PDF_WIDTH - rightX - 52;
  const samples = samplesForImage(report.sampleParagraphs, imageIndex, review.images.length);

  context.fillStyle = "#fff9f8";
  roundedRect(context, leftX, top, leftWidth, height, 12);
  context.fill();
  context.fillStyle = "#f4eee5";
  roundedRect(context, imageX, top, imageWidth, height, 12);
  context.fill();
  context.save();
  roundedRect(context, imageX, top, imageWidth, height, 12);
  context.clip();
  drawFittedImage(context, image, imageX, top, imageWidth, height);
  context.restore();
  context.fillStyle = "#f8fbff";
  roundedRect(context, rightX, top, rightWidth, height, 12);
  context.fill();

  context.fillStyle = "#c90000";
  context.font = `700 19px ${FONT_FAMILY}`;
  context.fillText("段落修改建议", leftX + 16, top + 18);
  let leftY = top + 56;
  for (const sample of samples) {
    context.fillStyle = "#c90000";
    context.font = `700 17px ${FONT_FAMILY}`;
    leftY = drawTextBlock(context, `${sample.title}：`, leftX + 16, leftY, leftWidth - 32, 24, 2) + 5;
    context.fillStyle = "#522f2f";
    context.font = `500 16px ${FONT_FAMILY}`;
    leftY = drawTextBlock(context, sample.suggestion, leftX + 16, leftY, leftWidth - 32, 23, 8) + 24;
  }

  context.fillStyle = "#255ab1";
  context.font = `700 21px ${FONT_FAMILY}`;
  context.fillText("改后范文", rightX + 16, top + 18);
  let rightY = top + 58;
  for (const sample of samples) {
    context.fillStyle = "#c90000";
    context.font = `700 17px ${FONT_FAMILY}`;
    rightY = drawTextBlock(context, sample.title, rightX + 16, rightY, rightWidth - 32, 24, 2) + 5;
    context.fillStyle = "#255ab1";
    context.font = `500 16px ${FONT_FAMILY}`;
    rightY = drawTextBlock(context, sample.text, rightX + 16, rightY, rightWidth - 32, 23, 12) + 22;
  }
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
    format: [PDF_WIDTH, PDF_HEIGHT],
    compress: true,
  });
  pdf.setProperties({ title: review.config.title, subject: "作文批改报告", author: "青藤未来作文批改助手" });
  const comment = splitComment(review.report.personalizedComment);
  const grade = review.report.grade ?? gradeFromLegacyTotal(review.report.scores?.total ?? 0);
  const pages: HTMLCanvasElement[] = [
    drawSummaryPage(review, "优点", points(comment.strengths), grade),
    drawSummaryPage(review, "需要修改", points([comment.improvement, ...review.report.painPoints])),
  ];
  for (let index = 0; index < review.images.length; index += 1) {
    pages.push(await drawFeedbackPage(review, index));
  }
  pages.forEach((canvas, index) => {
    if (index > 0) pdf.addPage([PDF_WIDTH, PDF_HEIGHT], "landscape");
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

export async function downloadReviewPdf(reviewId: string): Promise<string> {
  const review = await fetchReview(reviewId);
  const filename = reviewPdfFilename(review);
  triggerFileDownload(await createReviewPdf(review), filename);
  return filename;
}

export async function downloadReviewPdfArchive(reviewIds: string[]): Promise<string> {
  if (reviewIds.length === 0) throw new Error("请先选择批改记录");
  if (reviewIds.length === 1) return downloadReviewPdf(reviewIds[0]);
  const { default: JSZip } = await import("jszip");
  const archive = new JSZip();
  for (const reviewId of reviewIds) {
    const review = await fetchReview(reviewId);
    archive.file(reviewPdfFilename(review), await createReviewPdf(review));
  }
  const filename = "作文批改批量导出.zip";
  triggerFileDownload(await archive.generateAsync({ type: "blob", compression: "DEFLATE" }), filename);
  return filename;
}
