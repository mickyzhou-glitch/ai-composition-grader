import { z } from "zod";

export const BATCH_REANALYSIS_LIMIT = 20;
export const MAX_REVISION_FIELD_CHARS = 500;
export const MAX_ANALYSIS_TEACHER_GUIDANCE_CHARS = 1_100;

const safeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);

const revisionFieldSchema = z.string().trim().max(MAX_REVISION_FIELD_CHARS).optional().default("");

export const revisionRequestInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  commonIssue: revisionFieldSchema,
  contentSuggestion: revisionFieldSchema,
}).strict().refine(
  (value) => value.commonIssue.length > 0 || value.contentSuggestion.length > 0,
  { message: "至少填写结构问题或内容建议" },
);

export const rejectReviewInputSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().max(MAX_REVISION_FIELD_CHARS).optional().default(""),
  changeRequest: z.string().max(MAX_REVISION_FIELD_CHARS).optional().default(""),
}).strict().transform((value) => ({
  expectedRevision: value.expectedRevision,
  reason: value.reason.trim(),
  changeRequest: value.changeRequest.trim(),
}));

export const batchReanalysisPreviewInputSchema = z.object({
  reviewIds: z.array(safeIdSchema).min(1).max(BATCH_REANALYSIS_LIMIT),
}).strict().superRefine(({ reviewIds }, context) => {
  if (new Set(reviewIds).size !== reviewIds.length) {
    context.addIssue({
      code: "custom",
      path: ["reviewIds"],
      message: "review ids must be unique",
    });
  }
});

const batchReanalysisCommitItemSchema = z.object({
  reviewId: safeIdSchema,
  expectedRevision: z.number().int().nonnegative(),
  assignmentId: safeIdSchema,
  expectedAssignmentUpdatedAt: z.string().datetime(),
}).strict();

export const batchReanalysisCommitInputSchema = z.object({
  items: z.array(batchReanalysisCommitItemSchema).min(1).max(BATCH_REANALYSIS_LIMIT),
}).strict().superRefine(({ items }, context) => {
  const reviewIds = items.map(({ reviewId }) => reviewId);
  if (new Set(reviewIds).size !== reviewIds.length) {
    context.addIssue({
      code: "custom",
      path: ["items"],
      message: "review ids must be unique",
    });
  }
});

export type RevisionRequestInput = z.infer<typeof revisionRequestInputSchema>;
export type RejectReviewInput = z.infer<typeof rejectReviewInputSchema>;

export interface RejectReviewResult {
  id: string;
  status: "rejected";
  revision: number;
  rejectionReason: string | null;
  rejectionChangeRequest: string | null;
}
export type BatchReanalysisCommitItem = z.infer<typeof batchReanalysisCommitItemSchema>;

export function normalizeAssignmentTitle(value: string): string {
  return value.trim();
}

export function formatRevisionTeacherGuidance(commonIssue: string, contentSuggestion: string): string {
  const issue = commonIssue.trim();
  const suggestion = contentSuggestion.trim();
  const parts: string[] = [];
  if (issue) parts.push(`[结构问题 / 共性问题]\n${issue}`);
  if (suggestion) parts.push(`[内容建议]\n${suggestion}`);
  if (parts.length === 0) throw new Error("revision guidance requires a field");
  return parts.join("\n");
}

export const REANALYSIS_SKIP_REASONS = {
  FRAMEWORK_NOT_FOUND: "没有找到同名的已保存题目框架",
  FRAMEWORK_CHANGED: "题目框架已更新，请重新预览",
  REVIEW_NOT_FOUND: "作文不存在或已不可用",
  REVISION_CONFLICT: "作文已更新，请重新预览",
  OCR_NOT_CURRENT: "识别原文不存在或已失效",
  IMAGES_MISSING: "原始图片不存在，无法重新识别",
  ANALYSIS_ACTIVE: "作文正在分析中",
  REVIEW_UNAVAILABLE: "作文当前状态不能重新分析",
} as const;

export type ReanalysisSkipCode = keyof typeof REANALYSIS_SKIP_REASONS;

export interface PublicAnalysisJobView {
  id: string;
  reviewId: string;
  mode: "full" | "content_only";
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  progressStage:
    | "queued"
    | "reading_images"
    | "saving_ocr"
    | "generating_review"
    | "mapping_annotations"
    | "validating_result"
    | "saving_result";
  message: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface RevisionRequestResult {
  job: PublicAnalysisJobView;
  newlyQueued: true;
}

export interface BatchReanalysisMatchedItem {
  reviewId: string;
  studentName: string;
  title: string;
  expectedRevision: number;
  assignmentId: string;
  assignmentUpdatedAt: string;
}

export interface BatchReanalysisSkippedItem {
  reviewId: string;
  studentName?: string;
  title?: string;
  code: ReanalysisSkipCode;
  reason: string;
}

export interface BatchReanalysisPreview {
  matched: BatchReanalysisMatchedItem[];
  skipped: BatchReanalysisSkippedItem[];
}

export interface BatchReanalysisSubmittedItem {
  reviewId: string;
  jobId: string;
  revision: number;
}

export interface BatchReanalysisCommitResult {
  submitted: BatchReanalysisSubmittedItem[];
  skipped: BatchReanalysisSkippedItem[];
}
