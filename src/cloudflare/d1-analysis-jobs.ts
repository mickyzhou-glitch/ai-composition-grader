import { listD1StandingOpinions } from "./d1-grading-opinions";
import { guidanceWithStandingOpinions } from "../grading-opinions/standing-guidance";
import { analysisInterruptedMessage } from "./analysis-failure";
import { MAX_ANALYSIS_TEACHER_GUIDANCE_CHARS } from "../reanalysis/contracts";
import { analysisModeForCheckpoint } from "../ocr/analysis-mode";
import { ocrCheckpointSchema, type OcrCheckpoint } from "../ocr/contracts";
import type { AnalysisJobMode } from "./cloud-analysis-pipeline";

// A full run has at most three sequential 180-second AI requests (OCR,
// review, and one repair). Leave a minute for storage and validation.
export const MAX_CLOUD_ANALYSIS_RUN_MS = 10 * 60_000;

const stages = new Set(["queued", "reading_images", "saving_ocr", "generating_review", "mapping_annotations", "validating_result", "saving_result"]);
const statuses = new Set(["queued", "running", "succeeded", "failed", "canceled"]);

interface JobRow {
  id: string;
  review_id: string;
  mode?: string;
  status: string;
  progress_stage: string;
  error_code: string | null;
  created_at: number;
  started_at?: number | null;
  finished_at: number | null;
}

export class D1AnalysisEnqueueConflictError extends Error {
  readonly code = "ANALYSIS_CONFLICT";
  readonly status = 409;

  constructor() {
    super("ANALYSIS_CONFLICT");
    this.name = "D1AnalysisEnqueueConflictError";
  }
}

function view(row: JobRow) {
  if (!statuses.has(row.status) || !stages.has(row.progress_stage)) throw new TypeError("Invalid analysis job");
  const failedMessage = row.error_code === "AI_SETTINGS_INCOMPLETE"
    ? "请联系管理员检查 AI 服务设置后再试"
    : row.error_code === "ANALYSIS_TIMEOUT" || row.error_code === "ANALYSIS_ABORTED"
      ? analysisInterruptedMessage(row.progress_stage)
    : row.error_code?.startsWith("AI_INVALID_RESPONSE_rewritten_essay_chars_")
      ? "AI 生成的范文未满足指定字数，请重新生成整篇批改"
    : row.error_code?.startsWith("AI_INVALID_RESPONSE_rewritten_essay_paragraph_count_")
      ? "AI 生成的范文未满足指定段数，请重新生成整篇批改"
    : row.error_code === "AI_INVALID_RESPONSE" || row.error_code?.startsWith("AI_INVALID_RESPONSE_")
      ? "AI 返回格式异常，请重新分析"
    : row.error_code === "AI_UPSTREAM_HTTP_400"
      ? "AI 服务拒绝了图片批改请求，请检查模型是否支持视觉输入"
    : row.error_code?.startsWith("AI_UPSTREAM_HTTP_402")
      ? "AI 内容批改服务额度不足，请联系管理员充值后重试"
    : row.error_code === "AI_UPSTREAM_HTTP_401" || row.error_code?.startsWith("AI_UPSTREAM_HTTP_401_")
      ? "AI 服务拒绝了访问密钥，请在设置中重新保存并测试"
      : row.error_code === "AI_UPSTREAM_HTTP_403" || row.error_code?.startsWith("AI_UPSTREAM_HTTP_403_")
        ? "AI 服务拒绝了图片批改请求，请确认当前模型已开通视觉输入权限"
        : row.error_code?.startsWith("AI_UPSTREAM_HTTP_")
          ? "AI 服务暂时拒绝了图片批改请求，请稍后重试"
          : "AI 服务暂时不可用，请稍后重新分析";
  return {
    id: row.id, reviewId: row.review_id, mode: row.mode === "content_only" ? "content_only" : "full", status: row.status, progressStage: row.progress_stage,
    message: row.status === "failed" ? failedMessage : row.status === "canceled" ? "作文已删除或已到期，分析已取消" : null,
    createdAt: new Date(row.created_at).toISOString(), finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
  };
}

export class D1AnalysisJobs {
  constructor(private readonly database: D1Database) {}

