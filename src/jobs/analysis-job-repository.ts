import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";

import type { AppDatabase } from "../db/client";
import { analysisModeForCheckpoint } from "../ocr/analysis-mode";
import { ocrCheckpointSchema } from "../ocr/contracts";
import { MAX_ANALYSIS_TEACHER_GUIDANCE_CHARS } from "../reanalysis/contracts";
import {
  ANALYSIS_JOB_METADATA_PREFIX,
  REANALYSIS_PENDING_PDF_MARKER_PREFIX,
  parseAnalysisJobMetadata,
  readyReanalysisMarkerFromPending,
} from "./analysis-job-metadata";
import {
  analysisJobs,
  type AnalysisJobStatus,
  type AnalysisJobMode,
  type AnalysisProgressStage,
  reviews,
} from "../db/schema";

type QueryDatabase = Pick<AppDatabase, "select">;

export interface AnalysisJobRecord {
  id: string;
  reviewId: string;
  ownerId: string;
  mode: AnalysisJobMode;
  status: AnalysisJobStatus;
  attempt: number;
  availableAt: Date;
  leaseExpiresAt: Date | null;
  progressStage: AnalysisProgressStage;
  errorCode: string | null;
  message: string | null;
  teacherGuidance: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  prebound: boolean;
}

export interface ClaimedAnalysisJobRecord extends AnalysisJobRecord {
  status: "running";
  leaseExpiresAt: Date;
}

export interface AnalysisJobRepositoryOptions {
  now?: () => Date;
  createId?: () => string;
  maxAttempts?: number;
  leaseMs?: number;
}

export interface TransitionOptions {
  errorCode?: string | null;
  message?: string | null;
}

/** A worker's opaque compare-and-swap proof that it still owns a running job. */
export interface AnalysisJobClaim {
  id: string;
  attempt: number;
  leaseExpiresAt: Date;
}

export interface PendingPdfCleanup {
  jobId: string;
  ownerId: string;
  reviewId: string;
  filename: string;
  marker: string;
}

export class AnalysisJobNotFoundError extends Error {
  readonly code = "NOT_FOUND";
  readonly status = 404;

  constructor(id: string) {
    super(`Analysis job not found: ${id}`);
    this.name = "AnalysisJobNotFoundError";
  }
}

export class AnalysisJobTransitionError extends Error {
  readonly code = "INVALID_JOB_TRANSITION";

  constructor(from: AnalysisJobStatus, to: AnalysisJobStatus) {
    super(`非法任务状态转换: ${from} -> ${to}`);
    this.name = "AnalysisJobTransitionError";
  }
}

export class AnalysisJobUnavailableReviewError extends Error {
  readonly code = "REVIEW_UNAVAILABLE";

  constructor(reviewId: string) {
    super(`Review is unavailable for analysis: ${reviewId}`);
    this.name = "AnalysisJobUnavailableReviewError";
  }
}

export class AnalysisJobOcrNotFoundError extends Error {
  readonly code = "OCR_NOT_FOUND";
  readonly status = 409;

  constructor(reviewId: string) {
    super(`识别原文不存在或已失效：${reviewId}`);
    this.name = "AnalysisJobOcrNotFoundError";
  }
}

export class AnalysisJobLostClaimError extends Error {
  readonly code = "JOB_CLAIM_LOST";

  constructor(id: string) {
    super(`Analysis job claim was lost: ${id}`);
    this.name = "AnalysisJobLostClaimError";
  }
}

function assertId(value: string, name: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new TypeError(`${name} must be a safe identifier`);
  }
}

function assertDate(value: Date, name: string): Date {
  const timestamp = value.getTime();
  if (!Number.isSafeInteger(timestamp)) throw new TypeError(`${name} must be a valid date`);
  return new Date(timestamp);
}

function assertPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

function activeStatusCondition() {
  return sql`${analysisJobs.status} IN ('queued', 'running')`;
}

const progressStages: readonly Exclude<AnalysisProgressStage, "queued">[] = [
  "reading_images",
  "saving_ocr",
  "generating_review",
  "mapping_annotations",
  "validating_result",
  "saving_result",
];

