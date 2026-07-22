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
  config: AssignmentConfig;
  report: EvaluationReport | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string | null;
  images: ReviewImageView[];
  annotations: Annotation[];
  hasPdf: boolean;
  pdfFilename: string | null;
}
