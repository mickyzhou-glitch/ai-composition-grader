import { and, desc, eq, isNull, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import { ZodError } from "zod";

import {
  annotationSchema,
  assignmentConfigSchema,
  reviewStatusSchema,
  type Annotation,
  type AiReviewEnvelope,
  type AssignmentConfig,
  type EvaluationReport,
  type NormalizedCrop,
  type ReviewStatus,
  EMPTY_DRAFT_RETENTION_MS,
  reviewExpiryAt,
} from "../domain/contracts";
import { validateReport } from "../domain/report-validation";
import type { AppDatabase } from "./client";
import { analysisJobs, annotations, reviewImages, reviews } from "./schema";

export interface ReviewImageInput {
  position: number;
  originalName: string;
  mimeType: string;
  originalPath: string;
  annotationPath: string;
  aiPath: string;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  crop: NormalizedCrop | null;
}

export interface ReviewImage extends ReviewImageInput {
  id: number;
  reviewId: string;
  createdAt: Date;
}

export interface ReviewRecord {
  id: string;
  ownerId: string;
  status: ReviewStatus;
  config: AssignmentConfig;
  report: EvaluationReport | null;
  revision: number;
  analysisRunId: string | null;
  pdfFilename: string | null;
  pdfPath: string | null;
  pdfRevision: number | null;
  exportedAt: Date | null;
  expiresAt?: Date | null;
  deletingAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  images: ReviewImage[];
  annotations: Annotation[];
}

export interface RetentionCandidate {
  id: string;
  ownerId: string;
  createdAt: Date;
  expiresAt: Date | null;
  deletingAt: Date | null;
  imageCount: number;
}

export interface CreateReviewInput {
  id: string;
  config: AssignmentConfig;
  status?: ReviewStatus;
  images?: ReviewImageInput[];
}

export interface TeacherReviewEdits {
  expectedRevision: number;
  config?: AssignmentConfig;
  report?: EvaluationReport;
  annotations?: Annotation[];
}

export interface AnalysisToken {
  revision: number;
  runId: string;
}

export interface ExportedPdfInput {
  pdfFilename: string;
  pdfPath: string;
  exportedAt: Date;
}

interface ReviewRepositoryOptions {
  now?: () => Date;
}

export class ReviewNotFoundError extends Error {
  readonly code = "NOT_FOUND";
  readonly status = 404;

  constructor(id: string) {
    super(`Review not found: ${id}`);
    this.name = "ReviewNotFoundError";
  }
}

export class CorruptReviewDataError extends Error {
  constructor(id: string, field: string) {
    super(`Corrupt review data in ${field} for review: ${id}`);
    this.name = "CorruptReviewDataError";
  }
}

export class AnalysisConflictError extends Error {
  readonly code = "ANALYSIS_CONFLICT";
  readonly status = 409;

  constructor(id: string) {
    super(`Analysis result is stale for review: ${id}`);
    this.name = "AnalysisConflictError";
  }
}

export class RevisionConflictError extends Error {
  readonly code = "REVISION_CONFLICT";
  readonly status = 409;

  constructor(id: string) {
    super(`Review revision is stale: ${id}`);
    this.name = "RevisionConflictError";
  }
}

function validateImage(image: ReviewImageInput): ReviewImageInput {
  if (!Number.isInteger(image.position) || image.position < 0) {
    throw new TypeError("image.position must be a non-negative integer");
  }
  for (const [field, value] of Object.entries({
    originalName: image.originalName,
    mimeType: image.mimeType,
    originalPath: image.originalPath,
    annotationPath: image.annotationPath,
    aiPath: image.aiPath,
  })) {
    if (value.trim().length === 0) throw new TypeError(`image.${field} must not be empty`);
  }
  if (!Number.isInteger(image.width) || image.width <= 0) {
    throw new TypeError("image.width must be a positive integer");
  }
  if (!Number.isInteger(image.height) || image.height <= 0) {
    throw new TypeError("image.height must be a positive integer");
  }
  if (![0, 90, 180, 270].includes(image.rotation)) {
    throw new TypeError("image.rotation must be 0, 90, 180, or 270");
  }
  return { ...image };
}

function validatePdfMetadata(input: ExportedPdfInput): ExportedPdfInput {
  if (!/^[^/\\\0]+\.pdf$/i.test(input.pdfFilename)) {
    throw new TypeError("pdfFilename must be a safe PDF filename");
  }
  if (input.pdfPath !== `pdf/${input.pdfFilename}`) {
    throw new TypeError("pdfPath must reference pdfFilename in the PDF directory");
  }
  if (Number.isNaN(input.exportedAt.valueOf())) {
    throw new TypeError("exportedAt must be a valid date");
  }
  return { ...input };
}

export class ReviewRepository {
  private readonly now: () => Date;

  constructor(
    private readonly database: AppDatabase,
    options: ReviewRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  create(ownerId: string, input: CreateReviewInput): ReviewRecord {
    const config = assignmentConfigSchema.parse(input.config);
    const status = reviewStatusSchema.parse(input.status ?? "draft");
    const images = (input.images ?? []).map(validateImage);
    const now = this.now();

    this.database.transaction((transaction) => {
      transaction.insert(reviews).values({
        id: input.id,
        ownerId,
        config,
        status,
        report: null,
        revision: 0,
        analysisRunId: null,
        pdfFilename: null,
        pdfPath: null,
        pdfRevision: null,
        exportedAt: null,
        expiresAt: images.length > 0 ? reviewExpiryAt(now) : null,
        deletingAt: null,
        createdAt: now,
        updatedAt: now,
      }).run();

      if (images.length > 0) {
        transaction.insert(reviewImages).values(
          images.map((image) => ({
            reviewId: input.id,
            pageIndex: image.position,
            path: image.annotationPath,
            ...image,
            createdAt: now,
          })),
        ).run();
      }
    });

    return this.requireById(ownerId, input.id);
  }

  createReview(ownerId: string, input: CreateReviewInput): ReviewRecord {
    return this.create(ownerId, input);
  }

  getById(ownerId: string, id: string): ReviewRecord | null {
    return this.database.transaction((database) => {
    const review = database
      .select({
        id: reviews.id,
        ownerId: reviews.ownerId,
        status: reviews.status,
        revision: reviews.revision,
        analysisRunId: reviews.analysisRunId,
        pdfFilename: reviews.pdfFilename,
        pdfPath: reviews.pdfPath,
        pdfRevision: reviews.pdfRevision,
        exportedAt: reviews.exportedAt,
        expiresAt: reviews.expiresAt,
        deletingAt: reviews.deletingAt,
        createdAt: reviews.createdAt,
        updatedAt: reviews.updatedAt,
      })
      .from(reviews)
      .where(and(eq(reviews.id, id), eq(reviews.ownerId, ownerId), isNull(reviews.deletingAt)))
      .get();

    if (!review) return null;

    let storedConfig: unknown;
    try {
      const configJson = database
        .select({ config: sql<string>`${reviews.config}` })
        .from(reviews)
        .where(and(eq(reviews.id, id), eq(reviews.ownerId, ownerId), isNull(reviews.deletingAt)))
        .get()?.config;
      storedConfig = configJson === undefined ? undefined : JSON.parse(configJson);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new CorruptReviewDataError(id, "config");
    }

    let config: AssignmentConfig;
    try {
      config = assignmentConfigSchema.parse(storedConfig);
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      throw new CorruptReviewDataError(id, "config");
    }
    let status: ReviewStatus;
    try {
      status = reviewStatusSchema.parse(review.status);
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      throw new CorruptReviewDataError(id, "status");
    }
    let report: EvaluationReport | null = null;
    let storedReport: unknown;
    try {
      const reportJson = database
        .select({ report: sql<string | null>`${reviews.report}` })
        .from(reviews)
        .where(and(eq(reviews.id, id), eq(reviews.ownerId, ownerId), isNull(reviews.deletingAt)))
        .get()?.report;
      storedReport =
        reportJson === null || reportJson === undefined
          ? reportJson
          : JSON.parse(reportJson);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new CorruptReviewDataError(id, "report");
    }
    if (storedReport !== null) {
      try {
        report = validateReport(storedReport, {
          templateType: config.templateType,
        });
      } catch {
        throw new CorruptReviewDataError(id, "report");
      }
    }

    const storedImages = database
      .select()
      .from(reviewImages)
      .where(eq(reviewImages.reviewId, id))
      .orderBy(reviewImages.position, reviewImages.id)
      .all();
    const images: ReviewImage[] = storedImages.map((image) => {
      if (![0, 90, 180, 270].includes(image.rotation)) {
        throw new CorruptReviewDataError(id, "images.rotation");
      }
      return {
        id: image.id,
        reviewId: image.reviewId,
        position: image.position,
        originalName: image.originalName,
        mimeType: image.mimeType,
        originalPath: image.originalPath,
        annotationPath: image.annotationPath,
        aiPath: image.aiPath,
        width: image.width,
        height: image.height,
        rotation: image.rotation as ReviewImageInput["rotation"],
        crop: image.crop,
        createdAt: image.createdAt,
      };
    });
    const storedAnnotations = database
      .select()
      .from(annotations)
      .where(eq(annotations.reviewId, id))
      .orderBy(annotations.position)
      .all();

    return {
      ...review,
      config,
      status,
      report,
      images,
      annotations: storedAnnotations.map((annotation) => ({
        pageIndex: annotation.pageIndex,
        x: annotation.x,
        y: annotation.y,
        category: annotation.category,
        anchorText: annotation.anchorText,
        comment: annotation.comment,
        isHighlight: annotation.isHighlight,
      })),
    };
    });
  }

  getReview(ownerId: string, id: string): ReviewRecord | null {
    return this.getById(ownerId, id);
  }

  list(ownerId: string): ReviewRecord[] {
    return this.database
      .select({ id: reviews.id })
      .from(reviews)
      .where(and(eq(reviews.ownerId, ownerId), isNull(reviews.deletingAt)))
      .orderBy(desc(reviews.updatedAt), desc(reviews.createdAt))
      .all()
      .map(({ id }) => this.requireById(ownerId, id));
  }

  listReviews(ownerId: string): ReviewRecord[] {
    return this.list(ownerId);
  }

  updateReport(
    ownerId: string,
    id: string,
    input: EvaluationReport,
    options: { incompleteEvent?: boolean } = {},
  ): ReviewRecord {
    const review = this.requireById(ownerId, id);
    const report = validateReport(input, {
      templateType: review.config.templateType,
      incompleteEvent: options.incompleteEvent,
    });
    this.database
      .update(reviews)
      .set({
        report,
        status: "ready_for_review",
        updatedAt: this.now(),
        revision: sql`${reviews.revision} + 1`,
        pdfFilename: null,
        pdfPath: null,
        pdfRevision: null,
        exportedAt: null,
      })
      .where(and(eq(reviews.id, id), eq(reviews.ownerId, ownerId), isNull(reviews.deletingAt)))
      .run();
    return this.requireById(ownerId, id);
  }

  updateStatus(ownerId: string, id: string, input: ReviewStatus): ReviewRecord {
    this.requireById(ownerId, id);
    const status = reviewStatusSchema.parse(input);
    this.database
      .update(reviews)
      .set({ status, updatedAt: this.now() })
      .where(and(eq(reviews.id, id), eq(reviews.ownerId, ownerId), isNull(reviews.deletingAt)))
      .run();
    return this.requireById(ownerId, id);
  }

  updateConfig(ownerId: string, id: string, input: AssignmentConfig): ReviewRecord {
    const config = assignmentConfigSchema.parse(input);
    const updatedAt = this.now();
    this.database.transaction((transaction) => {
      const current = transaction
        .select({ id: reviews.id })
        .from(reviews)
        .where(and(eq(reviews.id, id), eq(reviews.ownerId, ownerId), isNull(reviews.deletingAt)))
        .get();
      if (!current) throw new ReviewNotFoundError(id);

      transaction
        .update(reviews)
        .set({
          config,
          report: null,
          status: "draft",
          updatedAt,
          revision: sql`${reviews.revision} + 1`,
          analysisRunId: null,
          pdfFilename: null,
          pdfPath: null,
          pdfRevision: null,
          exportedAt: null,
        })
        .where(and(eq(reviews.id, id), eq(reviews.ownerId, ownerId), isNull(reviews.deletingAt)))
        .run();
      transaction.delete(annotations).where(eq(annotations.reviewId, id)).run();
    });
    return this.requireById(ownerId, id);
  }

  updateTeacherEdits(ownerId: string, id: string, input: TeacherReviewEdits): ReviewRecord {
    const current = this.requireById(ownerId, id);
    const config = input.config
      ? assignmentConfigSchema.parse(input.config)
      : current.config;
    const report =
      input.report !== undefined
        ? validateReport(input.report, { templateType: config.templateType })
        : input.config !== undefined
          ? null
          : current.report;
    const savedAnnotations =
      input.annotations !== undefined
        ? input.annotations.map((annotation) => annotationSchema.parse(annotation))
        : input.config !== undefined
          ? []
          : current.annotations;
    const status =
      input.config !== undefined
          ? "draft"
        : input.report !== undefined || input.annotations !== undefined
          ? report === null
            ? "draft"
            : "ready_for_review"
          : current.status === "analyzing"
            ? report === null
              ? "draft"
              : "ready_for_review"
          : current.status;
    const now = this.now();

    this.database.transaction((transaction) => {
      const update = transaction
        .update(reviews)
        .set({
          config,
          report,
          status,
          updatedAt: now,
          revision: sql`${reviews.revision} + 1`,
          analysisRunId: null,
          pdfFilename: null,
          pdfPath: null,
          pdfRevision: null,
          exportedAt: null,
        })
        .where(and(eq(reviews.id, id), eq(reviews.ownerId, ownerId), isNull(reviews.deletingAt), eq(reviews.revision, input.expectedRevision)))
        .run();
      if (update.changes === 0) {
        const exists = transaction
          .select({ id: reviews.id })
          .from(reviews)
          .where(and(eq(reviews.id, id), eq(reviews.ownerId, ownerId), isNull(reviews.deletingAt)))
          .get();
        if (!exists) throw new ReviewNotFoundError(id);
        throw new RevisionConflictError(id);
      }
      transaction.delete(annotations).where(eq(annotations.reviewId, id)).run();
      if (savedAnnotations.length > 0) {
        transaction.insert(annotations).values(
          savedAnnotations.map((annotation, position) => ({
            reviewId: id,
            position,
            ...annotation,
          })),
        ).run();
      }
    });
    return this.requireById(ownerId, id);
  }

  replaceImages(
    ownerId: string,
    id: string,
    expectedRevision: number,
    input: ReviewImageInput[],
  ): ReviewRecord {
    const images = input.map(validateImage);
    const now = this.now();
    this.database.transaction((transaction) => {
      const updateValues: Record<string, unknown> = {
        updatedAt: now,
        status: "draft",
        report: null,
        revision: sql`${reviews.revision} + 1`,
        analysisRunId: null,
        pdfFilename: null,
        pdfPath: null,
        pdfRevision: null,
        exportedAt: null,
      };
      if (images.length > 0) {
        updateValues.expiresAt = sql`coalesce(${reviews.expiresAt}, ${reviewExpiryAt(now).valueOf()})`;
      }
      const update = transaction
        .update(reviews)
        .set(updateValues)
        .where(and(eq(reviews.id, id), eq(reviews.ownerId, ownerId), isNull(reviews.deletingAt), eq(reviews.revision, expectedRevision)))
        .run();
      if (update.changes === 0) {
        const exists = transaction
          .select({ id: reviews.id })
          .from(reviews)
          .where(and(eq(reviews.id, id), eq(reviews.ownerId, ownerId), isNull(reviews.deletingAt)))
          .get();
        if (!exists) throw new ReviewNotFoundError(id);
        throw new RevisionConflictError(id);
      }
      transaction.delete(reviewImages).where(eq(reviewImages.reviewId, id)).run();
      transaction.delete(annotations).where(eq(annotations.reviewId, id)).run();
      if (images.length > 0) {
        transaction.insert(reviewImages).values(
          images.map((image) => ({
            reviewId: id,
            pageIndex: image.position,
            path: image.annotationPath,
            ...image,
            createdAt: now,
          })),
        ).run();
      }
    });
    return this.requireById(ownerId, id);
  }

  beginAnalysis(
    ownerId: string,
    id: string,
    runId: string,
    expectedRevision: number,
  ): AnalysisToken {
    const result = this.database
      .update(reviews)
      .set({
        status: "analyzing",
        analysisRunId: runId,
        updatedAt: this.now(),
        pdfFilename: null,
        pdfPath: null,
        pdfRevision: null,
        exportedAt: null,
      })
      .where(
        and(
          eq(reviews.id, id),
          eq(reviews.ownerId, ownerId),
          isNull(reviews.deletingAt),
          eq(reviews.revision, expectedRevision),
        ),
      )
      .run();
    if (result.changes === 0) {
      if (!this.getById(ownerId, id)) throw new ReviewNotFoundError(id);
      throw new AnalysisConflictError(id);
    }
    return { revision: expectedRevision, runId };
  }

  saveAnalysis(
    ownerId: string,
    id: string,
    token: AnalysisToken,
    input: AiReviewEnvelope,
  ): ReviewRecord {
    const review = this.requireById(ownerId, id);
    const parsedAnnotations = input.annotations.map((annotation) =>
      annotationSchema.parse(annotation),
    );
    const report = input.readable
      ? validateReport(input.report, { templateType: review.config.templateType })
      : null;
    const status = input.readable ? "ready_for_review" : "needs_better_images";
    const savedAnnotations = input.readable ? parsedAnnotations : [];
    const now = this.now();

    this.database.transaction((transaction) => {
      const update = transaction
        .update(reviews)
        .set({
          report,
          status,
          updatedAt: now,
          analysisRunId: null,
          revision: sql`${reviews.revision} + 1`,
          pdfFilename: null,
          pdfPath: null,
          pdfRevision: null,
          exportedAt: null,
        })
        .where(
          and(
            eq(reviews.id, id),
            eq(reviews.ownerId, ownerId),
            isNull(reviews.deletingAt),
            eq(reviews.revision, token.revision),
            eq(reviews.analysisRunId, token.runId),
          ),
        )
        .run();
      if (update.changes === 0) throw new AnalysisConflictError(id);
      transaction.delete(annotations).where(eq(annotations.reviewId, id)).run();
      if (savedAnnotations.length > 0) {
        transaction.insert(annotations).values(
          savedAnnotations.map((annotation, position) => ({
            reviewId: id,
            position,
            ...annotation,
          })),
        ).run();
      }
    });
    return this.requireById(ownerId, id);
  }

  failAnalysis(ownerId: string, id: string, token: AnalysisToken): boolean {
    return (
      this.database
        .update(reviews)
        .set({ status: "failed", updatedAt: this.now(), analysisRunId: null })
        .where(
          and(
            eq(reviews.id, id),
            eq(reviews.ownerId, ownerId),
            isNull(reviews.deletingAt),
            eq(reviews.revision, token.revision),
            eq(reviews.analysisRunId, token.runId),
          ),
        )
        .run().changes > 0
    );
  }

  replaceAnnotations(ownerId: string, id: string, input: Annotation[]): Annotation[] {
    const current = this.requireById(ownerId, id);
    const parsed = input.map((annotation) => annotationSchema.parse(annotation));
    const now = this.now();
    this.database.transaction((transaction) => {
      transaction.delete(annotations).where(eq(annotations.reviewId, id)).run();
      if (parsed.length > 0) {
        transaction.insert(annotations).values(
          parsed.map((annotation, position) => ({
            reviewId: id,
            position,
            ...annotation,
          })),
        ).run();
      }
      transaction
        .update(reviews)
        .set({
          status: current.report === null ? "draft" : "ready_for_review",
          updatedAt: now,
          revision: sql`${reviews.revision} + 1`,
          pdfFilename: null,
          pdfPath: null,
          pdfRevision: null,
          exportedAt: null,
        })
        .where(and(eq(reviews.id, id), eq(reviews.ownerId, ownerId), isNull(reviews.deletingAt)))
        .run();
    });
    return this.requireById(ownerId, id).annotations;
  }

  markExported(
    ownerId: string,
    id: string,
    expectedRevision: number,
    input: ExportedPdfInput,
  ): ReviewRecord {
    const pdf = validatePdfMetadata(input);
    const nextRevision = expectedRevision + 1;
    const result = this.database
      .update(reviews)
      .set({
        status: "exported",
        revision: nextRevision,
        pdfFilename: pdf.pdfFilename,
        pdfPath: pdf.pdfPath,
        pdfRevision: nextRevision,
        exportedAt: pdf.exportedAt,
        updatedAt: pdf.exportedAt,
      })
      .where(and(eq(reviews.id, id), eq(reviews.ownerId, ownerId), isNull(reviews.deletingAt), eq(reviews.revision, expectedRevision)))
      .run();
    if (result.changes === 0) {
      if (!this.getById(ownerId, id)) throw new ReviewNotFoundError(id);
      throw new RevisionConflictError(id);
    }
    return this.requireById(ownerId, id);
  }

  delete(ownerId: string, id: string): boolean {
    const result = this.database
      .delete(reviews)
      .where(and(eq(reviews.id, id), eq(reviews.ownerId, ownerId), isNull(reviews.deletingAt)))
      .run();
    if (result.changes === 0) throw new ReviewNotFoundError(id);
    return true;
  }

  deleteReview(ownerId: string, id: string): boolean {
    return this.delete(ownerId, id);
  }

  /** 列出到期作文、24 小时未上传图片的草稿以及上次运行已标记的作文。 */
  listRetentionCandidates(now = this.now()): RetentionCandidate[] {
    if (Number.isNaN(now.valueOf())) throw new TypeError("now must be a valid date");
    const emptyDraftBefore = new Date(now.valueOf() - EMPTY_DRAFT_RETENTION_MS);
    return this.database
      .select({
        id: reviews.id,
        ownerId: reviews.ownerId,
        createdAt: reviews.createdAt,
        expiresAt: reviews.expiresAt,
        deletingAt: reviews.deletingAt,
        imageCount: sql<number>`(
          SELECT count(*) FROM review_images
          WHERE review_images.review_id = ${reviews.id}
        )`,
      })
      .from(reviews)
      .where(
        or(
          isNotNull(reviews.deletingAt),
          lte(reviews.expiresAt, now),
          and(
            isNull(reviews.expiresAt),
            lt(reviews.createdAt, emptyDraftBefore),
            sql`NOT EXISTS (
              SELECT 1 FROM review_images
              WHERE review_images.review_id = ${reviews.id}
            )`,
          ),
        ),
      )
      .orderBy(reviews.createdAt)
      .all()
      .map((candidate) => ({
        ...candidate,
        imageCount: Number(candidate.imageCount),
      }));
  }

  /** 原子地把一个候选作文置于删除中；已置于删除中的作文可重复认领。 */
  markDeleting(
    ownerId: string,
    id: string,
    now = this.now(),
    options: { force?: boolean } = {},
  ): boolean {
    if (Number.isNaN(now.valueOf())) throw new TypeError("now must be a valid date");
    const emptyDraftBefore = new Date(now.valueOf() - EMPTY_DRAFT_RETENTION_MS);
    return this.database
      .update(reviews)
      .set({ deletingAt: sql`coalesce(${reviews.deletingAt}, ${now.valueOf()})`, updatedAt: now })
      .where(
        and(
          eq(reviews.id, id),
          eq(reviews.ownerId, ownerId),
          options.force
            ? sql`1 = 1`
            : or(
                isNotNull(reviews.deletingAt),
                lte(reviews.expiresAt, now),
                and(
                  isNull(reviews.expiresAt),
                  lt(reviews.createdAt, emptyDraftBefore),
                  sql`NOT EXISTS (
                    SELECT 1 FROM review_images
                    WHERE review_images.review_id = ${reviews.id}
                  )`,
                ),
              ),
        ),
      )
      .run().changes > 0;
  }

  /** 取消该作文尚未完成的持久化分析任务。 */
  cancelActiveAnalysis(ownerId: string, id: string, now = this.now()): number {
    return this.database
      .update(analysisJobs)
      .set({
        status: "canceled",
        errorCode: "REVIEW_DELETED",
        message: null,
        leaseExpiresAt: null,
        finishedAt: now,
      })
      .where(
        and(
          eq(analysisJobs.ownerId, ownerId),
          eq(analysisJobs.reviewId, id),
          sql`${analysisJobs.status} IN ('queued', 'running')`,
        ),
      )
      .run().changes;
  }

  /** 文件清理成功后的最后数据库收尾，所有从属表在同一事务中删除。 */
  finalizeDeletion(ownerId: string, id: string): boolean {
    return this.database.transaction((transaction) => {
      const deleting = transaction
        .select({ id: reviews.id })
        .from(reviews)
        .where(and(eq(reviews.id, id), eq(reviews.ownerId, ownerId), isNotNull(reviews.deletingAt)))
        .get();
      if (!deleting) return false;
      transaction.delete(annotations).where(eq(annotations.reviewId, id)).run();
      transaction.delete(reviewImages).where(eq(reviewImages.reviewId, id)).run();
      transaction.delete(analysisJobs).where(
        and(eq(analysisJobs.reviewId, id), eq(analysisJobs.ownerId, ownerId)),
      ).run();
      return transaction.delete(reviews)
        .where(and(eq(reviews.id, id), eq(reviews.ownerId, ownerId), isNotNull(reviews.deletingAt)))
        .run().changes > 0;
    });
  }

  /** 保留期状态机用：即使已标记删除也确认该 owner 的记录是否仍存在。 */
  existsOwned(ownerId: string, id: string): boolean {
    return this.database
      .select({ id: reviews.id })
      .from(reviews)
      .where(and(eq(reviews.id, id), eq(reviews.ownerId, ownerId)))
      .get() !== undefined;
  }

  /** Internal cleanup probe; never exposed to request handlers. */
  exists(id: string): boolean {
    return this.database
      .select({ id: reviews.id })
      .from(reviews)
      .where(and(eq(reviews.id, id), isNull(reviews.deletingAt)))
      .get() !== undefined;
  }

  private requireById(ownerId: string, id: string): ReviewRecord {
    const review = this.getById(ownerId, id);
    if (!review) throw new ReviewNotFoundError(id);
    return review;
  }
}
