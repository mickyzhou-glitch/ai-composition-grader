import { randomUUID } from "node:crypto";

import {
  isLegacyEvaluationReport,
  MAX_REVIEW_IMAGES,
  type AiReviewEnvelope,
  type AssignmentConfig,
} from "../domain/contracts";
import type {
  FeedbackSection,
  RewriteFeedbackInput,
  RewriteSampleInput,
} from "../ai/openai-review-adapter";
import type { VisionOcrResult } from "../ai/vision-ocr-adapter";
import type { SavedAssignmentRecord } from "../db/review-repository";
import type {
  ReviewRecord,
  ReviewRepository,
  TeacherReviewEdits,
  AnalysisToken,
  AnalysisJobCompletionClaim,
} from "../db/review-repository";
import type {
  OcrCheckpoint,
  OcrCheckpointV2,
  OcrParagraphTextEdit,
} from "../ocr/contracts";
import { analysisModeForCheckpoint } from "../ocr/analysis-mode";
import type { ReviewFileStore } from "../storage/review-file-store";
import type { RetentionService } from "../retention/retention-service";
import { InMemoryReviewLock, type ReviewLock } from "./review-lock";

export interface AiReviewer {
  analyze(input: {
    config: AssignmentConfig;
    imageDataUrls: string[];
    teacherGuidance?: string;
    studentName?: string;
  }): Promise<AiReviewEnvelope>;
  rewriteSample?(input: RewriteSampleInput): Promise<{ text: string }>;
  rewriteFeedback?(input: RewriteFeedbackInput): Promise<{ items: string[] }>;
  rewriteAllSamples?(input: Omit<RewriteSampleInput, "index">): Promise<{
    sampleParagraphs: Array<{ title: string; text: string; suggestion: string }>;
  }>;
}

export interface PreparedReviewAnalysis {
  token: AnalysisToken;
  config: AssignmentConfig;
  imageRevision: number;
  checkpoint: OcrCheckpoint | null;
  imageDataUrls: string[];
  studentName?: string;
}

/** Carries the durable review token when preparation fails after it began. */
export class ReviewPreparationError extends Error {
  constructor(
    readonly token: AnalysisToken,
    cause: unknown,
  ) {
    super("Failed to prepare review analysis");
    this.name = "ReviewPreparationError";
    this.cause = cause;
  }
}

interface ReviewServiceOptions {
  createId?: () => string;
  createRunId?: () => string;
  lock?: ReviewLock;
  retention?: Pick<RetentionService, "delete">;
}

export class ReviewServiceError extends Error {
  constructor(
    readonly code:
      | "REVIEW_NOT_FOUND"
      | "IMAGES_REQUIRED"
      | "INVALID_FILE_PATH"
      | "FILE_NOT_FOUND",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ReviewServiceError";
  }
}

export const reviewImageVariants = ["original", "annotation", "ai"] as const;
export type ReviewImageVariant = (typeof reviewImageVariants)[number];

export class ReviewService {
  private readonly createId: () => string;
  private readonly createRunId: () => string;
  private readonly lock: ReviewLock;
  private readonly recovery: Promise<void>;
  private readonly retention?: Pick<RetentionService, "delete">;

  constructor(
    private readonly repository: ReviewRepository,
    private readonly fileStore: ReviewFileStore,
    private readonly aiReviewer: AiReviewer,
    options: ReviewServiceOptions = {},
  ) {
    this.createId = options.createId ?? randomUUID;
    this.createRunId = options.createRunId ?? randomUUID;
    this.lock = options.lock ?? new InMemoryReviewLock();
    this.retention = options.retention;
    this.recovery = this.fileStore.recoverStagedDeletes(
      (_ownerId, id) => this.repository.exists(id),
    );
  }

  list(ownerId: string): ReviewRecord[] {
    return this.repository.list(ownerId);
  }

  listTeacherReviewQueue(ownerId: string): ReviewRecord[] {
    return this.repository.listTeacherReviewQueue(ownerId);
  }

  checkTeacherReviewedForExport(
    ownerId: string,
    entries: Array<{ id: string; revision: number }>,
  ): boolean {
    return this.repository.checkTeacherReviewedForExport(ownerId, entries);
  }

  get(ownerId: string, id: string): ReviewRecord {
    const review = this.repository.getById(ownerId, id);
    if (!review) throw new ReviewServiceError("REVIEW_NOT_FOUND", "批改记录不存在", 404);
    return review;
  }

