import type { EvaluationReport, TemplateType } from "./contracts";
import { createEvaluationReportSchema } from "./contracts";

export function deriveLevel(total: number) {
  if (!Number.isInteger(total) || total < 0 || total > 40) {
    throw new RangeError("total must be an integer from 0 to 40");
  }
  if (total <= 29) return "重写" as const;
  if (total <= 35) return "二类作文" as const;
  return "优秀作文" as const;
}

export interface ReportValidationOptions {
  templateType?: TemplateType;
  incompleteEvent?: boolean;
}

export function validateReport(
  input: unknown,
  options: ReportValidationOptions = {},
): EvaluationReport {
  const report = createEvaluationReportSchema(
    options.templateType ?? "preset_self_applause",
  ).parse(input);
  const { scores } = report;
  const calculatedTotal =
    scores.themeIntent +
    scores.contentSelection +
    scores.structure +
    scores.languageExpression +
    scores.writingConventions;

  if (scores.total !== calculatedTotal) {
    throw new Error(
      `scores.total must equal the sum of score items (${calculatedTotal})`,
    );
  }

  const expectedLevel = deriveLevel(scores.total);
  if (scores.level !== expectedLevel) {
    throw new Error(
      `scores.level must be ${expectedLevel} when total is ${scores.total}`,
    );
  }

  if (
    (report.themeFit === "off_topic" || options.incompleteEvent === true) &&
    scores.total > 29
  ) {
    throw new Error(
      "off_topic or incompleteEvent reports must have a total no greater than 29",
    );
  }

  return report;
}
