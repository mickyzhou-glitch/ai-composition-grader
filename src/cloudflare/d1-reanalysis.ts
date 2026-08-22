import { assignmentConfigSchema } from "../domain/contracts";
import {
  formatRevisionTeacherGuidance,
  normalizeAssignmentTitle,
  REANALYSIS_SKIP_REASONS,
  type BatchReanalysisCommitItem,
  type BatchReanalysisCommitResult,
  type BatchReanalysisMatchedItem,
  type BatchReanalysisPreview,
  type BatchReanalysisSkippedItem,
  type BatchReanalysisSubmittedItem,
  type PublicAnalysisJobView,
  type ReanalysisSkipCode,
  type RevisionRequestInput,
  type RevisionRequestResult,
} from "../reanalysis/contracts";

export type D1ReanalysisStatement = D1PreparedStatement;

type D1Outcome = { meta?: { changes?: number } };

interface ReviewRow {
  id: string;
  status: string;
  student_name: string;
  config: string;
  revision: number;
  image_revision: number;
  ocr_checkpoint: string | null;
  deleting_at: number | null;
  image_count: number;
  active_job?: number;
}

interface AssignmentRow {
  id: string;
  title: string;
  config?: string;
  updated_at: number | string;
}

const ANALYZABLE_STATUSES = ["draft", "ready_for_review", "exported", "failed"] as const;

export class D1ReanalysisError extends Error {
  readonly code: ReanalysisSkipCode;
  readonly review?: { studentName: string; title: string };

  constructor(code: ReanalysisSkipCode, review?: { studentName: string; title: string }) {
    super(REANALYSIS_SKIP_REASONS[code]);
    this.name = "D1ReanalysisError";
    this.code = code;
    this.review = review;
  }
}

/** Internal failure boundary used to compensate jobs committed before a later item failed. */
export class D1ReanalysisBatchError extends Error {
  readonly submitted: BatchReanalysisSubmittedItem[];
  readonly jobIds: string[];
  readonly cause: unknown;

  constructor(submitted: BatchReanalysisSubmittedItem[], cause?: unknown) {
    super("D1_REANALYSIS_BATCH_FAILED");
    this.name = "D1ReanalysisBatchError";
    this.submitted = submitted.map((item) => ({ ...item }));
    this.jobIds = this.submitted.map(({ jobId }) => jobId);
    this.cause = cause;
  }
}

function skipped(
  reviewId: string,
  code: ReanalysisSkipCode,
  review?: { studentName: string; title: string },
): BatchReanalysisSkippedItem {
  return {
    reviewId,
    ...(review ? { studentName: review.studentName, title: review.title } : {}),
    code,
    reason: REANALYSIS_SKIP_REASONS[code],
  };
}

function resultRows<T>(result: { results?: T[] } | null | undefined): T[] {
  return result?.results ?? [];
}

function asEpoch(value: number | string): number {
  const epoch = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(epoch)) throw new TypeError("Invalid assignment timestamp");
  return epoch;
}

function asIso(value: number | string): string {
  return new Date(asEpoch(value)).toISOString();
}

function hasCurrentOcr(checkpoint: string | null | undefined, imageRevision: number): boolean {
  if (!checkpoint) return false;
  try {
    const parsed = JSON.parse(checkpoint) as { sourceRevision?: unknown };
    return parsed !== null && typeof parsed === "object" && parsed.sourceRevision === imageRevision;
  } catch {
    return false;
  }
}

function configTitle(config: string): string {
  const value = typeof config === "string" ? JSON.parse(config) : config;
  return normalizeAssignmentTitle(assignmentConfigSchema.parse(value).title);
}

function publicReview(row: ReviewRow): { studentName: string; title: string } {
  return { studentName: row.student_name, title: configTitle(row.config) };
}

function isAnalyzable(status: string): boolean {
  return (ANALYZABLE_STATUSES as readonly string[]).includes(status);
}

function hasActiveJob(row: ReviewRow): boolean {
  return row.active_job === 1 || (row.active_job as unknown) === true;
}

function isActiveJobConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String((error as Error & { code?: unknown }).code) : "";
  return (!code || code === "SQLITE_CONSTRAINT_UNIQUE" || code === "D1_ERROR" || code === "SQLITE_CONSTRAINT")
    && /UNIQUE constraint failed: analysis_jobs\.review_id|analysis_jobs_one_active_per_review_idx/iu.test(error.message);
}

