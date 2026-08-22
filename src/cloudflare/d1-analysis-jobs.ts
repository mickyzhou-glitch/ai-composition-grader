import { MAX_ANALYSIS_TEACHER_GUIDANCE_CHARS } from "../reanalysis/contracts";
import type { AnalysisJobMode } from "./cloud-analysis-pipeline";

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
  finished_at: number | null;
}

function view(row: JobRow) {
  if (!statuses.has(row.status) || !stages.has(row.progress_stage)) throw new TypeError("Invalid analysis job");
  const failedMessage = row.error_code === "AI_SETTINGS_INCOMPLETE"
    ? "请联系管理员检查 AI 服务设置后再试"
    : row.error_code === "AI_INVALID_RESPONSE" || row.error_code?.startsWith("AI_INVALID_RESPONSE_")
      ? "AI 返回格式异常，请重新分析"
    : row.error_code === "AI_UPSTREAM_HTTP_400"
      ? "AI 服务拒绝了图片批改请求，请检查模型是否支持视觉输入"
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

  async enqueue(
    ownerId: string,
    reviewId: string,
    input?: unknown,
  ): Promise<{ job: unknown; newlyQueued: boolean }> {
    const options = normalizeEnqueueInput(input);
    const guidance = options.teacherGuidance;
    const mode = options.mode;
    const review = await this.database.prepare(`
      SELECT reviews.id, reviews.revision, reviews.image_revision, reviews.ocr_checkpoint,
        COUNT(review_images.id) AS image_count
      FROM reviews LEFT JOIN review_images ON review_images.review_id = reviews.id
      WHERE reviews.id = ? AND reviews.owner_id = ? AND reviews.deleting_at IS NULL GROUP BY reviews.id
    `).bind(reviewId, ownerId).first<{
      id: string;
      revision: number;
      image_revision: number;
      ocr_checkpoint: string | null;
      image_count: number;
    }>();
    if (!review) return { job: null, newlyQueued: false };
    if (review.image_count < 1 || review.image_count > 4) throw new Error("IMAGES_REQUIRED");
    if (mode === "content_only" && !hasCurrentOcr(review.ocr_checkpoint, review.image_revision)) {
      throw new Error("OCR_NOT_FOUND");
    }
    const existing = await this.latest(ownerId, reviewId);
    if (existing && (existing as { status: string }).status === "queued") return { job: existing, newlyQueued: false };
    const id = crypto.randomUUID();
    const now = Date.now();
    await this.database.batch([
      this.database.prepare(`
        INSERT INTO analysis_jobs (id, review_id, owner_id, mode, status, attempt, available_at, lease_expires_at, progress_stage, error_code, message, teacher_guidance, created_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, 'queued', 0, ?, NULL, 'queued', NULL, NULL, ?, ?, NULL, NULL)
      `).bind(id, reviewId, ownerId, mode, now, guidance, now),
      this.database.prepare(`UPDATE reviews SET status = 'analyzing', analysis_run_id = ?, teacher_reviewed_at = NULL, updated_at = ? WHERE id = ? AND owner_id = ? AND revision = ?`).bind(id, now, reviewId, ownerId, review.revision),
    ]);
    const job = await this.byId(ownerId, id);
    return { job, newlyQueued: true };
  }

  async latest(ownerId: string, reviewId: string): Promise<unknown | null> {
    const row = await this.database.prepare(`
      SELECT id, review_id, mode, status, progress_stage, error_code, created_at, finished_at FROM analysis_jobs
      WHERE owner_id = ? AND review_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).bind(ownerId, reviewId).first<JobRow>();
    return row ? view(row) : null;
  }

  private async byId(ownerId: string, id: string): Promise<unknown> {
    const row = await this.database.prepare(`SELECT id, review_id, mode, status, progress_stage, error_code, created_at, finished_at FROM analysis_jobs WHERE id = ? AND owner_id = ?`).bind(id, ownerId).first<JobRow>();
    if (!row) throw new Error("JOB_NOT_FOUND");
    return view(row);
  }
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

function hasCurrentOcr(raw: string | null | undefined, imageRevision: number): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { sourceRevision?: unknown };
    return parsed.sourceRevision === imageRevision;
  } catch {
    return false;
  }
}