function toRecord(row: typeof analysisJobs.$inferSelect): AnalysisJobRecord {
  const metadata = parseAnalysisJobMetadata(row.message);
  return {
    id: row.id,
    reviewId: row.reviewId,
    ownerId: row.ownerId,
    mode: row.mode,
    status: row.status,
    attempt: row.attempt,
    availableAt: row.availableAt,
    leaseExpiresAt: row.leaseExpiresAt,
    progressStage: row.progressStage,
    errorCode: row.errorCode,
    message: row.message,
    teacherGuidance: row.teacherGuidance,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    prebound: metadata?.prebound ?? false,
  };
}

/**
 * SQLite-backed work queue. All state-changing methods are synchronous so the
 * transaction encompasses both selection and mutation; workers must never
 * observe a job without atomically owning its lease.
 */
export class AnalysisJobRepository {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly maxAttempts: number;
  private readonly leaseMs: number;

  constructor(
    private readonly database: AppDatabase,
    options: AnalysisJobRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.maxAttempts = assertPositiveInteger(options.maxAttempts ?? 3, "maxAttempts");
    this.leaseMs = assertPositiveInteger(options.leaseMs ?? 180_000, "leaseMs");
  }

  createOrGet(
    ownerId: string,
    reviewId: string,
    teacherGuidance?: string,
    mode: AnalysisJobMode = "full",
  ): AnalysisJobRecord {
    assertId(ownerId, "ownerId");
    assertId(reviewId, "reviewId");
    const normalizedGuidance = teacherGuidance?.trim() || null;
    if (mode !== "full" && mode !== "content_only") throw new TypeError("invalid analysis mode");
    if (normalizedGuidance && normalizedGuidance.length > MAX_ANALYSIS_TEACHER_GUIDANCE_CHARS) {
      throw new TypeError(
        `teacherGuidance must be at most ${MAX_ANALYSIS_TEACHER_GUIDANCE_CHARS} characters`,
      );
    }
    const now = assertDate(this.now(), "now");

    const outcome = this.database.transaction((transaction): AnalysisJobRecord | "unavailable" => {
      const review = transaction
        .select({
          id: reviews.id,
          deletingAt: reviews.deletingAt,
          imageRevision: reviews.imageRevision,
          ocrCheckpoint: reviews.ocrCheckpoint,
        })
        .from(reviews)
        .where(and(eq(reviews.id, reviewId), eq(reviews.ownerId, ownerId)))
        .get();
      if (!review) throw new AnalysisJobNotFoundError(reviewId);

      if (review.deletingAt !== null) {
        transaction
          .update(analysisJobs)
          .set({
            status: "canceled",
            errorCode: "REVIEW_UNAVAILABLE",
            message: this.preservedPendingPdfCleanupMessage(),
            leaseExpiresAt: null,
            finishedAt: now,
          })
          .where(and(
            eq(analysisJobs.ownerId, ownerId),
            eq(analysisJobs.reviewId, reviewId),
            activeStatusCondition(),
          ))
          .run();
        // Returning a sentinel commits the cancellation. Throwing inside the
        // transaction would silently roll that safety write back.
        return "unavailable";
      }

      if (mode === "content_only") {
        const checkpoint = ocrCheckpointSchema.safeParse(review.ocrCheckpoint);
        if (!checkpoint.success) {
          analysisModeForCheckpoint(mode, null);
          throw new TypeError("unreachable");
        }
        if (checkpoint.data.sourceRevision !== review.imageRevision) {
          throw new AnalysisJobOcrNotFoundError(reviewId);
        }
        analysisModeForCheckpoint(mode, checkpoint.data);
      }

      const existing = this.findActive(transaction, ownerId, reviewId);
      if (existing) return existing;

      const id = this.createId();
      assertId(id, "job id");
      try {
        transaction.insert(analysisJobs).values({
          id,
          ownerId,
          reviewId,
          mode,
          status: "queued",
          attempt: 0,
          availableAt: now,
          leaseExpiresAt: null,
          progressStage: "queued",
          errorCode: null,
          message: null,
          teacherGuidance: normalizedGuidance,
          createdAt: now,
          startedAt: null,
          finishedAt: null,
        }).run();
      } catch (error) {
        // The partial unique index is the final guard when a second process
        // inserts between this transaction's read and write.
        if (!(error instanceof Error) || !/UNIQUE constraint failed/.test(error.message)) {
          throw error;
        }
        const raced = this.findActive(transaction, ownerId, reviewId);
        if (raced) return raced;
        throw error;
      }
      return this.requireByIdInTransaction(transaction, ownerId, id);
    });
    if (outcome === "unavailable") throw new AnalysisJobUnavailableReviewError(reviewId);
    return outcome;
  }

