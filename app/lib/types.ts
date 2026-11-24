import type {
  Annotation,
  AssignmentConfig,
  EvaluationReport,
  NormalizedCrop,
  ReviewStatus,
} from "@/src/domain/contracts";
import type { PublicOcrView } from "@/src/ocr/contracts";
export type {
  BatchReanalysisCommitItem,
  BatchReanalysisCommitResult,
  BatchReanalysisMatchedItem,
  BatchReanalysisPreview,
  BatchReanalysisSkippedItem,
} from "@/src/reanalysis/contracts";

export interface ReviewImageView {
  id: number;
  position: number;
  originalName: string;
  mimeType: string;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  crop: NormalizedCrop | null;
}

export interface ReviewView {
  id: string;
  status: ReviewStatus;
  studentName: string;
  className?: string;
  config: AssignmentConfig;
  report: EvaluationReport | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  teacherReviewedAt: string | null;
  rejectionReason?: string | null;
  rejectionChangeRequest?: string | null;
  expiresAt?: string | null;
  images: ReviewImageView[];
  annotations: Annotation[];
  ocr: PublicOcrView | null;
  reportStale: boolean;
  hasPdf: boolean;
  pdfFilename: string | null;
  teacherGuidance?: string | null;
  effectiveTeacherGuidance?: string | null;
  essayHistory?: Array<{ text: string; createdAt: number }>;
  analysisFailure?: {
    summary: string;
    detail: string | null;
  } | null;
}

export interface ReviewHistoryStatsView {
  total: number;
  draft: number;
  review: number;
  failed: number;
  reviewed: number;
  exported: number;
  rejected: number;
}

export interface ReviewSummaryDiagnosticsView {
  authenticityAndRelevance: { finding: string; action: string };
  structure: { finding: string; action: string };
}

export interface ReviewSummaryView {
  id: string;
  status: ReviewStatus;
  studentName: string;
  className: string;
  config: { title: string };
  revision: number;
  createdAt: string;
  updatedAt: string;
  teacherReviewedAt: string | null;
  hasReport: boolean;
  isLegacyReport: boolean;
  grade: string | null;
  diagnostics?: ReviewSummaryDiagnosticsView | null;
  hasPdf: boolean;
  pdfFilename: string | null;
  exportEligibility: { eligible: true } | { eligible: false; reason: string };
  /** 标记该条历史记录尚未完成迁移后的权威摘要回填，防止前端把待同步记录误当作完整批次一键导出 */
  summarySyncPending?: boolean;
  analysisFailure?: {
    summary: string;
    detail: string | null;
  } | null;
}

export interface ReviewSummaryPageView {
  items: ReviewSummaryView[];
  page: number;
  pageSize: number;
  totalFiltered: number;
  stats: ReviewHistoryStatsView;
  classes: string[];
  exportableReviewedIds: string[];
  matchingFailed: Array<{ id: string; studentName: string }>;
  /** 若迁移后尚有未完成权威回填的历史记录，标明剩余待同步篇数，供前端提示并避免导出残缺批次 */
  summaryBackfillPending?: number;
}

export type PublicAnalysisJobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export type PublicAnalysisJobProgressStage =
  | "queued"
  | "reading_images"
  | "saving_ocr"
  | "generating_review"
  | "mapping_annotations"
  | "validating_result"
  | "saving_result";

export interface PublicAnalysisJobView {
  id: string;
  reviewId: string;
  mode: "content_only";
  status: PublicAnalysisJobStatus;
  progressStage: PublicAnalysisJobProgressStage;
  message: string | null;
  detail: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface RevisionRequestResult {
  job: PublicAnalysisJobView;
  newlyQueued: true;
}
