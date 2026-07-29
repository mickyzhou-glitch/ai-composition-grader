const stages = new Set(["queued", "reading_images", "generating_review", "validating_result", "saving_result"]);
const statuses = new Set(["queued", "running", "succeeded", "failed", "canceled"]);

interface JobRow {
  id: string;
  review_id: string;
  status: string;
  progress_stage: string;
  error_code: string | null;
  created_at: number;
  finished_at: number | null;
}

function view(row: JobRow) {
  if (!statuses.has(row.status) || !stages.has(row.progress_stage)) throw new TypeError("Invalid analysis job");
  return {
    id: row.id, reviewId: row.review_id, status: row.status, progressStage: row.progress_stage,
    message: row.status === "failed" ? row.error_code === "AI_SETTINGS_INCOMPLETE" ? "请联系管理员检查 AI 服务设置后再试" : "AI 服务暂时不可用，请稍后重新分析" : row.status === "canceled" ? "作文已删除或已到期，分析已取消" : null,
    createdAt: new Date(row.created_at).toISOString(), finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
  };
}

export class D1AnalysisJobs {
  constructor(private readonly database: D1Database) {}

  async enqueue(ownerId: string, reviewId: string, teacherGuidance?: unknown): Promise<{ job: unknown; newlyQueued: boolean }> {
    const guidance = teacherGuidance === undefined ? null : typeof teacherGuidance === "string" && teacherGuidance.trim().length <= 1000 ? teacherGuidance.trim() || null : invalidGuidance();
    const review = await this.database.prepare(`
      SELECT reviews.id, reviews.revision, reviews.expires_at, COUNT(review_images.id) AS image_count
      FROM reviews LEFT JOIN review_images ON review_images.review_id = reviews.id
      WHERE reviews.id = ? AND reviews.owner_id = ? AND reviews.deleting_at IS NULL GROUP BY reviews.id
    `).bind(reviewId, ownerId).first<{ id: string; revision: number; expires_at: number | null; image_count: number }>();
    if (!review) return { job: null, newlyQueued: false };
    if (review.expires_at !== null && review.expires_at <= Date.now()) throw new Error("REVIEW_UNAVAILABLE");
    if (review.image_count < 1 || review.image_count > 4) throw new Error("IMAGES_REQUIRED");
    const existing = await this.latest(ownerId, reviewId);
    if (existing && (existing as { status: string }).status === "queued") return { job: existing, newlyQueued: false };
    const id = crypto.randomUUID();
    const now = Date.now();
    await this.database.batch([
      this.database.prepare(`
        INSERT INTO analysis_jobs (id, review_id, owner_id, status, attempt, available_at, lease_expires_at, progress_stage, error_code, message, teacher_guidance, created_at, started_at, finished_at)
        VALUES (?, ?, ?, 'queued', 0, ?, NULL, 'queued', NULL, NULL, ?, ?, NULL, NULL)
      `).bind(id, reviewId, ownerId, now, guidance, now),
      this.database.prepare(`UPDATE reviews SET status = 'analyzing', analysis_run_id = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND revision = ?`).bind(id, now, reviewId, ownerId, review.revision),
    ]);
    const job = await this.byId(ownerId, id);
    return { job, newlyQueued: true };
  }

  async latest(ownerId: string, reviewId: string): Promise<unknown | null> {
    const row = await this.database.prepare(`
      SELECT id, review_id, status, progress_stage, error_code, created_at, finished_at FROM analysis_jobs
      WHERE owner_id = ? AND review_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).bind(ownerId, reviewId).first<JobRow>();
    return row ? view(row) : null;
  }

  private async byId(ownerId: string, id: string): Promise<unknown> {
    const row = await this.database.prepare(`SELECT id, review_id, status, progress_stage, error_code, created_at, finished_at FROM analysis_jobs WHERE id = ? AND owner_id = ?`).bind(id, ownerId).first<JobRow>();
    if (!row) throw new Error("JOB_NOT_FOUND");
    return view(row);
  }
}

function invalidGuidance(): never { throw new TypeError("teacherGuidance must be at most 1000 characters"); }
