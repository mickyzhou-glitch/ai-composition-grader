import { MAX_REVIEW_IMAGES, PRIVACY_NOTICE_VERSION } from "../domain/contracts";

export interface CloudImageInput {
  originalName: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  path: string;
}

export interface CloudImageReplaceResult {
  images: Array<{ id: number; position: number }>;
  revision: number;
  replacedPaths: string[];
}

export class D1ImageWriter {
  constructor(private readonly database: D1Database) {}

  async replace(
    ownerId: string,
    reviewId: string,
    expectedRevision: number,
    images: CloudImageInput[],
    privacyConfirmed: boolean,
  ): Promise<CloudImageReplaceResult> {
    if (images.length < 1 || images.length > MAX_REVIEW_IMAGES) throw new Error("IMAGE_COUNT_INVALID");
    if (!privacyConfirmed) throw new Error("PRIVACY_CONFIRMATION_REQUIRED");
    const review = await this.database.prepare("SELECT revision FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL").bind(reviewId, ownerId).first<{ revision: number }>();
    if (!review) throw new Error("REVIEW_NOT_FOUND");
    if (review.revision !== expectedRevision) throw new Error("REVISION_CONFLICT");

    const previousRows = await this.database.prepare(
      "SELECT original_path, annotation_path, ai_path FROM review_images WHERE review_id = ?",
    ).bind(reviewId).all<{ original_path?: string | null; annotation_path?: string | null; ai_path?: string | null }>();
    const replacedPaths = [...new Set(
      (previousRows.results ?? []).flatMap((row) => [row.original_path, row.annotation_path, row.ai_path])
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    )];

    const now = Date.now();
    const nextRevision = expectedRevision + 1;
    const replacedGuard = `EXISTS (
      SELECT 1 FROM reviews
      WHERE id = ? AND owner_id = ? AND deleting_at IS NULL AND revision = ? AND updated_at = ?
    )`;
    const guardBindings = [reviewId, ownerId, nextRevision, now];
    const outcomes = await this.database.batch([
      this.database.prepare(`
        UPDATE reviews SET status = 'draft', report = NULL, revision = revision + 1,
          image_revision = image_revision + 1, ocr_checkpoint = NULL, report_ocr_revision = NULL,
          has_report = 0, summary_grade = NULL, summary_is_legacy = 0, summary_diagnostics = NULL,
          ocr_revision_cached = NULL, export_ready_version = NULL,
          export_blocked_reason = '批改报告尚未完成',
          summary_state_key = CAST(revision + 1 AS TEXT) || ':' || CAST(image_revision + 1 AS TEXT) || ':-1:-1:draft:-1',
          analysis_run_id = NULL, teacher_reviewed_at = NULL,
          pdf_filename = NULL, pdf_path = NULL, pdf_revision = NULL, exported_at = NULL,
          privacy_consent_version = COALESCE(privacy_consent_version, ?), privacy_consented_at = COALESCE(privacy_consented_at, ?), updated_at = ?
        WHERE id = ? AND owner_id = ? AND deleting_at IS NULL AND revision = ?
      `).bind(PRIVACY_NOTICE_VERSION, now, now, reviewId, ownerId, expectedRevision),
      this.database.prepare(`
        UPDATE analysis_jobs SET status = 'canceled', finished_at = ?
        WHERE review_id = ? AND owner_id = ? AND status IN ('queued', 'running') AND ${replacedGuard}
      `).bind(now, reviewId, ownerId, ...guardBindings),
      this.database.prepare(`DELETE FROM annotations WHERE review_id = ? AND ${replacedGuard}`).bind(reviewId, ...guardBindings),
      this.database.prepare(`DELETE FROM review_images WHERE review_id = ? AND ${replacedGuard}`).bind(reviewId, ...guardBindings),
      ...images.map((image, position) => this.database.prepare(`
        INSERT INTO review_images (review_id, page_index, path, position, original_name, mime_type, original_path, annotation_path, ai_path, width, height, rotation, crop, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ? WHERE ${replacedGuard}
      `).bind(reviewId, position, image.path, position, image.originalName, image.mimeType, image.path, image.path, image.path, image.width, image.height, now, ...guardBindings)),
    ]);
    if ((outcomes[0]?.meta.changes ?? 0) !== 1) throw new Error("REVISION_CONFLICT");

    const { results = [] } = await this.database.prepare("SELECT id, position FROM review_images WHERE review_id = ? ORDER BY position").bind(reviewId).all<{ id: number; position: number }>();
    return { images: results, revision: nextRevision, replacedPaths };
  }
}