  async readImageFile(
    ownerId: string,
    id: string,
    imageId: number,
    variant: ReviewImageVariant,
  ): Promise<{
    data: Buffer;
    contentType: string;
  }> {
    // PDF rendering holds the cross-process review lock while its authenticated
    // print page asks this service for the original image. Reading the immutable
    // image file must therefore not attempt to acquire that same lock again.
    const review = this.get(ownerId, id);
    const image = review.images.find((candidate) => candidate.id === imageId);
    if (!image) {
      throw new ReviewServiceError("FILE_NOT_FOUND", "图片不存在", 404);
    }
    const storedPath = image[`${variant}Path`];
    if (!/^images\/[^/\\\0]+$/.test(storedPath)) {
      throw new ReviewServiceError("INVALID_FILE_PATH", "图片路径无效", 400);
    }
    const extension = storedPath.split(".").at(-1)?.toLowerCase();
    const contentTypes: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      heic: "image/heic",
      heif: "image/heif",
    };
    const contentType = extension ? contentTypes[extension] : undefined;
    if (!contentType) {
      throw new ReviewServiceError("INVALID_FILE_PATH", "图片格式无效", 400);
    }
    try {
      return {
        data: await this.fileStore.readFile(
          ownerId,
          id,
          "images",
          storedPath.slice("images/".length),
        ),
        contentType,
      };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new ReviewServiceError("FILE_NOT_FOUND", "图片不存在", 404);
      }
      throw error;
    }
  }

  async create(
    ownerId: string,
    config: AssignmentConfig,
    studentName = "",
  ): Promise<ReviewRecord> {
    await this.recovery;
    const id = this.createId();
    return this.fileStore.withReviewLock(ownerId, id, async () => {
      await this.fileStore.createReview(ownerId, id);
      try {
        const review = this.repository.create(ownerId, { id, config, studentName });
        if (config.templateType === "custom") this.repository.saveCustomAssignment(ownerId, config);
        return review;
      } catch (error) {
        await this.fileStore.deleteReview(ownerId, id);
        throw error;
      }
    });
  }

  listSavedAssignments(ownerId: string): SavedAssignmentRecord[] {
    return this.repository.listSavedAssignments(ownerId);
  }

  async rewriteSample(
    ownerId: string,
    id: string,
    index: number,
    instruction?: string,
  ): Promise<{ text: string }> {
    const review = this.get(ownerId, id);
    if (!review.report) throw new ReviewServiceError("IMAGES_REQUIRED", "请先完成作文分析", 422);
    if (!isLegacyEvaluationReport(review.report)) {
      throw new ReviewServiceError("FILE_NOT_FOUND", "逐段批改报告不包含示范段落", 404);
    }
    if (!Number.isInteger(index) || index < 0 || index >= review.report.sampleParagraphs.length) {
      throw new ReviewServiceError("FILE_NOT_FOUND", "示范段落不存在", 404);
    }
    if (!this.aiReviewer.rewriteSample) {
      throw new Error("当前 AI 服务不支持示范段落重写");
    }
    return this.aiReviewer.rewriteSample({
      config: review.config,
      sampleParagraphs: review.report.sampleParagraphs,
      index,
      instruction,
    });
  }

  async rewriteFeedback(
    ownerId: string,
    id: string,
    section: FeedbackSection,
  ): Promise<{ items: string[] }> {
    const review = this.get(ownerId, id);
    if (!review.report) throw new ReviewServiceError("IMAGES_REQUIRED", "请先完成作文分析", 422);
    if (!this.aiReviewer.rewriteFeedback) {
      throw new Error("当前 AI 服务不支持评语重新生成");
    }
    return this.aiReviewer.rewriteFeedback({
      config: review.config,
      report: review.report,
      section,
    });
  }

  async rewriteAllSamples(
    ownerId: string,
    id: string,
    instruction?: string,
  ): Promise<{ sampleParagraphs: Array<{ title: string; text: string; suggestion: string }> }> {
    const review = this.get(ownerId, id);
    if (!review.report) throw new ReviewServiceError("IMAGES_REQUIRED", "请先完成作文分析", 422);
    if (!isLegacyEvaluationReport(review.report)) {
      throw new ReviewServiceError("FILE_NOT_FOUND", "逐段批改报告不包含示范段落", 404);
    }
    if (!this.aiReviewer.rewriteAllSamples) {
      throw new Error("当前 AI 服务不支持整篇示范文重写");
    }
    return this.aiReviewer.rewriteAllSamples({
      config: review.config,
      sampleParagraphs: review.report.sampleParagraphs,
      instruction,
    });
  }

  deleteSavedAssignment(ownerId: string, id: string): void {
    this.repository.deleteSavedAssignment(ownerId, id);
  }

  async update(ownerId: string, id: string, input: TeacherReviewEdits): Promise<ReviewRecord> {
    return this.lock.runExclusive(id, async () => {
      return this.fileStore.withReviewLock(ownerId, id, async () => {
        const current = this.get(ownerId, id);
        await this.fileStore.migrateLegacyReview(ownerId, id);
        const updated = this.repository.updateTeacherEdits(ownerId, id, input);
        if (current.pdfFilename) {
          await this.fileStore.queuePdfCleanup(ownerId, id, [current.pdfFilename]);
        }
        return updated;
      });
    });
  }

  async completeTeacherReview(
    ownerId: string,
    id: string,
    input: TeacherReviewEdits,
  ): Promise<ReviewRecord> {
    return this.lock.runExclusive(id, async () => {
      return this.fileStore.withReviewLock(ownerId, id, async () => {
        const current = this.get(ownerId, id);
        await this.fileStore.migrateLegacyReview(ownerId, id);
        const updated = this.repository.completeTeacherReview(ownerId, id, input);
        if (current.pdfFilename) {
          await this.fileStore.queuePdfCleanup(ownerId, id, [current.pdfFilename]);
        }
        return updated;
      });
    });
  }

  async delete(ownerId: string, id: string): Promise<void> {
    await this.recovery;
    if (this.retention) {
      await this.retention.delete(ownerId, id);
      return;
    }
    await this.lock.runExclusive(id, async () => {
      await this.fileStore.withReviewLock(ownerId, id, async () => {
        this.get(ownerId, id);
        await this.fileStore.migrateLegacyReview(ownerId, id);
        const staged = await this.fileStore.stageDelete(ownerId, id);
        try {
          this.repository.delete(ownerId, id);
        } catch (error) {
          await staged.rollback();
          throw error;
        }
        try {
          await staged.commit();
        } catch {
          // The DB deletion is authoritative; startup recovery retries trash cleanup.
        }
      });
    });
  }

  async analyze(ownerId: string, id: string): Promise<{
    review: ReviewRecord;
    pageWarnings: string[];
  }> {
    let prepared: PreparedReviewAnalysis;
    try {
      prepared = await this.prepareAnalysis(ownerId, id, "full", this.createRunId());
    } catch (error) {
      if (error instanceof ReviewPreparationError) {
        await this.failPreparedAnalysis(ownerId, id, error.token);
      }
      throw error;
    }
    let envelope: AiReviewEnvelope;
    try {
      envelope = await this.analyzePrepared(prepared);
    } catch (error) {
      await this.failPreparedAnalysis(ownerId, id, prepared.token);
      throw error;
    }
    try {
      const review = await this.savePreparedAnalysis(ownerId, id, prepared.token, envelope);
      return { review, pageWarnings: envelope.pageWarnings };
    } catch (error) {
      await this.failPreparedAnalysis(ownerId, id, prepared.token);
      throw error;
    }
  }

  /** Prepares local data under the review lock; no network model call happens here. */
  async prepareAnalysis(
    ownerId: string,
    id: string,
    mode: "full" | "content_only",
    run: string | AnalysisJobCompletionClaim,
  ): Promise<PreparedReviewAnalysis> {
    return this.prepareAnalysisInternal(ownerId, id, mode, run, false);
  }

  async prepareQueuedAnalysis(
    ownerId: string,
    id: string,
    mode: "full" | "content_only",
    claim: AnalysisJobCompletionClaim,
  ): Promise<PreparedReviewAnalysis> {
    return this.prepareAnalysisInternal(ownerId, id, mode, claim, true);
  }

  private async prepareAnalysisInternal(
    ownerId: string,
    id: string,
    mode: "full" | "content_only",
    run: string | AnalysisJobCompletionClaim,
    queued: boolean,
  ): Promise<PreparedReviewAnalysis> {
    await this.recovery;
    return this.lock.runExclusive(id, () => this.fileStore.withReviewLock(ownerId, id, async () => {
      const review = this.get(ownerId, id);
      if (review.images.length < 1 || review.images.length > MAX_REVIEW_IMAGES) {
        throw new ReviewServiceError(
          "IMAGES_REQUIRED",
          `请先上传 1 至 ${MAX_REVIEW_IMAGES} 张作文图片`,
          422,
        );
      }
      const token = typeof run === "string"
        ? this.repository.beginAnalysis(ownerId, id, run, review.revision)
        : queued
          ? this.repository.beginQueuedAnalysis(ownerId, id, run, review.revision)
          : this.repository.beginClaimedAnalysis(ownerId, id, run, review.revision);
      await this.fileStore.migrateLegacyReview(ownerId, id);
      if (review.pdfFilename) {
        await this.fileStore.queuePdfCleanup(ownerId, id, [review.pdfFilename]);
      }
      try {
        const source = this.repository.getAnalysisSource(ownerId, id);
        let checkpoint = source.checkpoint;
        const effectiveMode = analysisModeForCheckpoint(mode, checkpoint);
        if (effectiveMode === "full") checkpoint = null;
        const imageDataUrls = checkpoint ? [] : await Promise.all(
          review.images.map(async (image) => {
            const filename = image.aiPath.replace(/^images\//, "");
            const data = await this.fileStore.readFile(ownerId, id, "images", filename);
            return `data:image/jpeg;base64,${data.toString("base64")}`;
          }),
        );
        return {
          token,
          config: review.config,
          imageRevision: source.imageRevision,
          checkpoint,
          imageDataUrls,
          studentName: review.studentName || undefined,
        };
      } catch (error) {
        throw new ReviewPreparationError(token, error);
      }
    }));
  }

  async analyzePrepared(
    prepared: Pick<PreparedReviewAnalysis, "config" | "imageDataUrls" | "studentName"> & {
      teacherGuidance?: string;
    },
  ): Promise<AiReviewEnvelope> {
    return this.aiReviewer.analyze({
      config: prepared.config,
      imageDataUrls: prepared.imageDataUrls,
      teacherGuidance: prepared.teacherGuidance,
      studentName: prepared.studentName,
    });
  }

  async savePreparedAnalysis(
    ownerId: string,
    id: string,
    token: AnalysisToken,
    envelope: AiReviewEnvelope,
  ): Promise<ReviewRecord> {
    return this.lock.runExclusive(id, async () => this.repository.saveAnalysis(ownerId, id, token, envelope));
  }

  async savePreparedAnalysisAndCompleteJob(
    ownerId: string,
    id: string,
    token: AnalysisToken,
    envelope: AiReviewEnvelope,
    claim: AnalysisJobCompletionClaim,
    expectedOcrRevision?: number,
  ): Promise<ReviewRecord> {
    return this.lock.runExclusive(id, async () =>
      this.repository.saveAnalysisAndCompleteJob(
        ownerId,
        id,
        token,
        envelope,
        claim,
        expectedOcrRevision,
      ),
    );
  }

  async savePreparedOcr(
    ownerId: string,
    id: string,
    token: AnalysisToken,
    imageRevision: number,
    result: VisionOcrResult,
  ): Promise<OcrCheckpointV2> {
    return this.lock.runExclusive(id, async () =>
      this.repository.saveRecognizedOcr(ownerId, id, token, imageRevision, result),
    );
  }

  async editParagraphTexts(
    ownerId: string,
    id: string,
    expectedOcrRevision: number,
    edits: OcrParagraphTextEdit[],
  ): Promise<ReviewRecord> {
    return this.lock.runExclusive(id, async () => {
      this.repository.editParagraphTexts(ownerId, id, expectedOcrRevision, edits);
      return this.get(ownerId, id);
    });
  }

  async failPreparedAnalysis(ownerId: string, id: string, token: AnalysisToken): Promise<boolean> {
    return this.lock.runExclusive(id, async () => this.repository.failAnalysis(ownerId, id, token));
  }

  async failPreparedAnalysisAndFailJob(
    ownerId: string,
    id: string,
    token: AnalysisToken,
    claim: AnalysisJobCompletionClaim,
    errorCode: string,
  ): Promise<void> {
    return this.lock.runExclusive(id, async () =>
      this.repository.failAnalysisAndFailJob(ownerId, id, token, claim, errorCode),
    );
  }

  async finishQueuedAnalysisBeforeToken(
    ownerId: string,
    id: string,
    runId: string,
    claim: AnalysisJobCompletionClaim,
    target: "failed" | "canceled",
    errorCode: string,
  ): Promise<void> {
    return this.lock.runExclusive(id, async () =>
      this.repository.finishQueuedAnalysisBeforeToken(
        ownerId,
        id,
        runId,
        claim,
        target,
        errorCode,
      ),
    );
  }
}
