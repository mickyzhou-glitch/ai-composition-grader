import { randomUUID } from "node:crypto";

import { and, desc, eq, inArray, sql } from "drizzle-orm";

import type { AppDatabase } from "../db/client";
import { analysisJobs, reviewImages, reviews, savedAssignments } from "../db/schema";
import { assignmentConfigSchema } from "../domain/contracts";
import type { AnalysisJobRecord } from "../jobs/analysis-job-repository";
import {
  encodeReanalysisPendingPdfMarker,
  encodeReanalysisReadyMarker,
} from "../jobs/analysis-job-metadata";
import { ocrCheckpointSchema } from "../ocr/contracts";
import {
  formatRevisionTeacherGuidance,
  normalizeAssignmentTitle,
  REANALYSIS_SKIP_REASONS,
  type BatchReanalysisCommitItem,
  type BatchReanalysisCommitResult,
  type BatchReanalysisPreview,
  type ReanalysisSkipCode,
  type RevisionRequestInput,
} from "./contracts";

const ANALYZABLE_STATUSES = ["draft", "ready_for_review", "exported", "failed"] as const;

function reanalysisJobMarker(pdfFilename: string | null): string {
  return pdfFilename
    ? encodeReanalysisPendingPdfMarker(pdfFilename)
    : encodeReanalysisReadyMarker();
}

export class ReanalysisDomainError extends Error {
  constructor(
    readonly code: ReanalysisSkipCode,
    readonly status: number,
    readonly review?: { studentName: string; title: string },
  ) {
    super(REANALYSIS_SKIP_REASONS[code]);
    this.name = "ReanalysisDomainError";
  }
}

function domainError(
  code: ReanalysisSkipCode,
  review?: { studentName: string; title: string },
): ReanalysisDomainError {
  return new ReanalysisDomainError(code, code === "REVIEW_NOT_FOUND" ? 404 : 409, review);
}

function assertCurrentOcr(ocrCheckpoint: unknown, imageRevision: number): void {
  const parsed = ocrCheckpointSchema.safeParse(ocrCheckpoint);
  if (!parsed.success || parsed.data.sourceRevision !== imageRevision) {
    throw domainError("OCR_NOT_CURRENT");
  }
}

function hasCurrentOcr(ocrCheckpoint: unknown, imageRevision: number): boolean {
  const parsed = ocrCheckpointSchema.safeParse(ocrCheckpoint);
  return parsed.success && parsed.data.sourceRevision === imageRevision;
}

function isActiveJobUniqueConflict(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "SQLITE_CONSTRAINT_UNIQUE"
    && /^UNIQUE constraint failed: analysis_jobs\.review_id$/u.test(error.message);
}

function isSqliteWriteConflict(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "SQLITE_BUSY" || error.code === "SQLITE_BUSY_SNAPSHOT");
}

function skipped(
  reviewId: string,
  code: ReanalysisSkipCode,
  review?: { studentName: string; title: string },
) {
  return {
    reviewId,
    ...(review ? { studentName: review.studentName, title: review.title } : {}),
    code,
    reason: REANALYSIS_SKIP_REASONS[code],
  };
}