  getById(ownerId: string, id: string): AnalysisJobRecord | null {
    assertId(ownerId, "ownerId");
    assertId(id, "jobId");
    const row = this.database.select().from(analysisJobs)
      .where(and(eq(analysisJobs.id, id), eq(analysisJobs.ownerId, ownerId)))
      .get();
    return row ? toRecord(row) : null;
  }

  requireById(ownerId: string, id: string): AnalysisJobRecord {
    const result = this.getById(ownerId, id);
    if (!result) throw new AnalysisJobNotFoundError(id);
    return result;
  }

  findLatestByReview(ownerId: string, reviewId: string): AnalysisJobRecord | null {
    assertId(ownerId, "ownerId");
    assertId(reviewId, "reviewId");
    const row = this.database.select().from(analysisJobs).where(and(
      eq(analysisJobs.ownerId, ownerId),
      eq(analysisJobs.reviewId, reviewId),
    )).orderBy(desc(analysisJobs.createdAt), desc(analysisJobs.id)).get();
    return row ? toRecord(row) : null;
  }

  findPendingPdfCleanup(): PendingPdfCleanup | null {
    const rows = this.database.select({
      jobId: analysisJobs.id,
      ownerId: analysisJobs.ownerId,
      reviewId: analysisJobs.reviewId,
      marker: analysisJobs.message,
    }).from(analysisJobs).where(this.pendingPdfCleanupMarkerCondition())
      .orderBy(asc(analysisJobs.createdAt), asc(analysisJobs.id))
      .all();
    for (const row of rows) {
      const metadata = parseAnalysisJobMetadata(row.marker);
      if (metadata?.kind === "reanalysis" && metadata.pdfCleanup && row.marker) {
        return { ...row, marker: row.marker, filename: metadata.pdfCleanup.filename };
      }
    }
    return null;
  }

  ackPdfCleanup(jobId: string, marker: string): boolean {
    assertId(jobId, "jobId");
    let readyMarker: string;
    try {
      readyMarker = readyReanalysisMarkerFromPending(marker);
    } catch {
      return false;
    }
    return this.database.update(analysisJobs).set({ message: readyMarker }).where(and(
      eq(analysisJobs.id, jobId),
      eq(analysisJobs.message, marker),
    )).run().changes === 1;
  }