  async recoverExpired(
    now = Date.now(),
    scope?: { ownerId: string; reviewId: string },
  ): Promise<number> {
    const expired = `analysis_jobs.status = 'running'
      AND COALESCE(analysis_jobs.started_at, analysis_jobs.created_at) <= ?
      ${scope ? "AND analysis_jobs.owner_id = ? AND analysis_jobs.review_id = ?" : ""}`;
    const bindings = [now - MAX_CLOUD_ANALYSIS_RUN_MS, ...(scope ? [scope.ownerId, scope.reviewId] : [])];
    // D1 batch is atomic. Only release the review still owned by this job;
    // reports, OCR, annotations, and review revisions stay untouched.
    const results = await this.database.batch([
      this.database.prepare(`
        UPDATE reviews SET status = 'failed', analysis_run_id = NULL, updated_at = ?
        WHERE status = 'analyzing' AND EXISTS (
          SELECT 1 FROM analysis_jobs WHERE ${expired}
            AND analysis_jobs.id = reviews.analysis_run_id
            AND analysis_jobs.review_id = reviews.id AND analysis_jobs.owner_id = reviews.owner_id
        )
      `).bind(now, ...bindings),
      this.database.prepare(`
        UPDATE analysis_jobs SET status = 'failed', error_code = 'ANALYSIS_TIMEOUT',
          lease_expires_at = NULL, finished_at = ? WHERE ${expired}
      `).bind(now, ...bindings),
    ]);
    return results[1]?.meta.changes ?? 0;
  }

  async enqueue(
    ownerId: string,
    reviewId: string,
    input?: unknown,
  ): Promise<{ job: unknown; newlyQueued: boolean }> {
    const options = normalizeEnqueueInput(input);
    const guidance = options.teacherGuidance;
    const mode = options.mode;
    const existing = await this.active(ownerId, reviewId);
    const review = await this.database.prepare(`
      SELECT reviews.id, reviews.revision, reviews.image_revision, reviews.ocr_checkpoint,
        reviews.status, reviews.teacher_reviewed_at,
        COUNT(review_images.id) AS image_count
      FROM reviews LEFT JOIN review_images ON review_images.review_id = reviews.id
      WHERE reviews.id = ? AND reviews.owner_id = ? AND reviews.deleting_at IS NULL GROUP BY reviews.id
    `).bind(reviewId, ownerId).first<{
      id: string;
      revision: number;
      image_revision: number;
      ocr_checkpoint: string | null;
      status: string;
      teacher_reviewed_at: number | null;
      image_count: number;
    }>();
    if (!review) return { job: null, newlyQueued: false };
    if (existing) return { job: existing, newlyQueued: false };
    if (review.image_count < 1 || review.image_count > 4) throw new Error("IMAGES_REQUIRED");
    if (mode === "content_only") {
      const parsed = parseOcr(review.ocr_checkpoint);
      if (!parsed) {
        analysisModeForCheckpoint(mode, null);
        throw new TypeError("unreachable");
      }
      if (parsed.sourceRevision !== review.image_revision) throw new Error("OCR_NOT_FOUND");
      const checkpoint = parsed;
      analysisModeForCheckpoint(mode, checkpoint);
    }
    const storedGuidance = guidanceWithStandingOpinions(
      guidance,
      await listD1StandingOpinions(this.database, ownerId),
    );
    const id = crypto.randomUUID();
    const now = Date.now();
    let outcomes: D1Result<unknown>[];
    try {
      outcomes = await this.database.batch([
        this.database.prepare(`
          UPDATE reviews SET status = 'analyzing', analysis_run_id = ?,
            teacher_reviewed_at = NULL, updated_at = ?
          WHERE id = ? AND owner_id = ? AND deleting_at IS NULL AND revision = ?
            AND analysis_run_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM analysis_jobs
              WHERE review_id = ? AND status IN ('queued', 'running')
            )
        `).bind(id, now, reviewId, ownerId, review.revision, reviewId),
        this.database.prepare(`
          INSERT INTO analysis_jobs (
            id, review_id, owner_id, mode, status, attempt, available_at,
            lease_expires_at, progress_stage, error_code, message,
            teacher_guidance, created_at, started_at, finished_at
          )
          SELECT ?, ?, ?, ?, 'queued', 0, ?, NULL, 'queued', NULL, NULL, ?, ?, NULL, NULL
          WHERE EXISTS (
            SELECT 1 FROM reviews
            WHERE id = ? AND owner_id = ? AND deleting_at IS NULL
              AND revision = ? AND analysis_run_id = ? AND status = 'analyzing'
          )
        `).bind(
          id, reviewId, ownerId, mode, now, storedGuidance, now,
          reviewId, ownerId, review.revision, id,
        ),
      ]);
    } catch (error) {
      const raced = await this.active(ownerId, reviewId);
      if (raced) return { job: raced, newlyQueued: false };
      throw error;
    }
    if (
      (outcomes[0]?.meta.changes ?? 0) !== 1
      || (outcomes[1]?.meta.changes ?? 0) !== 1
    ) {
      if (
        (outcomes[0]?.meta.changes ?? 0) === 1
        && (outcomes[1]?.meta.changes ?? 0) !== 1
      ) {
        await this.database.prepare(`
          UPDATE reviews SET status = ?, analysis_run_id = NULL,
            teacher_reviewed_at = ?, updated_at = ?
          WHERE id = ? AND owner_id = ? AND analysis_run_id = ? AND revision = ?
        `).bind(
          review.status,
          review.teacher_reviewed_at,
          Date.now(),
          reviewId,
          ownerId,
          id,
          review.revision,
        ).run();
      }
      const raced = await this.active(ownerId, reviewId);
      if (raced) return { job: raced, newlyQueued: false };
      throw new D1AnalysisEnqueueConflictError();
    }
    const job = await this.byId(ownerId, id);
    return { job, newlyQueued: true };
  }