function changes(outcome: D1Outcome | undefined): number {
  return outcome?.meta?.changes ?? 0;
}

function queuedJob(
  id: string,
  reviewId: string,
  now: number,
): PublicAnalysisJobView {
  return {
    id,
    reviewId,
    mode: "content_only",
    status: "queued",
    progressStage: "queued",
    message: null,
    createdAt: new Date(now).toISOString(),
    finishedAt: null,
  };
}

function inPlacePlaceholders(values: string[]): string {
  return values.map(() => "?").join(", ");
}

export class D1Reanalysis {
  constructor(private readonly database: D1Database) {}

  async preview(ownerId: string, reviewIds: string[]): Promise<BatchReanalysisPreview> {
    if (reviewIds.length === 0) return { matched: [], skipped: [] };
    const placeholders = inPlacePlaceholders(reviewIds);
    const reviewResult = await this.database.prepare(`
      SELECT reviews.id, reviews.status, reviews.student_name, reviews.config,
        reviews.revision, reviews.image_revision, reviews.ocr_checkpoint, reviews.deleting_at,
        COUNT(review_images.id) AS image_count
      FROM reviews
      LEFT JOIN review_images ON review_images.review_id = reviews.id
      WHERE reviews.owner_id = ? AND reviews.id IN (${placeholders})
      GROUP BY reviews.id
    `).bind(ownerId, ...reviewIds).all<ReviewRow>();
    const reviewsById = new Map(resultRows(reviewResult).map((row) => [row.id, row]));
    const ownedReviewIds = [...reviewsById.keys()];

    const activeReviewIds = new Set<string>();
    if (ownedReviewIds.length > 0) {
      const activeResult = await this.database.prepare(`
        SELECT review_id
        FROM analysis_jobs
        WHERE owner_id = ? AND review_id IN (${inPlacePlaceholders(ownedReviewIds)})
          AND status IN ('queued', 'running')
        GROUP BY review_id
      `).bind(ownerId, ...ownedReviewIds).all<{ review_id: string }>();
      for (const row of resultRows(activeResult)) activeReviewIds.add(row.review_id);
    }

    const assignmentResult = await this.database.prepare(`
      SELECT id, title, updated_at
      FROM saved_assignments
      WHERE owner_id = ?
      ORDER BY updated_at DESC, id DESC
    `).bind(ownerId).all<AssignmentRow>();
    const latestAssignmentByTitle = new Map<string, AssignmentRow>();
    for (const assignment of resultRows(assignmentResult)) {
      const title = normalizeAssignmentTitle(assignment.title);
      if (!latestAssignmentByTitle.has(title)) latestAssignmentByTitle.set(title, assignment);
    }

    const matched: BatchReanalysisMatchedItem[] = [];
    const skippedItems: BatchReanalysisSkippedItem[] = [];
    for (const reviewId of reviewIds) {
      const row = reviewsById.get(reviewId);
      if (!row) {
        skippedItems.push(skipped(reviewId, "REVIEW_NOT_FOUND"));
        continue;
      }
      const review = publicReview(row);
      let skipCode: ReanalysisSkipCode | null = null;
      if (row.deleting_at !== null || Number(row.image_count) < 1) {
        skipCode = "REVIEW_UNAVAILABLE";
      } else if (!hasCurrentOcr(row.ocr_checkpoint, row.image_revision)) {
        skipCode = "OCR_NOT_CURRENT";
      } else if (activeReviewIds.has(reviewId)) {
        skipCode = "ANALYSIS_ACTIVE";
      } else if (!isAnalyzable(row.status)) {
        skipCode = "REVIEW_UNAVAILABLE";
      }
      if (skipCode) {
        skippedItems.push(skipped(reviewId, skipCode, review));
        continue;
      }
      const assignment = latestAssignmentByTitle.get(review.title);
      if (!assignment) {
        skippedItems.push(skipped(reviewId, "FRAMEWORK_NOT_FOUND", review));
        continue;
      }
      matched.push({
        reviewId,
        studentName: row.student_name,
        title: review.title,
        expectedRevision: row.revision,
        assignmentId: assignment.id,
        assignmentUpdatedAt: asIso(assignment.updated_at),
      });
    }
    return { matched, skipped: skippedItems };
  }

