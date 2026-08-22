import {
  expectedSampleParagraphCount,
  type AssignmentConfig,
  type EvaluationReport,
} from "../domain/contracts";
import { validateReport } from "../domain/report-validation";

const EXPECTED_PARENT_FEEDBACKS = [
  { style: "warm", title: "亲切详细" },
  { style: "professional", title: "专业清晰" },
  { style: "concise", title: "简短微信版" },
] as const;

const FEEDBACK_ITEM_PREFIX = /^\s*(?:(?:[1-9]\d*|[一二三四五六七八九十百千万两〇零]+)[.．:、)）](?![0-9一二三四五六七八九十百千万两〇零])|[-*•](?![0-9一二三四五六七八九十百千万两〇零]))\s*/u;

function normalizeFeedbackItem(item: string): string {
  return item.trim().replace(FEEDBACK_ITEM_PREFIX, "").trim();
}

export function validateGeneratedReportSemantics(
  input: unknown,
  config: AssignmentConfig,
  studentName?: string,
): EvaluationReport {
  const report = validateReport(input, { templateType: config.templateType });
  const feedbacks = report.parentFeedbacks ?? [];
  if (feedbacks.length !== EXPECTED_PARENT_FEEDBACKS.length) {
    throw new Error("parent feedback count must be three");
  }
  const expectedGreeting = studentName?.trim() ? `${studentName.trim()}家长` : "家长您好";
  feedbacks.forEach((feedback, index) => {
    const expected = EXPECTED_PARENT_FEEDBACKS[index];
    if (
      feedback.style !== expected.style ||
      feedback.title !== expected.title ||
      !feedback.content.startsWith(expectedGreeting)
    ) {
      throw new Error("parent feedback semantics are invalid");
    }
  });
  const expectedParagraphs = expectedSampleParagraphCount(config);
  if (report.sampleParagraphs.length !== expectedParagraphs) {
    throw new Error(`composition requires ${expectedParagraphs} sample paragraphs`);
  }
  const strengths = report.personalizedComment
    .split(/\r?\n/u)
    .map(normalizeFeedbackItem)
    .filter(Boolean);
  const painPoints = report.painPoints
    .map(normalizeFeedbackItem)
    .filter(Boolean);
  return {
    ...report,
    personalizedComment: strengths.join("\n"),
    painPoints,
    commonIssues: [],
    revisionSuggestions: [],
  };
}
