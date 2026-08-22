import type {
  Annotation,
  AssignmentConfig,
  EvaluationReport,
  NormalizedCrop,
  ReviewStatus,
} from "@/src/domain/contracts";

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
  config: AssignmentConfig;
  report: EvaluationReport | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  teacherReviewedAt: string | null;
  expiresAt?: string | null;
  images: ReviewImageView[];
  annotations: Annotation[];
  ocr: {
    ocrRevision: number;
    editedAt: string | null;
    pages: Array<{ pageIndex: number; text: string; readable: boolean; warnings: string[] }>;
  } | null;
  reportStale: boolean;
  hasPdf: boolean;
  pdfFilename: string | null;
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
  createdAt: string;
  finishedAt: string | null;
}

export interface RevisionRequestResult {
  job: PublicAnalysisJobView;
  newlyQueued: true;
}
