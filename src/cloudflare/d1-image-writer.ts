import { MAX_REVIEW_IMAGES, PRIVACY_NOTICE_VERSION } from "../domain/contracts";

export interface CloudImageInput {
  originalName: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
  path: string;
}

export class D1ImageWriter {
  constructor(private readonly database: D1Database) {}

  async replace(ownerId: string, reviewId: string, expectedRevision: number, images: CloudImageInput[], privacyConfirmed: boolean): Promise<{ images: Array<{ id: number; position: number }>; revision: number }> {
    if (images.length < 1 || images.length > MAX_REVIEW_IMAGES) throw new Error("IMAGE_COUNT_INVALID");
    if (!privacyConfirmed) throw new Error("PRIVACY_CONFIRMATION_REQUIRED");
    const review = await this.database.prepare("SELECT revision FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL").bind(reviewId, ownerId).first<{ revision: number }>();
    if (!review) throw new Error("REVIEW_NOT_FOUND");
    if (review.revision !== expectedRevision) throw new Error("REVISION_CONFLICT");
    const now = Date.now();
    const updated = await this.database.prepare(`
      UPDATE reviews SET status = 'draft', report = NULL, revision = revision + 1, analysis_run_id = NULL,
        pdf_filename = NULL, pdf_path = NULL, pdf_revision = NULL, exported_at = NULL, expires_at = COALESCE(expires_at, ?),
        privacy_consent_version = COALESCE(privacy_consent_version, ?), privacy_consented_at = COALESCE(privacy_consented_at, ?), updated_at = ?
      WHERE id = ? AND owner_id = ? AND revision = ?
    `).bind(now + 30 * 24 * 60 * 60_000, PRIVACY_NOTICE_VERSION, now, now, reviewId, ownerId, expectedRevision).run();
    if (updated.meta.changes === 0) throw new Error("REVISION_CONFLICT");
    await this.database.batch([
      this.database.prepare("DELETE FROM annotations WHERE review_id = ?").bind(reviewId),
      this.database.prepare("DELETE FROM review_images WHERE review_id = ?").bind(reviewId),
      ...images.map((image, position) => this.database.prepare(`
        INSERT INTO review_images (review_id, page_index, path, position, original_name, mime_type, original_path, annotation_path, ai_path, width, height, rotation, crop, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
      `).bind(reviewId, position, image.path, position, image.originalName, image.mimeType, image.path, image.path, image.path, image.width, image.height, now)),
    ]);
    const { results = [] } = await this.database.prepare("SELECT id, position FROM review_images WHERE review_id = ? ORDER BY position").bind(reviewId).all<{ id: number; position: number }>();
    return { images: results, revision: expectedRevision + 1 };
  }
}
