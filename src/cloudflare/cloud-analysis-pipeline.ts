import type { CompositionReviewResult } from "../ai/composition-review-adapter";
import type { VisionOcrResult } from "../ai/vision-ocr-adapter";
import type { Annotation, AssignmentConfig, EvaluationReport } from "../domain/contracts";
import { validateReport } from "../domain/report-validation";
import { analysisModeForCheckpoint } from "../ocr/analysis-mode";
import { mapAnnotationAnchors } from "../ocr/annotation-mapper";
import type { OcrCheckpoint, OcrCheckpointV2 } from "../ocr/contracts";

export type AnalysisJobMode = "full" | "content_only";
export type CloudAnalysisProgressStage =
  | "reading_images"
  | "saving_ocr"
  | "generating_review"
  | "mapping_annotations"
  | "validating_result"
  | "saving_result";

export interface CloudAnalysisPipelineJob {
  id: string;
  reviewId: string;
  ownerId: string;
  mode: AnalysisJobMode;
  imageRevision: number;
  config: AssignmentConfig;
  teacherGuidance?: string;
  studentName?: string;
}

export interface CloudAnalysisPipelineDependencies {
  readCheckpoint(ownerId: string, reviewId: string): Promise<OcrCheckpoint | null>;
  loadImageUrls(job: CloudAnalysisPipelineJob): Promise<string[]>;
  recognize(imageUrls: string[]): Promise<VisionOcrResult>;
  saveRecognized(
    ownerId: string,
    reviewId: string,
    sourceRevision: number,
    result: VisionOcrResult,
  ): Promise<OcrCheckpointV2>;
  analyzeText(input: {
    config: AssignmentConfig;
    paragraphs: Array<{ id: string; text: string }>;
    teacherGuidance?: string;
    studentName?: string;
  }): Promise<CompositionReviewResult>;
  updateStage(jobId: string, stage: CloudAnalysisProgressStage): Promise<void>;
  saveResult(job: CloudAnalysisPipelineJob, input: {
    report: EvaluationReport;
    annotations: Annotation[];
    ocrRevision: number;
  }): Promise<void>;
  saveUnreadable(job: CloudAnalysisPipelineJob, checkpoint: OcrCheckpoint): Promise<void>;
}

export class CloudAnalysisConflictError extends Error {
  constructor(readonly code: "OCR_NOT_FOUND" | "ANALYSIS_CONFLICT") {
    super(code);
    this.name = "CloudAnalysisConflictError";
  }
}

export class CloudAnalysisPipeline {
  constructor(private readonly dependencies: CloudAnalysisPipelineDependencies) {}

  async run(job: CloudAnalysisPipelineJob): Promise<void> {
    let checkpoint = await this.dependencies.readCheckpoint(job.ownerId, job.reviewId);
    if (checkpoint && checkpoint.sourceRevision !== job.imageRevision) checkpoint = null;
    const mode = analysisModeForCheckpoint(job.mode, checkpoint);
    if (mode === "full") checkpoint = null;

    if (!checkpoint) {
      await this.dependencies.updateStage(job.id, "reading_images");
      const imageUrls = await this.dependencies.loadImageUrls(job);
      const recognized = await this.dependencies.recognize(imageUrls);
      await this.dependencies.updateStage(job.id, "saving_ocr");
      checkpoint = await this.dependencies.saveRecognized(
        job.ownerId,
        job.reviewId,
        job.imageRevision,
        recognized,
      );
    }

    if (checkpoint.version !== 2) {
      throw new TypeError("Full OCR analysis must produce an OCR v2 checkpoint");
    }

    if (checkpoint.pages.some((page) => !page.readable)) {
      await this.dependencies.saveUnreadable(job, checkpoint);
      return;
    }

    await this.dependencies.updateStage(job.id, "generating_review");
    const result = await this.dependencies.analyzeText({
      config: job.config,
      paragraphs: checkpoint.paragraphs.map(({ id, text }) => ({ id, text })),
      teacherGuidance: job.teacherGuidance,
      studentName: job.studentName,
    });
    await this.dependencies.updateStage(job.id, "mapping_annotations");
    const annotations = mapAnnotationAnchors(checkpoint, result.annotationAnchors);
    await this.dependencies.updateStage(job.id, "validating_result");
    const report = validateReport(result.report, {
      config: job.config,
      ocr: checkpoint,
    });
    await this.dependencies.updateStage(job.id, "saving_result");
    await this.dependencies.saveResult(job, {
      report,
      annotations,
      ocrRevision: checkpoint.ocrRevision,
    });
  }
}
