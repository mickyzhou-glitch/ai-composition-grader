import type { OcrCheckpoint } from "../ocr/contracts";
import { isOcrCheckpointV2 } from "../ocr/contracts";
import type { AssignmentConfig, EvaluationReport, TemplateType } from "./contracts";
import {
  createEvaluationReportSchema,
  gradeFromLegacyTotal,
  isParagraphEvaluationReport,
} from "./contracts";
import { validateSampleWritingRequirements } from "./sample-writing-requirements";

export class ReportValidationError extends Error {
  readonly status = 400;

  constructor(
    message: string,
    readonly code: "VALIDATION_ERROR" | "OCR_V2_REQUIRED" = "VALIDATION_ERROR",
  ) {
    super(message);
    this.name = "ReportValidationError";
  }
}

/** @deprecated 仅用于把历史 40 分记录迁移为新等级。 */
export const deriveLevel = gradeFromLegacyTotal;

export interface ReportValidationOptions {
  templateType?: TemplateType;
  config?: AssignmentConfig;
  incompleteEvent?: boolean;
  ocr?: OcrCheckpoint;
}

function validateParagraphCoverage(
  report: Extract<EvaluationReport, { version: 2 }>,
  ocr: OcrCheckpoint | undefined,
): void {
  if (!ocr || !isOcrCheckpointV2(ocr)) {
    throw new ReportValidationError(
      "OCR_V2_REQUIRED: paragraph reports require the current OCR v2 checkpoint",
      "OCR_V2_REQUIRED",
    );
  }

  const expectedIds = ocr.paragraphs.map(({ id }) => id);
  const actualIds = report.paragraphReviews.map(({ paragraphId }) => paragraphId);
  if (new Set(actualIds).size !== actualIds.length) {
    throw new ReportValidationError("paragraphReviews must use unique paragraphId values");
  }
  if (
    actualIds.length !== expectedIds.length
    || actualIds.some((paragraphId, index) => paragraphId !== expectedIds[index])
  ) {
    throw new ReportValidationError(
      "paragraphReviews paragraphId values must exactly match OCR paragraphs in order",
    );
  }
}

export function validateReport(
  input: unknown,
  options: ReportValidationOptions = {},
): EvaluationReport {
  const report = createEvaluationReportSchema(
    options.templateType ?? "preset_self_applause",
  ).parse(input);
  if (isParagraphEvaluationReport(report)) {
    validateParagraphCoverage(report, options.ocr);
  } else if (options.config) {
    try {
      validateSampleWritingRequirements(report.sampleParagraphs, options.config);
    } catch (error) {
      throw new ReportValidationError(
        error instanceof Error ? error.message : "sample paragraphs invalid",
      );
    }
  }
  if (
    (report.themeFit === "off_topic" || options.incompleteEvent === true) &&
    report.grade !== "C"
  ) {
    throw new ReportValidationError(
      "off_topic or incompleteEvent reports must be assigned grade C",
    );
  }

  return report;
}
