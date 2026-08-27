import { and, asc, desc, eq, gt, inArray, isNull, isNotNull, lt, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";

import type { VisionOcrResult } from "../ai/vision-ocr-adapter";
import {
  annotationSchema,
  assignmentConfigSchema,
  evaluationReportSchema,
  reviewStatusSchema,
  studentNameSchema,
  type Annotation,
  type AiReviewEnvelope,
  type AssignmentConfig,
  type EvaluationReport,
  type NormalizedCrop,
  type PrivacyUploadConsent,
  type ReviewStatus,
  EMPTY_DRAFT_RETENTION_MS,
} from "../domain/contracts";
import { validateReport } from "../domain/report-validation";
import { encodeOrdinaryBoundMarker } from "../jobs/analysis-job-metadata";
import {
  createOcrCheckpointV2,
  editOcrParagraphTexts,
  OcrCheckpointError,
  ocrCheckpointSchema,
  publicOcrView,
  type OcrCheckpoint,
  type OcrCheckpointV2,
  type OcrParagraphTextEdit,
  type PublicOcrView,
} from "../ocr/contracts";
import type { AppDatabase } from "./client";
import { analysisJobs, annotations, reviewImages, reviews, savedAssignments } from "./schema";

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
  studentName: string;
  config: AssignmentConfig;
  report: EvaluationReport | null;
  revision: number;
  analysisRunId: string | null;
  pdfFilename: string | null;
  pdfPath: string | null;
  pdfRevision: number | null;
  exportedAt: Date | null;
  teacherReviewedAt: Date | null;
  expiresAt?: Date | null;
  deletingAt?: Date | null;
  privacyConsentVersion?: string | null;
  privacyConsentedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  images: ReviewImage[];
  annotations: Annotation[];
  ocr: PublicOcrView | null;
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
  studentName?: string;
  config: AssignmentConfig;
  status?: ReviewStatus;
  images?: ReviewImageInput[];
}

export interface TeacherReviewEdits {
  expectedRevision: number;
  studentName?: string;
  config?: AssignmentConfig;
  report?: EvaluationReport;
  annotations?: Annotation[];
}

export interface ReplaceImagesOptions {
  privacyConsent?: PrivacyUploadConsent;
}

export interface AnalysisToken {
  revision: number;
  runId: string;
}

export interface AnalysisJobCompletionClaim {
  id: string;
  attempt: number;
  leaseExpiresAt: Date;
}

export interface ExportedPdfInput {
  pdfFilename: string;
  pdfPath: string;
  exportedAt: Date;
}

export interface SavedAssignmentRecord {
  id: string;
  ownerId: string;
  config: AssignmentConfig;
  createdAt: Date;
  updatedAt: Date;
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

export class AnalysisJobCompletionClaimLostError extends Error {
  readonly code = "JOB_CLAIM_LOST";

