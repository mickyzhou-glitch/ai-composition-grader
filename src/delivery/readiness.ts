import {
  isLegacyEvaluationReport,
} from "../domain/contracts";
import {
  ReportValidationError,
  validateParagraphReportForIds,
} from "../domain/report-validation";

export type DeliveryReadinessCode =
  | "REPORT_MISSING"
  | "TEACHER_REVIEW_REQUIRED"
  | "LEGACY_REPORT"
  | "OCR_V2_REQUIRED"
  | "REPORT_STALE"
  | "PARAGRAPH_COVERAGE_MISMATCH"
  | "CROP_MISSING"
  | "CROP_OUT_OF_BOUNDS"
  | "REPORT_INVALID"
  | "IMAGE_PAGE_MISSING";

export type DeliveryReadiness =
  | { ready: true }
  | { ready: false; code: DeliveryReadinessCode; message: string };

export interface DeliveryReadinessInput {
  report: unknown | null;
  teacherReviewedAt: string | Date | null;
  reportStale?: boolean;
  reportOcrRevision?: number | null;
  ocr: unknown | null;
  images: Array<{ position: number; width?: number; height?: number }>;
  hasPdf?: boolean;
}

type PublicSegment = {
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type PublicParagraph = {
  id: string;
  paragraphIndex: number;
  text: string;
  segments: PublicSegment[];
};

function failure(code: DeliveryReadinessCode, message: string): DeliveryReadiness {
  return { ready: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validSegment(value: unknown): value is PublicSegment {
  if (!isRecord(value)) return false;
  const { pageIndex, x, y, width, height } = value;
  return Number.isInteger(pageIndex) && (pageIndex as number) >= 0
    && finiteNumber(x) && x >= 0 && x <= 1
    && finiteNumber(y) && y >= 0 && y <= 1
    && finiteNumber(width) && width > 0 && width <= 1
    && finiteNumber(height) && height > 0 && height <= 1
    && x + width <= 1
    && y + height <= 1;
}

function publicParagraphs(ocr: Record<string, unknown>): PublicParagraph[] | null {
  if (!Array.isArray(ocr.paragraphs)) return null;
  const result: PublicParagraph[] = [];
  for (const value of ocr.paragraphs) {
    if (!isRecord(value)) return null;
    if (
      typeof value.id !== "string"
      || !Number.isInteger(value.paragraphIndex)
      || typeof value.text !== "string"
      || !Array.isArray(value.segments)
    ) {
      return null;
    }
    result.push({
      id: value.id,
      paragraphIndex: value.paragraphIndex as number,
      text: value.text,
      segments: value.segments as PublicSegment[],
    });
  }
  return result;
}

export function deliveryReadiness(input: DeliveryReadinessInput): DeliveryReadiness {
  if (input.report === null || input.report === undefined) {
    return failure("REPORT_MISSING", "批改报告尚未完成");
  }
  if (isLegacyEvaluationReport(input.report)) {
    return failure(
      "LEGACY_REPORT",
      "旧版示范段落报告需要完整重新分析后才能导出新格式",
    );
  }
  if (!input.teacherReviewedAt) {
    return failure("TEACHER_REVIEW_REQUIRED", "尚未经过老师审核");
  }
  if (!isRecord(input.ocr) || input.ocr.version !== 2) {
    return failure("OCR_V2_REQUIRED", "需要完整重新分析为自然段识别结果后才能导出");
  }
  if (input.reportStale === true) {
    return failure("REPORT_STALE", "批改报告基于旧版识别原文，请重新生成批改");
  }
  if (
    input.reportOcrRevision !== undefined
    && input.reportOcrRevision !== null
    && input.reportOcrRevision !== input.ocr.ocrRevision
  ) {
    return failure("REPORT_STALE", "批改报告基于旧版识别原文，请重新生成批改");
  }

  const paragraphs = publicParagraphs(input.ocr);
  if (!paragraphs || paragraphs.length === 0) {
    return failure("CROP_MISSING", "识别结果没有可用于导出的自然段裁图");
  }
  try {
    validateParagraphReportForIds(input.report, paragraphs.map(({ id }) => id));
  } catch (error) {
    if (
      error instanceof ReportValidationError
      && error.code === "PARAGRAPH_COVERAGE_MISMATCH"
    ) {
      return failure(
        "PARAGRAPH_COVERAGE_MISMATCH",
        "逐段批改没有完整覆盖当前识别自然段",
      );
    }
    return failure("REPORT_INVALID", "逐段批改报告字段或语义不符合要求");
  }

  const imagePages = new Set(input.images.map(({ position }) => position));
  const ocrPages = new Set(
    Array.isArray(input.ocr.pages)
      ? input.ocr.pages.flatMap((page) => (
          isRecord(page) && Number.isInteger(page.pageIndex)
            ? [page.pageIndex as number]
            : []
        ))
      : [],
  );
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const paragraph = paragraphs[paragraphIndex];
    if (paragraph.paragraphIndex !== paragraphIndex || paragraph.segments.length === 0) {
      return failure("CROP_MISSING", `第 ${paragraphIndex + 1} 段没有可用于导出的裁图区域`);
    }
    for (const segment of paragraph.segments) {
      if (!validSegment(segment)) {
        return failure("CROP_OUT_OF_BOUNDS", `第 ${paragraphIndex + 1} 段裁图区域超出页面边界`);
      }
      if (!ocrPages.has(segment.pageIndex) || !imagePages.has(segment.pageIndex)) {
        return failure("IMAGE_PAGE_MISSING", `第 ${segment.pageIndex + 1} 页图片不存在`);
      }
    }
  }

  return { ready: true };
}