  async requestRevision(
    ownerId: string,
    reviewId: string,
    input: RevisionRequestInput,
  ): Promise<RevisionRequestResult> {
    const row = await this.readReview(ownerId, reviewId);
    this.assertRequestable(row, input.expectedRevision);
    const jobId = crypto.randomUUID();
    const now = Date.now();
    const teacherGuidance = formatRevisionTeacherGuidance(input.reason, input.changeRequest);
    const statements = this.requestStatements(ownerId, reviewId, input.expectedRevision, jobId, now, teacherGuidance);
    let outcomes: D1Outcome[];
    try {
      outcomes = await this.database.batch(statements) as D1Outcome[];
    } catch (error) {
      if (isActiveJobConflict(error)) throw new D1ReanalysisError("ANALYSIS_ACTIVE");
      throw error;
    }
    if (changes(outcomes[0]) !== 1 || changes(outcomes[1]) !== 1) {
      await this.assertRequestable(await this.readReview(ownerId, reviewId), input.expectedRevision);
      throw new D1ReanalysisError("REVISION_CONFLICT");
    }
    return { newlyQueued: true, job: queuedJob(jobId, reviewId, now) };
  }

  async commitBatch(
    ownerId: string,
    items: BatchReanalysisCommitItem[],
  ): Promise<BatchReanalysisCommitResult> {
    const submitted: BatchReanalysisCommitResult["submitted"] = [];
    const skippedItems: BatchReanalysisCommitResult["skipped"] = [];
    for (const item of items) {
      try {
        submitted.push(await this.commitOne(ownerId, item));
      } catch (error) {
        if (error instanceof D1ReanalysisError) {
          skippedItems.push(skipped(item.reviewId, error.code, error.review));
          continue;
        }
        throw new D1ReanalysisBatchError(submitted, error);
      }
    }
    return { submitted, skipped: skippedItems };
  }

  async markDispatchFailed(ownerId: string, jobIds: string[]): Promise<void> {
    if (jobIds.length === 0) return;
    const now = Date.now();
    const statements: D1ReanalysisStatement[] = [];
    for (const jobId of jobIds) {
      statements.push(this.database.prepare(`
        UPDATE analysis_jobs
        SET status = 'failed', error_code = 'QUEUE_DISPATCH_FAILED', finished_at = ?
        WHERE id = ? AND owner_id = ? AND status = 'queued'
      `).bind(now, jobId, ownerId));
      statements.push(this.database.prepare(`
        UPDATE reviews
        SET status = 'failed', analysis_run_id = NULL, updated_at = ?
        WHERE owner_id = ? AND analysis_run_id = ? AND status = 'analyzing'
          AND EXISTS (
            SELECT 1 FROM analysis_jobs
            WHERE id = ? AND owner_id = ? AND review_id = reviews.id
              AND status = 'failed' AND error_code = 'QUEUE_DISPATCH_FAILED'
              AND finished_at = ?
          )
      `).bind(now, ownerId, jobId, jobId, ownerId, now));
    }
    await this.database.batch(statements);
  }

  private async commitOne(ownerId: string, item: BatchReanalysisCommitItem) {
    const row = await this.readReview(ownerId, item.reviewId);
    const review = this.assertCommitRequestable(row, item);
    const assignments = await this.readAssignments(ownerId);
    const assignment = this.findAssignment(assignments, review.title);
    if (!assignment || assignment.id !== item.assignmentId || asIso(assignment.updated_at) !== item.expectedAssignmentUpdatedAt) {
      throw new D1ReanalysisError("FRAMEWORK_CHANGED", review);
    }
    if (assignment.config !== undefined) {
      assignmentConfigSchema.parse(JSON.parse(assignment.config));
    }
    const assignmentUpdatedAt = asEpoch(item.expectedAssignmentUpdatedAt);
    const jobId = crypto.randomUUID();
    const now = Date.now();
    const statements = this.commitStatements(
      ownerId,
      item,
      review.title,
      assignmentUpdatedAt,
      jobId,
      now,
    );
    let outcomes: D1Outcome[];
    try {
      outcomes = await this.database.batch(statements) as D1Outcome[];
    } catch (error) {
      if (isActiveJobConflict(error)) throw new D1ReanalysisError("ANALYSIS_ACTIVE", review);
      throw error;
    }
    if (changes(outcomes[0]) !== 1 || changes(outcomes[1]) !== 1) {
      await this.resolveCommitConflict(ownerId, item);
    }
    return { reviewId: item.reviewId, jobId, revision: row!.revision + 1 };
  }