  private async active(ownerId: string, reviewId: string): Promise<unknown | null> {
    const query = this.database.prepare(`
      SELECT id, review_id, mode, status, progress_stage, error_code, created_at, started_at, finished_at
      FROM analysis_jobs
      WHERE owner_id = ? AND review_id = ? AND status IN ('queued', 'running')
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).bind(ownerId, reviewId);
    let row = await query.first<JobRow>();
    if (row && isExpired(row)) {
      await this.recoverExpired(Date.now(), { ownerId, reviewId });
      row = await query.first<JobRow>();
    }
    return row ? view(row) : null;
  }

  async latest(ownerId: string, reviewId: string): Promise<unknown | null> {
    const query = this.database.prepare(`
      SELECT id, review_id, mode, status, progress_stage, error_code, created_at, started_at, finished_at FROM analysis_jobs
      WHERE owner_id = ? AND review_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).bind(ownerId, reviewId);
    let row = await query.first<JobRow>();
    if (row && isExpired(row)) {
      await this.recoverExpired(Date.now(), { ownerId, reviewId });
      row = await query.first<JobRow>();
    }
    return row ? view(row) : null;
  }

  private async byId(ownerId: string, id: string): Promise<unknown> {
    const row = await this.database.prepare(`SELECT id, review_id, mode, status, progress_stage, error_code, created_at, finished_at FROM analysis_jobs WHERE id = ? AND owner_id = ?`).bind(id, ownerId).first<JobRow>();
    if (!row) throw new Error("JOB_NOT_FOUND");
    return view(row);
  }
}

function isExpired(row: JobRow): boolean {
  return row.status === "running"
    && (row.started_at ?? row.created_at) <= Date.now() - MAX_CLOUD_ANALYSIS_RUN_MS;
}

function normalizeEnqueueInput(input: unknown): { mode: AnalysisJobMode; teacherGuidance: string | null } {
  const object = typeof input === "object" && input !== null ? input as Record<string, unknown> : null;
  const mode = object?.mode === undefined ? "full" : object.mode;
  if (mode !== "full" && mode !== "content_only") throw new TypeError("Invalid analysis mode");
  const rawGuidance = object ? object.teacherGuidance : input;
  if (rawGuidance === undefined || rawGuidance === null || rawGuidance === "") {
    return { mode, teacherGuidance: null };
  }
  if (
    typeof rawGuidance !== "string"
    || rawGuidance.trim().length > MAX_ANALYSIS_TEACHER_GUIDANCE_CHARS
  ) {
    throw new TypeError(
      `teacherGuidance must be at most ${MAX_ANALYSIS_TEACHER_GUIDANCE_CHARS} characters`,
    );
  }
  return { mode, teacherGuidance: rawGuidance.trim() || null };
}

function parseOcr(raw: string | null | undefined): OcrCheckpoint | null {
  if (!raw) return null;
  try {
    const parsed = ocrCheckpointSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