  /** Reclaims expired leases then atomically claims one available queued job. */
  claimNext(): ClaimedAnalysisJobRecord | null {
    const now = assertDate(this.now(), "now");
    const leaseExpiresAt = new Date(now.valueOf() + this.leaseMs);
    return this.database.transaction((transaction) => {
      // This has to happen in the same transaction as selection. Retention can
      // mark a review unavailable between polling cycles, and a worker must not
      // claim it in that gap.
      transaction.update(analysisJobs).set({
        status: "canceled",
        errorCode: "REVIEW_UNAVAILABLE",
        message: this.preservedPendingPdfCleanupMessage(),
        leaseExpiresAt: null,
        finishedAt: now,
      }).where(and(
        activeStatusCondition(),
        this.unavailableReviewCondition(),
      )).run();

      const exhausted = transaction.select({
        id: analysisJobs.id,
        ownerId: analysisJobs.ownerId,
        reviewId: analysisJobs.reviewId,
        reviewRevision: reviews.revision,
      }).from(analysisJobs).innerJoin(reviews, and(
        eq(reviews.id, analysisJobs.reviewId),
        eq(reviews.ownerId, analysisJobs.ownerId),
      )).where(and(
        eq(analysisJobs.status, "running"),
        lte(analysisJobs.leaseExpiresAt, now),
        sql`${analysisJobs.attempt} >= ${this.maxAttempts}`,
      )).all();
      for (const job of exhausted) {
        transaction.update(reviews).set({
          status: "failed",
          analysisRunId: null,
          updatedAt: now,
        }).where(and(
          eq(reviews.id, job.reviewId),
          eq(reviews.ownerId, job.ownerId),
          isNull(reviews.deletingAt),
          eq(reviews.status, "analyzing"),
          eq(reviews.analysisRunId, job.id),
          eq(reviews.revision, job.reviewRevision),
        )).run();
      }

      transaction
        .update(analysisJobs)
        .set({
          status: "failed",
          errorCode: "ATTEMPTS_EXHAUSTED",
          message: this.preservedPendingPdfCleanupMessage(),
          leaseExpiresAt: null,
          finishedAt: now,
        })
        .where(and(
          eq(analysisJobs.status, "running"),
          lte(analysisJobs.leaseExpiresAt, now),
          sql`${analysisJobs.attempt} >= ${this.maxAttempts}`,
        ))
        .run();

      transaction
        .update(analysisJobs)
        .set({
          status: "queued",
          availableAt: now,
          leaseExpiresAt: null,
          progressStage: "queued",
          errorCode: null,
          message: this.preservedInternalMetadataMessage(null),
        })
        .where(and(
          eq(analysisJobs.status, "running"),
          lte(analysisJobs.leaseExpiresAt, now),
          sql`${analysisJobs.attempt} < ${this.maxAttempts}`,
          sql`(${analysisJobs.message} IS NULL OR NOT ${this.pendingPdfCleanupMarkerCondition()})`,
        ))
        .run();

      // The worker is intentionally global-singleton: a live lease on any
      // composition prevents another process from claiming a different one.
      // This is inside the transaction after recovery, so an expired lease is
      // never allowed to block the queue forever.
      const activeClaim = transaction.select({ id: analysisJobs.id })
        .from(analysisJobs)
        .where(and(
          eq(analysisJobs.status, "running"),
          gt(analysisJobs.leaseExpiresAt, now),
        ))
        .get();
      if (activeClaim) return null;

      const candidate = transaction.select({ id: analysisJobs.id })
        .from(analysisJobs)
        .where(and(
          eq(analysisJobs.status, "queued"),
          lte(analysisJobs.availableAt, now),
          sql`${analysisJobs.attempt} < ${this.maxAttempts}`,
          sql`(${analysisJobs.message} IS NULL OR NOT ${this.pendingPdfCleanupMarkerCondition()})`,
          sql`EXISTS (
            SELECT 1 FROM reviews
            WHERE reviews.id = ${analysisJobs.reviewId}
              AND reviews.owner_id = ${analysisJobs.ownerId}
              AND reviews.deleting_at IS NULL
          )`,
        ))
        .orderBy(asc(analysisJobs.availableAt), asc(analysisJobs.createdAt), asc(analysisJobs.id))
        .get();
      if (!candidate) return null;

      const update = transaction.update(analysisJobs).set({
        status: "running",
        attempt: sql`${analysisJobs.attempt} + 1`,
        leaseExpiresAt,
        progressStage: "reading_images",
        errorCode: null,
        message: this.preservedInternalMetadataMessage(null),
        startedAt: sql`coalesce(${analysisJobs.startedAt}, ${now.valueOf()})`,
        finishedAt: null,
      }).where(and(
        eq(analysisJobs.id, candidate.id),
        eq(analysisJobs.status, "queued"),
        lte(analysisJobs.availableAt, now),
        sql`${analysisJobs.attempt} < ${this.maxAttempts}`,
        sql`(${analysisJobs.message} IS NULL OR NOT ${this.pendingPdfCleanupMarkerCondition()})`,
        sql`EXISTS (
          SELECT 1 FROM reviews
          WHERE reviews.id = ${analysisJobs.reviewId}
            AND reviews.owner_id = ${analysisJobs.ownerId}
            AND reviews.deleting_at IS NULL
        )`,
      )).run();
      if (update.changes !== 1) return null;
      const claimed = this.requireByIdInTransaction(transaction, undefined, candidate.id);
      if (claimed.status !== "running" || claimed.leaseExpiresAt === null) {
        throw new Error("Claimed analysis job is unexpectedly not running");
      }
      return claimed as ClaimedAnalysisJobRecord;
    });
  }