  private async readReview(ownerId: string, reviewId: string): Promise<ReviewRow | null> {
    return this.database.prepare(`
      SELECT reviews.id, reviews.status, reviews.student_name, reviews.config,
        reviews.revision, reviews.image_revision, reviews.ocr_checkpoint, reviews.deleting_at,
        (SELECT COUNT(*) FROM review_images WHERE review_images.review_id = reviews.id) AS image_count,
        EXISTS (
          SELECT 1 FROM analysis_jobs
          WHERE analysis_jobs.review_id = reviews.id
            AND analysis_jobs.status IN ('queued', 'running')
        ) AS active_job
      FROM reviews
      WHERE reviews.id = ? AND reviews.owner_id = ?
    `).bind(reviewId, ownerId).first<ReviewRow>();
  }

  private async readAssignments(ownerId: string): Promise<AssignmentRow[]> {
    const result = await this.database.prepare(`
      SELECT id, title, config, updated_at
      FROM saved_assignments
      WHERE owner_id = ?
      ORDER BY updated_at DESC, id DESC
    `).bind(ownerId).all<AssignmentRow>();
    return resultRows(result);
  }

  private findAssignment(assignments: AssignmentRow[], title: string): AssignmentRow | undefined {
    return assignments.find((assignment) => normalizeAssignmentTitle(assignment.title) === title);
  }

  private assertRequestable(row: ReviewRow | null, expectedRevision: number): void {
    if (!row) throw new D1ReanalysisError("REVIEW_NOT_FOUND");
    if (row.deleting_at !== null) throw new D1ReanalysisError("REVIEW_UNAVAILABLE");
    if (row.revision !== expectedRevision) throw new D1ReanalysisError("REVISION_CONFLICT");
    if (Number(row.image_count) < 1) throw new D1ReanalysisError("REVIEW_UNAVAILABLE");
    if (!hasCurrentOcr(row.ocr_checkpoint, row.image_revision)) throw new D1ReanalysisError("OCR_NOT_CURRENT");
    if (hasActiveJob(row)) throw new D1ReanalysisError("ANALYSIS_ACTIVE");
    if (!isAnalyzable(row.status)) throw new D1ReanalysisError("REVIEW_UNAVAILABLE");
  }

  private assertCommitRequestable(row: ReviewRow | null, item: BatchReanalysisCommitItem): { studentName: string; title: string } {
    if (!row) throw new D1ReanalysisError("REVIEW_NOT_FOUND");
    const review = publicReview(row);
    if (row.deleting_at !== null) throw new D1ReanalysisError("REVIEW_UNAVAILABLE", review);
    if (row.revision !== item.expectedRevision) throw new D1ReanalysisError("REVISION_CONFLICT", review);
    if (Number(row.image_count) < 1) throw new D1ReanalysisError("REVIEW_UNAVAILABLE", review);
    if (!hasCurrentOcr(row.ocr_checkpoint, row.image_revision)) throw new D1ReanalysisError("OCR_NOT_CURRENT", review);
    if (hasActiveJob(row)) throw new D1ReanalysisError("ANALYSIS_ACTIVE", review);
    if (!isAnalyzable(row.status)) throw new D1ReanalysisError("REVIEW_UNAVAILABLE", review);
    return review;
  }

