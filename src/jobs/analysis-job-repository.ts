import { randomUUID } from "node:crypto";

import { and, asc, eq, gt, lte, sql } from "drizzle-orm";

import type { AppDatabase } from "../db/client";
import {
  analysisJobs,
  type AnalysisJobStatus,
  type AnalysisProgressStage,
  reviews,
} from "../db/schema";

type QueryDatabase = Pick<AppDatabase, "select">;

export interface AnalysisJobRecord {
  id: string;
  reviewId: string;
  ownerId: string;
  status: AnalysisJobStatus;
  attempt: number;
  availableAt: Date;
  leaseExpiresAt: Date | null;
  progressStage: AnalysisProgressStage;
  errorCode: string | null;
  message: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
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

function toRecord(row: typeof analysisJobs.$inferSelect): AnalysisJobRecord {
  return {
    id: row.id,
    reviewId: row.reviewId,
    ownerId: row.ownerId,
    status: row.status,
    attempt: row.attempt,
    availableAt: row.availableAt,
    leaseExpiresAt: row.leaseExpiresAt,
    progressStage: row.progressStage,
    errorCode: row.errorCode,
    message: row.message,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
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

  createOrGet(ownerId: string, reviewId: string): AnalysisJobRecord {
    assertId(ownerId, "ownerId");
    assertId(reviewId, "reviewId");
    const now = assertDate(this.now(), "now");

    return this.database.transaction((transaction) => {
      const review = transaction
        .select({ id: reviews.id, deletingAt: reviews.deletingAt, expiresAt: reviews.expiresAt })
        .from(reviews)
        .where(and(eq(reviews.id, reviewId), eq(reviews.ownerId, ownerId)))
        .get();
      if (!review) throw new AnalysisJobNotFoundError(reviewId);

      if (review.deletingAt !== null || (review.expiresAt !== null && review.expiresAt <= now)) {
        transaction
          .update(analysisJobs)
          .set({
            status: "canceled",
            errorCode: "REVIEW_UNAVAILABLE",
            message: null,
            leaseExpiresAt: null,
            finishedAt: now,
          })
          .where(and(
            eq(analysisJobs.ownerId, ownerId),
            eq(analysisJobs.reviewId, reviewId),
            activeStatusCondition(),
          ))
          .run();
        throw new AnalysisJobUnavailableReviewError(reviewId);
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
          status: "queued",
          attempt: 0,
          availableAt: now,
          leaseExpiresAt: null,
          progressStage: "queued",
          errorCode: null,
          message: null,
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

  /** Reclaims expired leases then atomically claims one available queued job. */
  claimNext(): AnalysisJobRecord | null {
    const now = assertDate(this.now(), "now");
    const leaseExpiresAt = new Date(now.valueOf() + this.leaseMs);
    return this.database.transaction((transaction) => {
      transaction
        .update(analysisJobs)
        .set({
          status: "failed",
          errorCode: "ATTEMPTS_EXHAUSTED",
          message: null,
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
          message: null,
        })
        .where(and(
          eq(analysisJobs.status, "running"),
          lte(analysisJobs.leaseExpiresAt, now),
          sql`${analysisJobs.attempt} < ${this.maxAttempts}`,
        ))
        .run();

      const candidate = transaction.select({ id: analysisJobs.id })
        .from(analysisJobs)
        .where(and(
          eq(analysisJobs.status, "queued"),
          lte(analysisJobs.availableAt, now),
          sql`${analysisJobs.attempt} < ${this.maxAttempts}`,
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
        message: null,
        startedAt: sql`coalesce(${analysisJobs.startedAt}, ${now.valueOf()})`,
        finishedAt: null,
      }).where(and(
        eq(analysisJobs.id, candidate.id),
        eq(analysisJobs.status, "queued"),
        lte(analysisJobs.availableAt, now),
        sql`${analysisJobs.attempt} < ${this.maxAttempts}`,
      )).run();
      if (update.changes !== 1) return null;
      return this.requireByIdInTransaction(transaction, undefined, candidate.id);
    });
  }

  transition(id: string, target: AnalysisJobStatus, options: TransitionOptions = {}): AnalysisJobRecord {
    assertId(id, "jobId");
    const now = assertDate(this.now(), "now");
    return this.database.transaction((transaction) => {
      const current = this.requireByIdInTransaction(transaction, undefined, id);
      const valid = current.status === "running" && ["succeeded", "failed", "canceled"].includes(target)
        || current.status === "queued" && target === "canceled";
      if (!valid) throw new AnalysisJobTransitionError(current.status, target);
      transaction.update(analysisJobs).set({
        status: target,
        errorCode: options.errorCode ?? null,
        message: options.message ?? null,
        leaseExpiresAt: null,
        finishedAt: now,
      }).where(and(eq(analysisJobs.id, id), eq(analysisJobs.status, current.status))).run();
      return this.requireByIdInTransaction(transaction, undefined, id);
    });
  }

  updateProgress(id: string, stage: Exclude<AnalysisProgressStage, "queued">, message: string | null = null): AnalysisJobRecord {
    assertId(id, "jobId");
    const current = this.getInternal(id);
    if (!current) throw new AnalysisJobNotFoundError(id);
    if (current.status !== "running") throw new AnalysisJobTransitionError(current.status, "running");
    this.database.update(analysisJobs).set({ progressStage: stage, message })
      .where(and(eq(analysisJobs.id, id), eq(analysisJobs.status, "running"))).run();
    return this.requireInternal(id);
  }

  /** Lets a worker keep an existing claim alive without revealing it to clients. */
  renewLease(id: string, expectedLeaseExpiresAt: Date): AnalysisJobRecord | null {
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
    return result.changes === 1 ? this.requireInternal(id) : null;
  }

  /** Cancels active work for any review that is deleting or past its retention deadline. */
  cancelUnavailable(): number {
    const now = assertDate(this.now(), "now");
    return this.database.update(analysisJobs).set({
      status: "canceled",
      errorCode: "REVIEW_UNAVAILABLE",
      message: null,
      leaseExpiresAt: null,
      finishedAt: now,
    }).where(and(
      activeStatusCondition(),
      sql`EXISTS (
        SELECT 1 FROM reviews
        WHERE reviews.id = ${analysisJobs.reviewId}
          AND reviews.owner_id = ${analysisJobs.ownerId}
          AND (reviews.deleting_at IS NOT NULL OR reviews.expires_at <= ${now.valueOf()})
      )`,
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
}