  constructor(id: string) {
    super(`Analysis job claim was lost: ${id}`);
    this.name = "AnalysisJobCompletionClaimLostError";
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
    const studentName = studentNameSchema.parse(input.studentName ?? "");
    const status = reviewStatusSchema.parse(input.status ?? "draft");
    const images = (input.images ?? []).map(validateImage);
    const now = this.now();

    this.database.transaction((transaction) => {
      transaction.insert(reviews).values({
        id: input.id,
        ownerId,
        studentName,
        config,
        status,
        report: null,
        revision: 0,
        imageRevision: 0,
        ocrCheckpoint: null,
        reportOcrRevision: null,
        analysisRunId: null,
        pdfFilename: null,
        pdfPath: null,
        pdfRevision: null,
        exportedAt: null,
        expiresAt: null,
        deletingAt: null,
        privacyConsentVersion: null,
        privacyConsentedAt: null,
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

  listSavedAssignments(ownerId: string): SavedAssignmentRecord[] {
    return this.database
      .select()
      .from(savedAssignments)
      .where(eq(savedAssignments.ownerId, ownerId))
      .orderBy(desc(savedAssignments.updatedAt))
      .all()
      .map((assignment) => ({
        ...assignment,
        config: assignmentConfigSchema.parse(assignment.config),
      }));
  }

  saveCustomAssignment(ownerId: string, input: AssignmentConfig): SavedAssignmentRecord {
    const config = assignmentConfigSchema.parse(input);
    if (config.templateType !== "custom") throw new TypeError("only custom assignments can be saved");
    const now = this.now();
    const title = config.title.trim();
    this.database
      .insert(savedAssignments)
      .values({ id: randomUUID(), ownerId, title, config: { ...config, title }, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [savedAssignments.ownerId, savedAssignments.title],
        set: { config: { ...config, title }, updatedAt: now },
      })
      .run();
    const assignment = this.database
      .select()
      .from(savedAssignments)
      .where(and(eq(savedAssignments.ownerId, ownerId), eq(savedAssignments.title, title)))
      .get();
    if (!assignment) throw new Error("saved assignment was not found after saving");
    return { ...assignment, config: assignmentConfigSchema.parse(assignment.config) };
  }

  deleteSavedAssignment(ownerId: string, id: string): void {
    const result = this.database
      .delete(savedAssignments)
      .where(and(eq(savedAssignments.ownerId, ownerId), eq(savedAssignments.id, id)))
      .run();
    if (result.changes === 0) throw new ReviewNotFoundError(id);
  }

  getById(ownerId: string, id: string): ReviewRecord | null {
    return this.database.transaction((database) => {
    const review = database
      .select({
        id: reviews.id,
        ownerId: reviews.ownerId,
        status: reviews.status,
        studentName: reviews.studentName,
        revision: reviews.revision,
        imageRevision: reviews.imageRevision,
        ocrCheckpoint: reviews.ocrCheckpoint,
        analysisRunId: reviews.analysisRunId,
        pdfFilename: reviews.pdfFilename,
        pdfPath: reviews.pdfPath,
        pdfRevision: reviews.pdfRevision,
        exportedAt: reviews.exportedAt,
        teacherReviewedAt: reviews.teacherReviewedAt,
        expiresAt: reviews.expiresAt,
        deletingAt: reviews.deletingAt,
        privacyConsentVersion: reviews.privacyConsentVersion,
        privacyConsentedAt: reviews.privacyConsentedAt,
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
        const parsedReport = evaluationReportSchema.parse(storedReport);
        // Coverage against the current OCR checkpoint is enforced on write.
        // A detail read may legitimately happen before that checkpoint is
        // hydrated, so keep a structurally valid v2 report readable here.
        report = "version" in parsedReport
          ? parsedReport
          : validateReport(parsedReport, { templateType: config.templateType });
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

    let ocr: PublicOcrView | null = null;
    if (review.ocrCheckpoint !== null) {
      try {
        const checkpoint = ocrCheckpointSchema.parse(review.ocrCheckpoint);
        if (checkpoint.sourceRevision === review.imageRevision) {
          ocr = publicOcrView(checkpoint);
        }
      } catch {
        throw new CorruptReviewDataError(id, "ocrCheckpoint");
      }
    }
    const { imageRevision: _imageRevision, ocrCheckpoint: _ocrCheckpoint, ...safeReview } = review;
    void _imageRevision;
    void _ocrCheckpoint;

    return {
      ...safeReview,
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
      ocr,
    };
    });
  }

  getReview(ownerId: string, id: string): ReviewRecord | null {
    return this.getById(ownerId, id);
  }

  getAnalysisSource(ownerId: string, id: string): {
    imageRevision: number;
    checkpoint: OcrCheckpoint | null;
  } {
    const row = this.database.select({
      imageRevision: reviews.imageRevision,
      ocrCheckpoint: reviews.ocrCheckpoint,
    }).from(reviews).where(and(
      eq(reviews.id, id),
      eq(reviews.ownerId, ownerId),
      isNull(reviews.deletingAt),
    )).get();
    if (!row) throw new ReviewNotFoundError(id);
    if (row.ocrCheckpoint === null) {
      return { imageRevision: row.imageRevision, checkpoint: null };
    }
    try {
      const checkpoint = ocrCheckpointSchema.parse(row.ocrCheckpoint);
      return {
        imageRevision: row.imageRevision,
        checkpoint: checkpoint.sourceRevision === row.imageRevision ? checkpoint : null,
      };
    } catch {
      throw new CorruptReviewDataError(id, "ocrCheckpoint");
    }
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

  listTeacherReviewQueue(ownerId: string): ReviewRecord[] {
    return this.database
      .select({ id: reviews.id })
      .from(reviews)
      .where(and(
        eq(reviews.ownerId, ownerId),
        isNull(reviews.deletingAt),
        isNull(reviews.teacherReviewedAt),
        isNotNull(reviews.report),
        inArray(reviews.status, ["ready_for_review", "exported"]),
        or(
          isNull(reviews.ocrCheckpoint),
          sql`${reviews.reportOcrRevision} = json_extract(${reviews.ocrCheckpoint}, '$.ocrRevision')`,
        ),
      ))
      .orderBy(asc(reviews.createdAt), asc(reviews.id))
      .all()
      .map(({ id }) => this.requireById(ownerId, id));
  }

  checkTeacherReviewedForExport(
    ownerId: string,
    entries: Array<{ id: string; revision: number }>,
  ): boolean {
    if (entries.length === 0) return false;
    const eligible = this.database
      .select({ id: reviews.id, revision: reviews.revision })
      .from(reviews)
      .where(and(
        eq(reviews.ownerId, ownerId),
        isNull(reviews.deletingAt),
        isNotNull(reviews.teacherReviewedAt),
        isNotNull(reviews.report),
        inArray(reviews.status, ["ready_for_review", "exported"]),
        or(
          isNull(reviews.ocrCheckpoint),
          sql`${reviews.reportOcrRevision} = json_extract(${reviews.ocrCheckpoint}, '$.ocrRevision')`,
        ),
        or(...entries.map(({ id, revision }) => and(
          eq(reviews.id, id),
          eq(reviews.revision, revision),
        ))),
      ))
      .all();
    const keys = new Set(eligible.map(({ id, revision }) => `${id}:${revision}`));
    return keys.size === entries.length
      && entries.every(({ id, revision }) => keys.has(`${id}:${revision}`));
  }

  updateReport(
    ownerId: string,
    id: string,
    input: EvaluationReport,
    options: { incompleteEvent?: boolean } = {},
  ): ReviewRecord {
    const review = this.requireById(ownerId, id);
    const report = validateReport(input, {
      config: review.config,
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
          teacherReviewedAt: null,
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
    return this.saveTeacherEdits(ownerId, id, input, false);
  }

  completeTeacherReview(ownerId: string, id: string, input: TeacherReviewEdits): ReviewRecord {
    return this.saveTeacherEdits(ownerId, id, input, true);
  }

  private saveTeacherEdits(
    ownerId: string,
    id: string,
    input: TeacherReviewEdits,
    markReviewed: boolean,
  ): ReviewRecord {
    const current = this.requireById(ownerId, id);
    if (current.revision !== input.expectedRevision) {
      throw new RevisionConflictError(id);
    }
    const studentName =
      input.studentName !== undefined
        ? studentNameSchema.parse(input.studentName)
        : current.studentName;
    const config = input.config
      ? assignmentConfigSchema.parse(input.config)
      : current.config;
    const report =
      input.report !== undefined
        ? markReviewed
          ? validateReport(input.report, { config })
          : validateReport(input.report, { templateType: config.templateType })
        : input.config !== undefined
          ? null
          : current.report;
    if (markReviewed && report === null) {
      throw new TypeError("teacher review requires a report");
    }
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
          studentName,
          config,
          report,
          status,
          updatedAt: now,
          revision: sql`${reviews.revision} + 1`,
          analysisRunId: null,
          teacherReviewedAt: markReviewed
            ? now
            : input.config !== undefined
              ? null
              : undefined,
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
    options: ReplaceImagesOptions = {},
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
        imageRevision: sql`${reviews.imageRevision} + 1`,
        ocrCheckpoint: null,
        reportOcrRevision: null,
        teacherReviewedAt: null,
        pdfFilename: null,
        pdfPath: null,
        pdfRevision: null,
        exportedAt: null,
      };
      if (images.length > 0) {
        if (options.privacyConsent) {
          updateValues.privacyConsentVersion = sql`coalesce(${reviews.privacyConsentVersion}, ${options.privacyConsent.version})`;
          updateValues.privacyConsentedAt = sql`coalesce(${reviews.privacyConsentedAt}, ${now.valueOf()})`;
        }
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
    const result = this.database.update(reviews).set({
      status: "analyzing",
      analysisRunId: runId,
      teacherReviewedAt: null,
      updatedAt: this.now(),
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
    }).where(and(
      eq(reviews.id, id),
      eq(reviews.ownerId, ownerId),
      isNull(reviews.deletingAt),
      eq(reviews.revision, expectedRevision),
    )).run();
    if (result.changes === 0) {
      if (!this.getById(ownerId, id)) throw new ReviewNotFoundError(id);
      throw new AnalysisConflictError(id);
    }
    return { revision: expectedRevision, runId };
  }

  beginClaimedAnalysis(
    ownerId: string,
    id: string,
    claim: AnalysisJobCompletionClaim,
    expectedRevision: number,
  ): AnalysisToken {
    const normalizedClaim = this.normalizeAnalysisJobClaim(claim);
    const now = this.now();
    return this.database.transaction((transaction) => {
      const jobUpdate = transaction.update(analysisJobs).set({
        message: encodeOrdinaryBoundMarker(),
      }).where(and(
        eq(analysisJobs.id, normalizedClaim.id),
        eq(analysisJobs.ownerId, ownerId),
        eq(analysisJobs.reviewId, id),
        eq(analysisJobs.status, "running"),
        eq(analysisJobs.attempt, normalizedClaim.attempt),
        eq(analysisJobs.leaseExpiresAt, normalizedClaim.leaseExpiresAt),
        gt(analysisJobs.leaseExpiresAt, now),
      )).run();
      if (jobUpdate.changes !== 1) {
        throw new AnalysisJobCompletionClaimLostError(normalizedClaim.id);
      }
      const reviewUpdate = transaction.update(reviews).set({
        status: "analyzing",
        analysisRunId: normalizedClaim.id,
        teacherReviewedAt: null,
        updatedAt: now,
        pdfFilename: null,
        pdfPath: null,
        pdfRevision: null,
        exportedAt: null,
      }).where(and(
        eq(reviews.id, id),
        eq(reviews.ownerId, ownerId),
        isNull(reviews.deletingAt),
        eq(reviews.revision, expectedRevision),
        isNull(reviews.analysisRunId),
        inArray(reviews.status, [
          "draft",
          "needs_better_images",
          "ready_for_review",
          "exported",
          "failed",
        ]),
      )).run();
      if (reviewUpdate.changes === 0) {
        const exists = transaction.select({ id: reviews.id }).from(reviews).where(and(
          eq(reviews.id, id),
          eq(reviews.ownerId, ownerId),
          isNull(reviews.deletingAt),
        )).get();
        if (!exists) throw new ReviewNotFoundError(id);
        throw new AnalysisConflictError(id);
      }
      return { revision: expectedRevision, runId: normalizedClaim.id };
    });
  }

  beginQueuedAnalysis(
    ownerId: string,
    id: string,
    claim: AnalysisJobCompletionClaim,
    expectedRevision: number,
  ): AnalysisToken {
    const normalizedClaim = this.normalizeAnalysisJobClaim(claim);
    const now = this.now();
    return this.database.transaction((transaction) => {
      const jobUpdate = transaction.update(analysisJobs).set({
        message: sql`${analysisJobs.message}`,
      }).where(and(
        eq(analysisJobs.id, normalizedClaim.id),
        eq(analysisJobs.ownerId, ownerId),
        eq(analysisJobs.reviewId, id),
        eq(analysisJobs.status, "running"),
        eq(analysisJobs.attempt, normalizedClaim.attempt),
        eq(analysisJobs.leaseExpiresAt, normalizedClaim.leaseExpiresAt),
        gt(analysisJobs.leaseExpiresAt, now),
      )).run();
      if (jobUpdate.changes !== 1) {
        throw new AnalysisJobCompletionClaimLostError(normalizedClaim.id);
      }
      const reviewUpdate = transaction.update(reviews).set({ updatedAt: now }).where(and(
        eq(reviews.id, id),
        eq(reviews.ownerId, ownerId),
        isNull(reviews.deletingAt),
        eq(reviews.status, "analyzing"),
        eq(reviews.revision, expectedRevision),
        eq(reviews.analysisRunId, normalizedClaim.id),
      )).run();
      if (reviewUpdate.changes === 0) {
        const exists = transaction.select({ id: reviews.id }).from(reviews).where(and(
          eq(reviews.id, id),
          eq(reviews.ownerId, ownerId),
          isNull(reviews.deletingAt),
        )).get();
        if (!exists) throw new ReviewNotFoundError(id);
        throw new AnalysisConflictError(id);
      }
      return { revision: expectedRevision, runId: normalizedClaim.id };
    });
  }

  saveRecognizedOcr(
    ownerId: string,
    id: string,
    token: AnalysisToken,
    sourceRevision: number,
    result: VisionOcrResult,
  ): OcrCheckpointV2 {
    const checkpoint = createOcrCheckpointV2({
      sourceRevision,
      pages: result.pages,
      paragraphs: result.paragraphs,
    });
    const update = this.database.update(reviews).set({
      ocrCheckpoint: checkpoint,
      reportOcrRevision: null,
      updatedAt: this.now(),
    }).where(and(
      eq(reviews.id, id),
      eq(reviews.ownerId, ownerId),
      isNull(reviews.deletingAt),
      eq(reviews.revision, token.revision),
      eq(reviews.analysisRunId, token.runId),
      eq(reviews.imageRevision, sourceRevision),
    )).run();
    if (update.changes === 0) throw new AnalysisConflictError(id);
    return checkpoint;
  }

  editParagraphTexts(
    ownerId: string,
    id: string,
    expectedOcrRevision: number,
    edits: OcrParagraphTextEdit[],
  ): OcrCheckpointV2 {
    const row = this.database.select({
      imageRevision: reviews.imageRevision,
      ocrCheckpoint: reviews.ocrCheckpoint,
    }).from(reviews).where(and(
      eq(reviews.id, id),
      eq(reviews.ownerId, ownerId),
      isNull(reviews.deletingAt),
    )).get();
    if (!row?.ocrCheckpoint) throw new OcrCheckpointError("OCR_NOT_FOUND", 404);

    let current: OcrCheckpoint;
    try {
      current = ocrCheckpointSchema.parse(row.ocrCheckpoint);
    } catch {
      throw new CorruptReviewDataError(id, "ocrCheckpoint");
    }
    if (current.sourceRevision !== row.imageRevision) {
      throw new OcrCheckpointError("OCR_NOT_FOUND", 404);
    }
    const now = this.now();
    const next = editOcrParagraphTexts(
      current,
      expectedOcrRevision,
      edits,
      now.toISOString(),
    );
    const update = this.database.update(reviews).set({
      ocrCheckpoint: next,
      updatedAt: now,
    }).where(and(
      eq(reviews.id, id),
      eq(reviews.ownerId, ownerId),
      isNull(reviews.deletingAt),
      eq(reviews.imageRevision, current.sourceRevision),
      sql`json_extract(${reviews.ocrCheckpoint}, '$.ocrRevision') = ${expectedOcrRevision}`,
    )).run();
    if (update.changes === 0) {
      throw new OcrCheckpointError("OCR_REVISION_CONFLICT", 409);
    }
    return next;
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
      ? validateReport(input.report, { config: review.config })
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

  /**
   * Atomically persists an AI result and finishes the exact Worker claim. If
   * the lease was lost, the review update is rolled back with the job update.
   */
  saveAnalysisAndCompleteJob(
    ownerId: string,
    id: string,
    token: AnalysisToken,
    input: AiReviewEnvelope,
    claim: AnalysisJobCompletionClaim,
    expectedOcrRevision?: number,
  ): ReviewRecord {
    const review = this.requireById(ownerId, id);
    const parsedAnnotations = input.annotations.map((annotation) =>
      annotationSchema.parse(annotation),
    );
    const report = input.readable
      ? validateReport(input.report, { config: review.config })
      : null;
    const status = input.readable ? "ready_for_review" : "needs_better_images";
    const savedAnnotations = input.readable ? parsedAnnotations : [];
    const now = this.now();
    if (!Number.isSafeInteger(claim.attempt) || claim.attempt <= 0 || Number.isNaN(claim.leaseExpiresAt.valueOf())) {
      throw new TypeError("invalid analysis job completion claim");
    }

    this.database.transaction((transaction) => {
      const reviewUpdate = transaction
        .update(reviews)
        .set({
          report,
          ...(expectedOcrRevision === undefined
            ? {}
            : { reportOcrRevision: input.readable ? expectedOcrRevision : null }),
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
            ...(expectedOcrRevision === undefined ? [] : [
              sql`json_extract(${reviews.ocrCheckpoint}, '$.ocrRevision') = ${expectedOcrRevision}`,
            ]),
          ),
        )
        .run();
      if (reviewUpdate.changes === 0) throw new AnalysisConflictError(id);
      transaction.delete(annotations).where(eq(annotations.reviewId, id)).run();
      if (savedAnnotations.length > 0) {
        transaction.insert(annotations).values(
          savedAnnotations.map((annotation, position) => ({ reviewId: id, position, ...annotation })),
        ).run();
      }
      const jobUpdate = transaction.update(analysisJobs).set({
        status: "succeeded",
        errorCode: null,
        message: null,
        leaseExpiresAt: null,
        finishedAt: now,
      }).where(and(
        eq(analysisJobs.id, claim.id),
        eq(analysisJobs.ownerId, ownerId),
        eq(analysisJobs.reviewId, id),
        eq(analysisJobs.status, "running"),
        eq(analysisJobs.attempt, claim.attempt),
        eq(analysisJobs.leaseExpiresAt, claim.leaseExpiresAt),
        gt(analysisJobs.leaseExpiresAt, now),
      )).run();
      if (jobUpdate.changes !== 1) throw new AnalysisJobCompletionClaimLostError(claim.id);
    });
    return this.requireById(ownerId, id);
  }

  /** Atomically fails a claimed job and releases its review from analyzing. */
  failAnalysisAndFailJob(
    ownerId: string,
    id: string,
    token: AnalysisToken,
    claim: AnalysisJobCompletionClaim,
    errorCode: string,
  ): void {
    if (!/^[A-Z0-9_]{1,64}$/.test(errorCode)) throw new TypeError("invalid analysis error code");
    if (!Number.isSafeInteger(claim.attempt) || claim.attempt <= 0 || Number.isNaN(claim.leaseExpiresAt.valueOf())) {
      throw new TypeError("invalid analysis job completion claim");
    }
    const now = this.now();
    this.database.transaction((transaction) => {
      const reviewUpdate = transaction.update(reviews).set({
        status: "failed",
        updatedAt: now,
        analysisRunId: null,
      }).where(and(
        eq(reviews.id, id),
        eq(reviews.ownerId, ownerId),
        isNull(reviews.deletingAt),
        eq(reviews.revision, token.revision),
        eq(reviews.analysisRunId, token.runId),
      )).run();
      if (reviewUpdate.changes === 0) throw new AnalysisConflictError(id);
      const jobUpdate = transaction.update(analysisJobs).set({
        status: "failed",
        errorCode,
        message: null,
        leaseExpiresAt: null,
        finishedAt: now,
      }).where(and(
        eq(analysisJobs.id, claim.id),
        eq(analysisJobs.ownerId, ownerId),
        eq(analysisJobs.reviewId, id),
        eq(analysisJobs.status, "running"),
        eq(analysisJobs.attempt, claim.attempt),
        eq(analysisJobs.leaseExpiresAt, claim.leaseExpiresAt),
        gt(analysisJobs.leaseExpiresAt, now),
      )).run();
      if (jobUpdate.changes !== 1) throw new AnalysisJobCompletionClaimLostError(claim.id);
    });
  }

  finishQueuedAnalysisBeforeToken(
    ownerId: string,
    id: string,
    runId: string,
    claim: AnalysisJobCompletionClaim,
    target: "failed" | "canceled",
    errorCode: string,
  ): void {
    if (!/^[A-Z0-9_]{1,64}$/.test(errorCode)) throw new TypeError("invalid analysis error code");
    if (!Number.isSafeInteger(claim.attempt) || claim.attempt <= 0 || Number.isNaN(claim.leaseExpiresAt.valueOf())) {
      throw new TypeError("invalid analysis job completion claim");
    }
    const now = this.now();
    this.database.transaction((transaction) => {
      transaction.update(reviews).set({
        status: "failed",
        updatedAt: now,
        analysisRunId: null,
      }).where(and(
        eq(reviews.id, id),
        eq(reviews.ownerId, ownerId),
        isNull(reviews.deletingAt),
        eq(reviews.status, "analyzing"),
        eq(reviews.analysisRunId, runId),
      )).run();
      const jobUpdate = transaction.update(analysisJobs).set({
        status: target,
        errorCode,
        message: null,
        leaseExpiresAt: null,
        finishedAt: now,
      }).where(and(
        eq(analysisJobs.id, claim.id),
        eq(analysisJobs.ownerId, ownerId),
        eq(analysisJobs.reviewId, id),
        eq(analysisJobs.status, "running"),
        eq(analysisJobs.attempt, claim.attempt),
        eq(analysisJobs.leaseExpiresAt, claim.leaseExpiresAt),
        gt(analysisJobs.leaseExpiresAt, now),
      )).run();
      if (jobUpdate.changes !== 1) throw new AnalysisJobCompletionClaimLostError(claim.id);
    });
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

  /** 列出 24 小时未上传图片的空草稿以及上次运行已标记的作文。 */
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
          and(
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
                and(
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

  private normalizeAnalysisJobClaim(
    claim: AnalysisJobCompletionClaim,
  ): AnalysisJobCompletionClaim {
    if (
      typeof claim !== "object" ||
      claim === null ||
      typeof claim.id !== "string" ||
      claim.id.length === 0 ||
      !Number.isSafeInteger(claim.attempt) ||
      claim.attempt <= 0 ||
      !(claim.leaseExpiresAt instanceof Date) ||
      Number.isNaN(claim.leaseExpiresAt.valueOf())
    ) {
      throw new TypeError("invalid analysis job claim");
    }
    return {
      id: claim.id,
      attempt: claim.attempt,
      leaseExpiresAt: new Date(claim.leaseExpiresAt.valueOf()),
    };
  }

  private requireById(ownerId: string, id: string): ReviewRecord {
    const review = this.getById(ownerId, id);
    if (!review) throw new ReviewNotFoundError(id);
    return review;
  }
}