  transition(claim: AnalysisJobClaim, target: AnalysisJobStatus, options: TransitionOptions = {}): AnalysisJobRecord {
    const normalizedClaim = this.assertClaim(claim);
    const now = assertDate(this.now(), "now");
    return this.database.transaction((transaction) => {
      const current = this.requireByIdInTransaction(transaction, undefined, normalizedClaim.id);
      const valid = current.status === "running" && ["succeeded", "failed", "canceled"].includes(target);
      if (!valid) throw new AnalysisJobTransitionError(current.status, target);
      const update = transaction.update(analysisJobs).set({
        status: target,
        errorCode: options.errorCode ?? null,
        message: options.message ?? null,
        leaseExpiresAt: null,
        finishedAt: now,
      }).where(this.runningClaimCondition(normalizedClaim, now)).run();
      if (update.changes !== 1) throw new AnalysisJobLostClaimError(normalizedClaim.id);
      return this.requireByIdInTransaction(transaction, undefined, normalizedClaim.id);
    });
  }

  updateProgress(claim: AnalysisJobClaim, stage: Exclude<AnalysisProgressStage, "queued">, message: string | null = null): ClaimedAnalysisJobRecord {
    const normalizedClaim = this.assertClaim(claim);
    const current = this.getInternal(normalizedClaim.id);
    if (!current) throw new AnalysisJobNotFoundError(normalizedClaim.id);
    if (
      current.status !== "running" ||
      current.attempt !== normalizedClaim.attempt ||
      current.leaseExpiresAt?.valueOf() !== normalizedClaim.leaseExpiresAt.valueOf() ||
      current.leaseExpiresAt <= assertDate(this.now(), "now")
    ) {
      throw new AnalysisJobLostClaimError(normalizedClaim.id);
    }
    const currentIndex = progressStages.indexOf(current.progressStage as Exclude<AnalysisProgressStage, "queued">);
    const requestedIndex = progressStages.indexOf(stage);
    if (requestedIndex !== currentIndex + 1) {
      throw new AnalysisJobTransitionError(current.status, current.status);
    }
    const update = this.database.update(analysisJobs).set({
      progressStage: stage,
      message: this.preservedInternalMetadataMessage(message),
    })
      .where(this.runningClaimCondition(normalizedClaim, assertDate(this.now(), "now"))).run();
    if (update.changes !== 1) throw new AnalysisJobLostClaimError(normalizedClaim.id);
    const updated = this.requireInternal(normalizedClaim.id);
    if (updated.status !== "running" || updated.leaseExpiresAt === null) {
      throw new AnalysisJobLostClaimError(normalizedClaim.id);
    }
    return updated as ClaimedAnalysisJobRecord;
  }

  /** Lets a worker keep an existing claim alive without revealing it to clients. */
  renewLease(id: string, expectedLeaseExpiresAt: Date): ClaimedAnalysisJobRecord | null {
    assertId(id, "jobId");
    const now = assertDate(this.now(), "now");
    const expected = assertDate(expectedLeaseExpiresAt, "expectedLeaseExpiresAt");
    const nextLease = new Date(now.valueOf() + this.leaseMs);
    const result = this.database.update(analysisJobs).set({ leaseExpiresAt: nextLease })
      .where(and(
        eq(analysisJobs.id, id),
        eq(analysisJobs.status, "running"),
        eq(analysisJobs.leaseExpiresAt, expected),
        gt(analysisJobs.leaseExpiresAt, now),
      )).run();
    if (result.changes !== 1) return null;
    const updated = this.requireInternal(id);
    if (updated.status !== "running" || updated.leaseExpiresAt === null) return null;
    return updated as ClaimedAnalysisJobRecord;
  }

  /** Releases a failed claim for one later attempt, or finishes it at the configured cap. */
  retry(claim: AnalysisJobClaim, errorCode: string): "queued" | "at_limit" {
    const normalizedClaim = this.assertClaim(claim);
    if (!/^[A-Z0-9_]{1,64}$/.test(errorCode)) throw new TypeError("errorCode must be safe");
    const now = assertDate(this.now(), "now");
    const current = this.getInternal(normalizedClaim.id);
    if (!current) throw new AnalysisJobNotFoundError(normalizedClaim.id);
    if (current.status !== "running") throw new AnalysisJobLostClaimError(normalizedClaim.id);
    if (current.attempt >= this.maxAttempts) return "at_limit";
    const update = this.database.update(analysisJobs).set({
      status: "queued",
      availableAt: now,
      progressStage: "queued",
      errorCode,
      message: this.preservedInternalMetadataMessage(null),
      leaseExpiresAt: null,
      finishedAt: null,
    }).where(this.runningClaimCondition(normalizedClaim, now)).run();
    if (update.changes !== 1) throw new AnalysisJobLostClaimError(normalizedClaim.id);
    return "queued";
  }

