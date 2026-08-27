import type { OcrCheckpoint } from "../ocr/contracts";
import { isOcrCheckpointV2 } from "../ocr/contracts";
import type {
  AssignmentConfig,
  EvaluationReport,
  ParagraphEvaluationReport,
  TemplateType,
} from "./contracts";
import {
  createEvaluationReportSchema,
  gradeFromLegacyTotal,
  isParagraphEvaluationReport,
  paragraphEvaluationReportSchema,
} from "./contracts";
import { validateSampleWritingRequirements } from "./sample-writing-requirements";

export class ReportValidationError extends Error {
  readonly status = 400;

  constructor(
    message: string,
    readonly code:
      | "VALIDATION_ERROR"
      | "OCR_V2_REQUIRED"
      | "PARAGRAPH_COVERAGE_MISMATCH" = "VALIDATION_ERROR",
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
  report: ParagraphEvaluationReport,
  expectedIds: readonly string[],
): void {
  const actualIds = report.paragraphReviews.map(({ paragraphId }) => paragraphId);
  if (new Set(actualIds).size !== actualIds.length) {
    throw new ReportValidationError(
      "paragraphReviews must use unique paragraphId values",
      "PARAGRAPH_COVERAGE_MISMATCH",
    );
  }
  if (
    actualIds.length !== expectedIds.length
    || actualIds.some((paragraphId, index) => paragraphId !== expectedIds[index])
  ) {
    throw new ReportValidationError(
      "paragraphReviews paragraphId values must exactly match OCR paragraphs in order",
      "PARAGRAPH_COVERAGE_MISMATCH",
    );
  }
}

function validateReportGrade(
  report: EvaluationReport,
  incompleteEvent: boolean | undefined,
): void {
  if (
    (report.themeFit === "off_topic" || incompleteEvent === true)
    && report.grade !== "C"
  ) {
    throw new ReportValidationError(
      "off_topic or incompleteEvent reports must be assigned grade C",
    );
  }
}

export function validateParagraphReportForIds(
  input: unknown,
  paragraphIds: readonly string[],
  options: { incompleteEvent?: boolean } = {},
): ParagraphEvaluationReport {
  const report = paragraphEvaluationReportSchema.parse(input);
  validateParagraphCoverage(report, paragraphIds);
  validateReportGrade(report, options.incompleteEvent);
  return report;
}

export function validateReport(
  input: unknown,
  options: ReportValidationOptions = {},
): EvaluationReport {
  const report = createEvaluationReportSchema(
    options.templateType ?? "preset_self_applause",
  ).parse(input);
  if (isParagraphEvaluationReport(report)) {
    if (!options.ocr || !isOcrCheckpointV2(options.ocr)) {
      throw new ReportValidationError(
        "OCR_V2_REQUIRED: paragraph reports require the current OCR v2 checkpoint",
        "OCR_V2_REQUIRED",
      );
    }
    return validateParagraphReportForIds(
      report,
      options.ocr.paragraphs.map(({ id }) => id),
      { incompleteEvent: options.incompleteEvent },
    );
  } else if (options.config) {
    try {
      validateSampleWritingRequirements(report.sampleParagraphs, options.config);
    } catch (error) {
      throw new ReportValidationError(
        error instanceof Error ? error.message : "sample paragraphs invalid",
      );
    }
  }
  validateReportGrade(report, options.incompleteEvent);

  return report;
}
