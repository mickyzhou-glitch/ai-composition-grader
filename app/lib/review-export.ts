import { isLegacyEvaluationReport } from "@/src/domain/contracts";

import { apiFetch } from "./api";
import { buildDeliveryDocument } from "./delivery-document";
import { paginateDeliveryDocument } from "./delivery-pagination";
import { createReviewDocx } from "./docx-download";
import {
  createReviewPdf,
  markReviewExported,
  triggerFileDownload,
} from "./pdf-download";
import type { ReviewView } from "./types";

export type ExportFormat = "pdf" | "docx";

const MEMORY_ERROR_MESSAGE = "生成文件时内存不足，请减少单次批量数量后重试";

function safeFilenamePart(value: string, fallback: string): string {
  return value
    .replace(/[\\/:*?"<>|]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 60) || fallback;
}

export function reviewFilename(review: ReviewView, format: ExportFormat): string {
  const title = safeFilenamePart(review.config.title, "未命名作文");
  const student = safeFilenamePart(review.studentName, "未填写学生姓名");
  return `作文批改-${title}-${student}.${format}`;
}

export function archiveFilename(format: ExportFormat): string {
  return `作文批改批量导出-${format === "pdf" ? "PDF" : "Word"}.zip`;
}

function uniqueArchiveEntry(filename: string, used: Set<string>): string {
  if (!used.has(filename)) {
    used.add(filename);
    return filename;
  }
  const extensionIndex = filename.lastIndexOf(".");
  const stem = extensionIndex > 0 ? filename.slice(0, extensionIndex) : filename;
  const extension = extensionIndex > 0 ? filename.slice(extensionIndex) : "";
  let sequence = 2;
  let candidate = `${stem}-${sequence}${extension}`;
  while (used.has(candidate)) {
    sequence += 1;
    candidate = `${stem}-${sequence}${extension}`;
  }
  used.add(candidate);
  return candidate;
}

async function fetchReview(reviewId: string): Promise<ReviewView> {
  return apiFetch<ReviewView>(`/api/reviews/${encodeURIComponent(reviewId)}`);
}

async function assertReviewsExportable(reviews: ReviewView[]): Promise<void> {
  await apiFetch<{ exportable: true }>("/api/reviews/export-check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      reviews: reviews.map(({ id, revision }) => ({ id, revision })),
    }),
  });
}

async function createExportFile(review: ReviewView, format: ExportFormat): Promise<Blob> {
  if (format === "pdf") return createReviewPdf(review);
  const delivery = await buildDeliveryDocument(review);
  const pages = paginateDeliveryDocument(delivery);
  return createReviewDocx(delivery, pages);
}

function isMemoryFailure(error: unknown): boolean {
  return error instanceof RangeError
    || (error instanceof Error
      && /out of memory|allocation failed|array buffer|array length|typed array/iu.test(error.message));
}

async function withMemoryErrorMessage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isMemoryFailure(error)) throw new Error(MEMORY_ERROR_MESSAGE, { cause: error });
    throw error;
  }
}

export async function downloadReview(
  reviewId: string,
  format: ExportFormat,
): Promise<string> {
  return withMemoryErrorMessage(async () => {
    const review = await fetchReview(reviewId);
    await assertReviewsExportable([review]);
    const filename = reviewFilename(review, format);
    const blob = await createExportFile(review, format);
    triggerFileDownload(blob, filename);
    await markReviewExported(reviewId);
    return filename;
  });
}

export async function downloadReviewArchive(
  reviewIds: string[],
  format: ExportFormat,
): Promise<string> {
  if (reviewIds.length === 0) throw new Error("请先选择批改记录");
  if (reviewIds.length === 1) return downloadReview(reviewIds[0], format);

  return withMemoryErrorMessage(async () => {
    const reviews: ReviewView[] = [];
    for (const reviewId of reviewIds) reviews.push(await fetchReview(reviewId));
    await assertReviewsExportable(reviews);

    const { default: JSZip } = await import("jszip");
    const archive = new JSZip();
    const archiveEntries = new Set<string>();
    for (const review of reviews) {
      archive.file(
        uniqueArchiveEntry(reviewFilename(review, format), archiveEntries),
        await createExportFile(review, format),
      );
    }
    const filename = archiveFilename(format);
    const blob = await archive.generateAsync({ type: "blob", compression: "DEFLATE" });
    triggerFileDownload(blob, filename);
    for (const reviewId of reviewIds) await markReviewExported(reviewId);
    return filename;
  });
}

function responseFilename(response: Response, fallback: string): string {
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/iu.exec(disposition)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^"|"$/gu, ""));
    } catch {
      // Fall back to the persisted server filename when the header is malformed.
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"/iu.exec(disposition)?.[1];
  return plain?.trim() || fallback;
}

export async function downloadLegacyCachedPdf(review: ReviewView): Promise<string> {
  if (
    !review.report
    || !isLegacyEvaluationReport(review.report)
    || review.hasPdf !== true
    || !review.pdfFilename?.trim()
  ) {
    throw new Error("没有可下载的旧版 PDF");
  }
  const response = await fetch(`/api/reviews/${encodeURIComponent(review.id)}/pdf`);
  if (!response.ok) throw new Error(`旧版 PDF 下载失败（${response.status}）`);
  const filename = responseFilename(response, review.pdfFilename);
  triggerFileDownload(await response.blob(), filename);
  return filename;
}