  /** Cancels active work for any review that is deleting or past its retention deadline. */
  cancelUnavailable(): number {
    const now = assertDate(this.now(), "now");
    return this.database.update(analysisJobs).set({
      status: "canceled",
      errorCode: "REVIEW_UNAVAILABLE",
      message: this.preservedPendingPdfCleanupMessage(),
      leaseExpiresAt: null,
      finishedAt: now,
    }).where(and(
      activeStatusCondition(),
      this.unavailableReviewCondition(),
    )).run().changes;
  }

  private findActive(database: QueryDatabase, ownerId: string, reviewId: string): AnalysisJobRecord | null {
    const row = database.select().from(analysisJobs).where(and(
      eq(analysisJobs.ownerId, ownerId),
      eq(analysisJobs.reviewId, reviewId),
      activeStatusCondition(),
    )).orderBy(asc(analysisJobs.createdAt)).get();
    return row ? toRecord(row) : null;
  }

  private getInternal(id: string): AnalysisJobRecord | null {
    const row = this.database.select().from(analysisJobs).where(eq(analysisJobs.id, id)).get();
    return row ? toRecord(row) : null;
  }

  private requireInternal(id: string): AnalysisJobRecord {
    const row = this.getInternal(id);
    if (!row) throw new AnalysisJobNotFoundError(id);
    return row;
  }

  private requireByIdInTransaction(database: QueryDatabase, ownerId: string | undefined, id: string): AnalysisJobRecord {
    const conditions = ownerId === undefined
      ? eq(analysisJobs.id, id)
      : and(eq(analysisJobs.id, id), eq(analysisJobs.ownerId, ownerId));
    const row = database.select().from(analysisJobs).where(conditions).get();
    if (!row) throw new AnalysisJobNotFoundError(id);
    return toRecord(row);
  }

  private assertClaim(claim: AnalysisJobClaim): AnalysisJobClaim {
    if (typeof claim !== "object" || claim === null) throw new TypeError("claim is required");
    assertId(claim.id, "jobId");
    assertPositiveInteger(claim.attempt, "claim.attempt");
    return {
      id: claim.id,
      attempt: claim.attempt,
      leaseExpiresAt: assertDate(claim.leaseExpiresAt, "claim.leaseExpiresAt"),
    };
  }

  private runningClaimCondition(claim: AnalysisJobClaim, now: Date) {
    return and(
      eq(analysisJobs.id, claim.id),
      eq(analysisJobs.status, "running"),
      eq(analysisJobs.attempt, claim.attempt),
      eq(analysisJobs.leaseExpiresAt, claim.leaseExpiresAt),
      gt(analysisJobs.leaseExpiresAt, now),
    );
  }

  private unavailableReviewCondition() {
    return sql`EXISTS (
      SELECT 1 FROM reviews
      WHERE reviews.id = ${analysisJobs.reviewId}
        AND reviews.owner_id = ${analysisJobs.ownerId}
        AND reviews.deleting_at IS NOT NULL
    )`;
  }

  private pendingPdfCleanupMarkerCondition() {
    return sql`substr(${analysisJobs.message}, 1, ${REANALYSIS_PENDING_PDF_MARKER_PREFIX.length}) = ${REANALYSIS_PENDING_PDF_MARKER_PREFIX}`;
  }

  private internalMetadataCondition() {
    return sql`substr(${analysisJobs.message}, 1, ${ANALYSIS_JOB_METADATA_PREFIX.length}) = ${ANALYSIS_JOB_METADATA_PREFIX}`;
  }

  private preservedInternalMetadataMessage(fallback: string | null) {
    return sql`CASE WHEN ${this.internalMetadataCondition()} THEN ${analysisJobs.message} ELSE ${fallback} END`;
  }

  private preservedPendingPdfCleanupMessage() {
    return sql`CASE WHEN ${this.pendingPdfCleanupMarkerCondition()} THEN ${analysisJobs.message} ELSE NULL END`;
  }
}