export class ReanalysisRepository {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly database: AppDatabase,
    options: { now?: () => Date; createId?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  preview(ownerId: string, reviewIds: string[]): BatchReanalysisPreview {
    if (reviewIds.length === 0) return { matched: [], skipped: [] };

    const reviewRows = this.database.select({
      id: reviews.id,
      status: reviews.status,
      studentName: reviews.studentName,
      config: reviews.config,
      revision: reviews.revision,
      imageRevision: reviews.imageRevision,
      ocrCheckpoint: reviews.ocrCheckpoint,
      deletingAt: reviews.deletingAt,
    }).from(reviews).where(and(
      eq(reviews.ownerId, ownerId),
      inArray(reviews.id, reviewIds),
    )).all();
    const rowsById = new Map(reviewRows.map((row) => [row.id, row]));
    const ownedReviewIds = reviewRows.map(({ id }) => id);

    const imageReviewIds = ownedReviewIds.length === 0
      ? new Set<string>()
      : new Set(this.database.select({ reviewId: reviewImages.reviewId })
        .from(reviewImages)
        .where(inArray(reviewImages.reviewId, ownedReviewIds))
        .groupBy(reviewImages.reviewId)
        .all()
        .map(({ reviewId }) => reviewId));
    const activeReviewIds = ownedReviewIds.length === 0
      ? new Set<string>()
      : new Set(this.database.select({ reviewId: analysisJobs.reviewId })
        .from(analysisJobs)
        .where(and(
          eq(analysisJobs.ownerId, ownerId),
          inArray(analysisJobs.reviewId, ownedReviewIds),
          inArray(analysisJobs.status, ["queued", "running"]),
        ))
        .groupBy(analysisJobs.reviewId)
        .all()
        .map(({ reviewId }) => reviewId));
    const assignmentRows = this.database.select({
      id: savedAssignments.id,
      title: savedAssignments.title,
      updatedAt: savedAssignments.updatedAt,
    }).from(savedAssignments).where(eq(savedAssignments.ownerId, ownerId))
      .orderBy(desc(savedAssignments.updatedAt), desc(savedAssignments.id))
      .all();
    const latestAssignmentByTitle = new Map<string, (typeof assignmentRows)[number]>();
    for (const assignment of assignmentRows) {
      const title = normalizeAssignmentTitle(assignment.title);
      if (!latestAssignmentByTitle.has(title)) latestAssignmentByTitle.set(title, assignment);
    }

    const matched: BatchReanalysisPreview["matched"] = [];
    const skippedItems: BatchReanalysisPreview["skipped"] = [];
    for (const reviewId of reviewIds) {
      const row = rowsById.get(reviewId);
      if (!row) {
        skippedItems.push(skipped(reviewId, "REVIEW_NOT_FOUND"));
        continue;
      }
      const title = normalizeAssignmentTitle(assignmentConfigSchema.parse(row.config).title);
      const publicReview = { studentName: row.studentName, title };
      let skipCode: ReanalysisSkipCode | null = null;
      if (row.deletingAt !== null || !imageReviewIds.has(reviewId)) {
        skipCode = "REVIEW_UNAVAILABLE";
      } else if (!hasCurrentOcr(row.ocrCheckpoint, row.imageRevision)) {
        skipCode = "OCR_NOT_CURRENT";
      } else if (activeReviewIds.has(reviewId)) {
        skipCode = "ANALYSIS_ACTIVE";
      } else if (!ANALYZABLE_STATUSES.includes(row.status as (typeof ANALYZABLE_STATUSES)[number])) {
        skipCode = "REVIEW_UNAVAILABLE";
      }
      if (skipCode) {
        skippedItems.push(skipped(reviewId, skipCode, publicReview));
        continue;
      }
      const assignment = latestAssignmentByTitle.get(title);
      if (!assignment) {
        skippedItems.push(skipped(reviewId, "FRAMEWORK_NOT_FOUND", publicReview));
        continue;
      }
      matched.push({
        reviewId,
        studentName: row.studentName,
        title,
        expectedRevision: row.revision,
        assignmentId: assignment.id,
        assignmentUpdatedAt: assignment.updatedAt.toISOString(),
      });
    }
    return { matched, skipped: skippedItems };
  }

  requestRevision(
    ownerId: string,
    reviewId: string,
    input: RevisionRequestInput,
  ): AnalysisJobRecord {
    const now = this.now();
    const id = this.createId();
    const teacherGuidance = formatRevisionTeacherGuidance(input.reason, input.changeRequest);

    const execute = (): AnalysisJobRecord => this.database.transaction((transaction) => {
      const review = transaction.select({
        revision: reviews.revision,
        status: reviews.status,
        deletingAt: reviews.deletingAt,
        imageRevision: reviews.imageRevision,
        ocrCheckpoint: reviews.ocrCheckpoint,
        pdfFilename: reviews.pdfFilename,
      }).from(reviews).where(and(
        eq(reviews.id, reviewId),
        eq(reviews.ownerId, ownerId),
      )).get();
      if (!review) throw domainError("REVIEW_NOT_FOUND");
      if (review.deletingAt !== null) throw domainError("REVIEW_UNAVAILABLE");
      if (review.revision !== input.expectedRevision) throw domainError("REVISION_CONFLICT");

      const image = transaction.select({ id: reviewImages.id }).from(reviewImages)
        .where(eq(reviewImages.reviewId, reviewId)).get();
      if (!image) throw domainError("REVIEW_UNAVAILABLE");

      const active = transaction.select({ id: analysisJobs.id }).from(analysisJobs).where(and(
        eq(analysisJobs.reviewId, reviewId),
        inArray(analysisJobs.status, ["queued", "running"]),
      )).get();
      if (active) throw domainError("ANALYSIS_ACTIVE");
      if (!ANALYZABLE_STATUSES.includes(review.status as (typeof ANALYZABLE_STATUSES)[number])) {
        throw domainError("REVIEW_UNAVAILABLE");
      }
      assertCurrentOcr(review.ocrCheckpoint, review.imageRevision);

      try {
        transaction.insert(analysisJobs).values({
          id,
          reviewId,
          ownerId,
          mode: "content_only",
          status: "queued",
          attempt: 0,
          availableAt: now,
          leaseExpiresAt: null,
          progressStage: "queued",
          errorCode: null,
          message: reanalysisJobMarker(review.pdfFilename),
          teacherGuidance,
          createdAt: now,
          startedAt: null,
          finishedAt: null,
        }).run();
      } catch (error) {
        if (isActiveJobUniqueConflict(error)) throw domainError("ANALYSIS_ACTIVE");
        throw error;
      }
      const update = transaction.update(reviews).set({
        status: "analyzing",
        analysisRunId: id,
        teacherReviewedAt: null,
        pdfFilename: null,
        pdfPath: null,
        pdfRevision: null,
        exportedAt: null,
        updatedAt: now,
      }).where(and(
        eq(reviews.id, reviewId),
        eq(reviews.ownerId, ownerId),
        eq(reviews.revision, input.expectedRevision),
        sql`${reviews.deletingAt} IS NULL`,
      )).run();
      if (update.changes !== 1) throw domainError("REVISION_CONFLICT");

      return {
        id,
        reviewId,
        ownerId,
        mode: "content_only",
        status: "queued",
        attempt: 0,
        availableAt: now,
        leaseExpiresAt: null,
        progressStage: "queued",
        errorCode: null,
        message: reanalysisJobMarker(review.pdfFilename),
        prebound: true,
        teacherGuidance,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
      };
    }, { behavior: "immediate" });
    try {
      return execute();
    } catch (error) {
      if (isSqliteWriteConflict(error)) throw domainError("REVISION_CONFLICT");
      throw error;
    }
  }

  commitBatch(
    ownerId: string,
    items: BatchReanalysisCommitItem[],
  ): BatchReanalysisCommitResult {
    const submitted: BatchReanalysisCommitResult["submitted"] = [];
    const skippedItems: BatchReanalysisCommitResult["skipped"] = [];
    for (const item of items) {
      try {
        submitted.push(this.commitOne(ownerId, item));
      } catch (error) {
        if (!(error instanceof ReanalysisDomainError)) throw error;
        skippedItems.push(skipped(item.reviewId, error.code, error.review));
      }
    }
    return { submitted, skipped: skippedItems };
  }

  private commitOne(ownerId: string, item: BatchReanalysisCommitItem) {
    const execute = () => this.database.transaction((transaction) => {
      const row = transaction.select({
        status: reviews.status,
        studentName: reviews.studentName,
        config: reviews.config,
        revision: reviews.revision,
        imageRevision: reviews.imageRevision,
        ocrCheckpoint: reviews.ocrCheckpoint,
        deletingAt: reviews.deletingAt,
        pdfFilename: reviews.pdfFilename,
      }).from(reviews).where(and(
        eq(reviews.id, item.reviewId),
        eq(reviews.ownerId, ownerId),
      )).get();
      if (!row) throw domainError("REVIEW_NOT_FOUND");
      const title = normalizeAssignmentTitle(assignmentConfigSchema.parse(row.config).title);
      const publicReview = { studentName: row.studentName, title };
      if (row.deletingAt !== null) throw domainError("REVIEW_UNAVAILABLE", publicReview);
      if (row.revision !== item.expectedRevision) {
        throw domainError("REVISION_CONFLICT", publicReview);
      }

      const image = transaction.select({ id: reviewImages.id }).from(reviewImages)
        .where(eq(reviewImages.reviewId, item.reviewId)).get();
      if (!image) throw domainError("REVIEW_UNAVAILABLE", publicReview);
      if (!hasCurrentOcr(row.ocrCheckpoint, row.imageRevision)) {
        throw domainError("OCR_NOT_CURRENT", publicReview);
      }
      const active = transaction.select({ id: analysisJobs.id }).from(analysisJobs).where(and(
        eq(analysisJobs.reviewId, item.reviewId),
        inArray(analysisJobs.status, ["queued", "running"]),
      )).get();
      if (active) throw domainError("ANALYSIS_ACTIVE", publicReview);
      if (!ANALYZABLE_STATUSES.includes(row.status as (typeof ANALYZABLE_STATUSES)[number])) {
        throw domainError("REVIEW_UNAVAILABLE", publicReview);
      }

      const assignments = transaction.select({
        id: savedAssignments.id,
        title: savedAssignments.title,
        config: savedAssignments.config,
        updatedAt: savedAssignments.updatedAt,
      }).from(savedAssignments).where(eq(savedAssignments.ownerId, ownerId))
        .orderBy(desc(savedAssignments.updatedAt), desc(savedAssignments.id))
        .all();
      const assignment = assignments.find(
        (candidate) => normalizeAssignmentTitle(candidate.title) === title,
      );
      if (
        !assignment ||
        assignment.id !== item.assignmentId ||
        assignment.updatedAt.toISOString() !== item.expectedAssignmentUpdatedAt
      ) {
        throw domainError("FRAMEWORK_CHANGED", publicReview);
      }
      const assignmentConfig = assignmentConfigSchema.parse(assignment.config);
      const now = this.now();
      const id = this.createId();
      try {
        transaction.insert(analysisJobs).values({
          id,
          reviewId: item.reviewId,
          ownerId,
          mode: "content_only",
          status: "queued",
          attempt: 0,
          availableAt: now,
          leaseExpiresAt: null,
          progressStage: "queued",
          errorCode: null,
          message: reanalysisJobMarker(row.pdfFilename),
          teacherGuidance: null,
          createdAt: now,
          startedAt: null,
          finishedAt: null,
        }).run();
      } catch (error) {
        if (isActiveJobUniqueConflict(error)) {
          throw domainError("ANALYSIS_ACTIVE", publicReview);
        }
        throw error;
      }
      const update = transaction.update(reviews).set({
        config: assignmentConfig,
        revision: sql`${reviews.revision} + 1`,
        status: "analyzing",
        analysisRunId: id,
        teacherReviewedAt: null,
        pdfFilename: null,
        pdfPath: null,
        pdfRevision: null,
        exportedAt: null,
        updatedAt: now,
      }).where(and(
        eq(reviews.id, item.reviewId),
        eq(reviews.ownerId, ownerId),
        eq(reviews.revision, item.expectedRevision),
        sql`${reviews.deletingAt} IS NULL`,
      )).run();
      if (update.changes !== 1) throw domainError("REVISION_CONFLICT", publicReview);
      return { reviewId: item.reviewId, jobId: id, revision: row.revision + 1 };
    }, { behavior: "immediate" });
    try {
      return execute();
    } catch (error) {
      if (isSqliteWriteConflict(error)) throw domainError("REVISION_CONFLICT");
      throw error;
    }
  }
}
