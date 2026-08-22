import type { AssignmentConfig, EvaluationReport, TemplateType } from "./contracts";
import { createEvaluationReportSchema, gradeFromLegacyTotal } from "./contracts";
import { validateSampleWritingRequirements } from "./sample-writing-requirements";

export class ReportValidationError extends Error {
  readonly code = "VALIDATION_ERROR";
  readonly status = 400;
}

/** @deprecated 仅用于把历史 40 分记录迁移为新等级。 */
export const deriveLevel = gradeFromLegacyTotal;

export interface ReportValidationOptions {
  templateType?: TemplateType;
  config?: AssignmentConfig;
  incompleteEvent?: boolean;
}

export function validateReport(
  input: unknown,
  options: ReportValidationOptions = {},
): EvaluationReport {
  const report = createEvaluationReportSchema(
    options.templateType ?? "preset_self_applause",
  ).parse(input);
  if (options.config) {
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
