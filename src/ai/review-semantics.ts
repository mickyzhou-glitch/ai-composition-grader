import type { AssignmentConfig, EvaluationReport } from "../domain/contracts";
import { validateReport } from "../domain/report-validation";

const FORBIDDEN_TIME_OPENING = /^(?:那天(?:以后)?|后来|最后|第二天|第二日|一天(?:以后)?|早晨|清晨|上午|中午|下午|傍晚|晚上|放学后|回家后|过了(?:一会|几天|不久))/u;

const EXPECTED_PARENT_FEEDBACKS = [
  { style: "warm", title: "亲切详细" },
  { style: "professional", title: "专业清晰" },
  { style: "concise", title: "简短微信版" },
] as const;

const FEEDBACK_ITEM_PREFIX = /^\s*(?:(?:[1-4]|[一二三四])[.、．)）:]|[-*•])\s*/u;

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
  if (config.templateType === "preset_self_applause" && report.sampleParagraphs.length !== 5) {
    throw new Error("preset composition requires five sample paragraphs");
  }
  if (report.sampleParagraphs.some((paragraph) => FORBIDDEN_TIME_OPENING.test(paragraph.text.trim()))) {
    throw new Error("sample paragraphs must not begin with a time word");
  }
  const strengths = report.personalizedComment
    .split(/\r?\n/u)
    .map(normalizeFeedbackItem);
  const painPoints = report.painPoints.map(normalizeFeedbackItem);
  const concise = (item: string) => {
    const length = Array.from(item).length;
    return length >= 8 && length <= 40;
  };
  if (
    strengths.length < 2 || strengths.length > 4 || !strengths.every(concise) ||
    painPoints.length < 2 || painPoints.length > 4 || !painPoints.every(concise) ||
    report.commonIssues.length !== 0 || report.revisionSuggestions.length !== 0
  ) {
    throw new Error("overall feedback must contain two to four concise strengths and improvements");
  }
  return {
    ...report,
    personalizedComment: strengths.join("\n"),
    painPoints,
  };
}
