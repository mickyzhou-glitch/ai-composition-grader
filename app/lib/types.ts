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
  mimeType?: string;
  originalPath?: string;
  annotationPath: string;
  aiPath?: string;
  width?: number;
  height?: number;
  rotation?: 0 | 90 | 180 | 270;
  crop?: NormalizedCrop | null;
}

export interface ReviewView {
  id: string;
  status: ReviewStatus;
  config: AssignmentConfig;
  report: EvaluationReport | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  images: ReviewImageView[];
  annotations: Annotation[];
}
