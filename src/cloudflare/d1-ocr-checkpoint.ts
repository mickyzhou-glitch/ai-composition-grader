import type { VisionOcrResult } from "../ai/vision-ocr-adapter";
import {
  createOcrCheckpointV2,
  editOcrParagraphTexts,
  OcrCheckpointError,
  publicOcrView,
  readStoredOcrCheckpoint,
  type OcrCheckpoint,
  type OcrCheckpointV2,
  type OcrParagraphTextEdit,
  type PublicOcrView,
} from "../ocr/contracts";

export { OcrCheckpointError } from "../ocr/contracts";

interface OcrRow {
  image_revision: number;
  ocr_checkpoint: string | null;
}

export class D1OcrCheckpointRepository {
  constructor(private readonly database: D1Database) {}

  async readInternal(ownerId: string, reviewId: string): Promise<OcrCheckpoint | null> {
    const row = await this.database.prepare(
      "SELECT image_revision, ocr_checkpoint FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL",
    ).bind(reviewId, ownerId).first<OcrRow>();
    if (!row?.ocr_checkpoint) return null;
    return readStoredOcrCheckpoint(row.ocr_checkpoint, row.image_revision);
  }

  async saveRecognized(
    ownerId: string,
    reviewId: string,
    sourceRevision: number,
    result: VisionOcrResult,
    analysisRunId?: string,
  ): Promise<OcrCheckpointV2> {
    const checkpoint = createOcrCheckpointV2({
      sourceRevision,
      pages: result.pages,
      paragraphs: result.paragraphs,
    });
    const update = await this.database.prepare(`
      UPDATE reviews SET ocr_checkpoint = ?, report_ocr_revision = NULL,
        ocr_revision_cached = 0, export_ready_version = NULL,
        summary_state_key = CASE WHEN summary_state_key IS NULL THEN NULL ELSE (CAST(revision AS TEXT) || ':' || CAST(image_revision AS TEXT) || ':0:-1:' || status || ':' || CAST(COALESCE(teacher_reviewed_at, -1) AS TEXT)) END
      WHERE id = ? AND owner_id = ? AND deleting_at IS NULL AND image_revision = ?
        ${analysisRunId === undefined ? "" : `AND analysis_run_id = ? AND EXISTS (
          SELECT 1 FROM analysis_jobs WHERE id = ? AND status = 'running'
        )`}
    `).bind(
      JSON.stringify(checkpoint), reviewId, ownerId, sourceRevision,
      ...(analysisRunId === undefined ? [] : [analysisRunId, analysisRunId]),
    ).run();
    if (update.meta.changes === 0) throw new OcrCheckpointError("IMAGE_REVISION_CONFLICT", 409);
    return checkpoint;
  }

  async editParagraphTexts(
    ownerId: string,
    reviewId: string,
    expectedOcrRevision: number,
    edits: OcrParagraphTextEdit[],
  ): Promise<OcrCheckpointV2> {
    const current = await this.readInternal(ownerId, reviewId);
    if (!current) throw new OcrCheckpointError("OCR_NOT_FOUND", 404);
    const next = editOcrParagraphTexts(
      current,
      expectedOcrRevision,
      edits,
      new Date().toISOString(),
    );
    const result = await this.database.prepare(`
      UPDATE reviews SET ocr_checkpoint = ?,
        ocr_revision_cached = ?,
        export_ready_version = NULL,
        export_blocked_reason = '批改报告基于旧版识别原文，请重新生成批改',
        summary_state_key = CASE WHEN summary_state_key IS NULL THEN NULL ELSE (CAST(revision AS TEXT) || ':' || CAST(image_revision AS TEXT) || ':' || CAST(CAST(? AS INTEGER) AS TEXT) || ':' || CAST(COALESCE(report_ocr_revision, -1) AS TEXT) || ':' || status || ':' || CAST(COALESCE(teacher_reviewed_at, -1) AS TEXT)) END
      WHERE id = ? AND owner_id = ? AND deleting_at IS NULL AND image_revision = ?
        AND json_extract(ocr_checkpoint, '$.ocrRevision') = ?
    `).bind(
      JSON.stringify(next), next.ocrRevision, next.ocrRevision, reviewId, ownerId, current.sourceRevision, expectedOcrRevision,
    ).run();
    if (result.meta.changes === 0) throw new OcrCheckpointError("OCR_REVISION_CONFLICT", 409);
    return next;
  }

  static publicView(checkpoint: OcrCheckpoint): PublicOcrView {
    return publicOcrView(checkpoint);
  }
}