  private requestStatements(
    ownerId: string,
    reviewId: string,
    expectedRevision: number,
    jobId: string,
    now: number,
    teacherGuidance: string,
  ): D1ReanalysisStatement[] {
    return [
      this.database.prepare(`
        UPDATE reviews SET status = 'analyzing', analysis_run_id = ?, teacher_reviewed_at = NULL,
          pdf_filename = NULL, pdf_path = NULL, pdf_revision = NULL, exported_at = NULL, updated_at = ?
        WHERE id = ? AND owner_id = ? AND revision = ? AND deleting_at IS NULL
          AND status IN ('draft', 'ready_for_review', 'exported', 'failed')
          AND EXISTS (SELECT 1 FROM review_images WHERE review_id = reviews.id)
          AND json_valid(ocr_checkpoint) = 1
          AND json_extract(ocr_checkpoint, '$.sourceRevision') = image_revision
          AND NOT EXISTS (
            SELECT 1 FROM analysis_jobs
            WHERE review_id = reviews.id AND status IN ('queued', 'running')
          )
      `).bind(jobId, now, reviewId, ownerId, expectedRevision),
      this.database.prepare(`
        INSERT INTO analysis_jobs (
          id, review_id, owner_id, mode, status, attempt, available_at, lease_expires_at,
          progress_stage, error_code, message, teacher_guidance, created_at, started_at, finished_at
        )
        SELECT ?, reviews.id, reviews.owner_id, 'content_only', 'queued', 0, ?, NULL,
          'queued', NULL, NULL, ?, ?, NULL, NULL
        FROM reviews
        WHERE reviews.id = ? AND reviews.owner_id = ? AND reviews.analysis_run_id = ?
      `).bind(jobId, now, teacherGuidance, now, reviewId, ownerId, jobId),
    ];
  }

  private commitStatements(
    ownerId: string,
    item: BatchReanalysisCommitItem,
    title: string,
    assignmentUpdatedAt: number,
    jobId: string,
    now: number,
  ): D1ReanalysisStatement[] {
    return [
      this.database.prepare(`
        UPDATE reviews SET
          config = (
            SELECT config FROM saved_assignments
            WHERE id = ? AND owner_id = ? AND updated_at = ?
              AND TRIM(title) = TRIM(?)
            LIMIT 1
          ),
          revision = revision + 1, status = 'analyzing', analysis_run_id = ?,
          teacher_reviewed_at = NULL, pdf_filename = NULL, pdf_path = NULL,
          pdf_revision = NULL, exported_at = NULL, updated_at = ?
        WHERE id = ? AND owner_id = ? AND revision = ? AND deleting_at IS NULL
          AND status IN ('draft', 'ready_for_review', 'exported', 'failed')
          AND EXISTS (SELECT 1 FROM review_images WHERE review_id = reviews.id)
          AND json_valid(ocr_checkpoint) = 1
          AND json_extract(ocr_checkpoint, '$.sourceRevision') = image_revision
          AND NOT EXISTS (
            SELECT 1 FROM analysis_jobs
            WHERE review_id = reviews.id AND status IN ('queued', 'running')
          )
          AND EXISTS (
            SELECT 1 FROM saved_assignments
            WHERE id = ? AND owner_id = ? AND updated_at = ?
              AND TRIM(title) = TRIM(?)
          )
      `).bind(
        item.assignmentId,
        ownerId,
        assignmentUpdatedAt,
        title,
        jobId,
        now,
        item.reviewId,
        ownerId,
        item.expectedRevision,
        item.assignmentId,
        ownerId,
        assignmentUpdatedAt,
        title,
      ),
      this.database.prepare(`
        INSERT INTO analysis_jobs (
          id, review_id, owner_id, mode, status, attempt, available_at, lease_expires_at,
          progress_stage, error_code, message, teacher_guidance, created_at, started_at, finished_at
        )
        SELECT ?, reviews.id, reviews.owner_id, 'content_only', 'queued', 0, ?, NULL,
          'queued', NULL, NULL, NULL, ?, NULL, NULL
        FROM reviews
        WHERE reviews.id = ? AND reviews.owner_id = ? AND reviews.analysis_run_id = ?
      `).bind(jobId, now, now, item.reviewId, ownerId, jobId),
    ];
  }

  private async resolveCommitConflict(ownerId: string, item: BatchReanalysisCommitItem): Promise<never> {
    const row = await this.readReview(ownerId, item.reviewId);
    this.assertCommitRequestable(row, item);
    const review = publicReview(row!);
    const assignment = this.findAssignment(await this.readAssignments(ownerId), review.title);
    if (!assignment || assignment.id !== item.assignmentId || asIso(assignment.updated_at) !== item.expectedAssignmentUpdatedAt) {
      throw new D1ReanalysisError("FRAMEWORK_CHANGED", review);
    }
    throw new D1ReanalysisError("REVISION_CONFLICT", review);
  }
}
