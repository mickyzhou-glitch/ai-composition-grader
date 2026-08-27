import type { DeliveryDocument } from "@/src/delivery/contracts";
import {
  deliveryReadiness,
  type DeliveryReadinessCode,
  type DeliveryReadinessInput,
} from "@/src/delivery/readiness";
import { paragraphEvaluationReportSchema } from "@/src/domain/contracts";
import type { PublicOcrView } from "@/src/ocr/contracts";
import { buildRevisionRuns } from "@/src/revisions/revision-diff";
import {
  cropImageRegion,
  type BitmapDimensions,
  type CroppedPng,
  type NormalizedImageRegion,
} from "./image-crop";

type DeliveryImage = {
  id: number;
  position: number;
  width: number;
  height: number;
};

export interface DeliveryReview extends DeliveryReadinessInput {
  id: string;
  studentName: string;
  config: { title: string };
  images: DeliveryImage[];
  ocr: PublicOcrView | null;
}

type BitmapResource = BitmapDimensions & { close?: () => void };

export interface DeliveryDocumentDependencies {
  fetchImage?: (url: string) => Promise<Blob>;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  decodeBitmap?: (blob: Blob, objectUrl: string) => Promise<BitmapResource>;
  cropImage?: (
    bitmap: BitmapResource,
    region: NormalizedImageRegion,
  ) => Promise<CroppedPng>;
}

export class DeliveryBuildError extends Error {
  constructor(
    readonly code: DeliveryReadinessCode | "CROP_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "DeliveryBuildError";
  }
}

async function defaultFetchImage(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`image request failed: ${response.status}`);
  return response.blob();
}

async function defaultDecodeBitmap(blob: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("ImageBitmap is unavailable");
  }
  return createImageBitmap(blob);
}

function imageUrl(reviewId: string, imageId: number): string {
  return `/api/reviews/${encodeURIComponent(reviewId)}/files?imageId=${imageId}&variant=ai`;
}

export async function buildDeliveryDocument(
  review: DeliveryReview,
  dependencies: DeliveryDocumentDependencies = {},
): Promise<DeliveryDocument> {
  const readiness = deliveryReadiness(review);
  if (!readiness.ready) {
    throw new DeliveryBuildError(readiness.code, readiness.message);
  }
  if (!review.ocr || review.ocr.version !== 2) {
    throw new DeliveryBuildError("OCR_V2_REQUIRED", "需要自然段识别结果");
  }
  const report = paragraphEvaluationReportSchema.parse(review.report);
  const fetchImage = dependencies.fetchImage ?? defaultFetchImage;
  const createObjectURL = dependencies.createObjectURL ?? URL.createObjectURL.bind(URL);
  const revokeObjectURL = dependencies.revokeObjectURL ?? URL.revokeObjectURL.bind(URL);
  const decodeBitmap = dependencies.decodeBitmap ?? defaultDecodeBitmap;
  const cropImage = dependencies.cropImage ?? cropImageRegion;
  const imageByPage = new Map(review.images.map((image) => [image.position, image]));
  const resources = new Map<number, { bitmap: BitmapResource; objectUrl: string }>();

  const loadPage = async (pageIndex: number) => {
    const loaded = resources.get(pageIndex);
    if (loaded) return loaded.bitmap;
    const image = imageByPage.get(pageIndex);
    if (!image) throw new Error("image page missing");
    const blob = await fetchImage(imageUrl(review.id, image.id));
    const objectUrl = createObjectURL(blob);
    try {
      const bitmap = await decodeBitmap(blob, objectUrl);
      resources.set(pageIndex, { bitmap, objectUrl });
      return bitmap;
    } catch (error) {
      revokeObjectURL(objectUrl);
      throw error;
    }
  };

  try {
    const paragraphs = [];
    for (const paragraph of [...review.ocr.paragraphs].sort(
      (left, right) => left.paragraphIndex - right.paragraphIndex,
    )) {
      const paragraphReport = report.paragraphReviews.find(
        ({ paragraphId }) => paragraphId === paragraph.id,
      );
      if (!paragraphReport) {
        throw new DeliveryBuildError(
          "PARAGRAPH_COVERAGE_MISMATCH",
          "逐段批改没有完整覆盖当前识别自然段",
        );
      }
      const crops = [];
      for (const segment of paragraph.segments) {
        try {
          const bitmap = await loadPage(segment.pageIndex);
          crops.push({ pageIndex: segment.pageIndex, ...await cropImage(bitmap, segment) });
        } catch {
          throw new DeliveryBuildError(
            "CROP_FAILED",
            `第 ${paragraph.paragraphIndex + 1} 段第 ${segment.pageIndex + 1} 页裁图失败`,
          );
        }
      }
      paragraphs.push({
        paragraphNumber: paragraph.paragraphIndex + 1,
        crops,
        suggestions: paragraphReport.suggestions,
        revisionRuns: buildRevisionRuns(paragraph.text, paragraphReport.revisedText),
      });
    }
    return {
      title: review.config.title,
      studentName: review.studentName,
      paragraphs,
    };
  } finally {
    for (const { bitmap, objectUrl } of resources.values()) {
      try {
        bitmap.close?.();
      } catch {
        // Resource cleanup must continue for the remaining pages.
      }
      try {
        revokeObjectURL(objectUrl);
      } catch {
        // A failed revocation must not hide the delivery result or crop error.
      }
    }
  }
}
