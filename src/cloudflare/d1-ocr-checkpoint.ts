import { z } from "zod";

import { ocrCheckpointSchema, type OcrCheckpoint, type OcrPage } from "../ocr/contracts";

const editPagesSchema = z.array(z.object({
  pageIndex: z.number().int().nonnegative(),
  text: z.string(),
}).strict()).min(1).max(4);

interface OcrRow {
  image_revision: number;
  ocr_checkpoint: string | null;
}

export class OcrCheckpointError extends Error {
  constructor(
    readonly code: "OCR_NOT_FOUND" | "OCR_REVISION_CONFLICT" | "IMAGE_REVISION_CONFLICT",
    readonly status: 404 | 409,
  ) {
    super(code);
    this.name = "OcrCheckpointError";
  }
}

export class D1OcrCheckpointRepository {
  constructor(private readonly database: D1Database) {}

  async readInternal(ownerId: string, reviewId: string): Promise<OcrCheckpoint | null> {
    const row = await this.database.prepare(
      "SELECT image_revision, ocr_checkpoint FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL",
    ).bind(reviewId, ownerId).first<OcrRow>();
    if (!row?.ocr_checkpoint) return null;
    const checkpoint = ocrCheckpointSchema.parse(JSON.parse(row.ocr_checkpoint));
    return checkpoint.sourceRevision === row.image_revision ? checkpoint : null;
  }

  async saveRecognized(
    ownerId: string,
    reviewId: string,
    sourceRevision: number,
    pages: OcrPage[],
  ): Promise<OcrCheckpoint> {
    const checkpoint = ocrCheckpointSchema.parse({
      version: 1,
      sourceRevision,
      ocrRevision: 0,
      editedAt: null,
      pages,
    });
    const result = await this.database.prepare(`
      UPDATE reviews SET ocr_checkpoint = ?, report_ocr_revision = NULL
      WHERE id = ? AND owner_id = ? AND deleting_at IS NULL AND image_revision = ?
    `).bind(JSON.stringify(checkpoint), reviewId, ownerId, sourceRevision).run();
    if (result.meta.changes === 0) throw new OcrCheckpointError("IMAGE_REVISION_CONFLICT", 409);
    return checkpoint;
  }

  async editTexts(
    ownerId: string,
    reviewId: string,
    expectedOcrRevision: number,
    pageTexts: Array<{ pageIndex: number; text: string }>,
  ): Promise<OcrCheckpoint> {
    const edits = editPagesSchema.parse(pageTexts);
    const current = await this.readInternal(ownerId, reviewId);
    if (!current) throw new OcrCheckpointError("OCR_NOT_FOUND", 404);
    if (current.ocrRevision !== expectedOcrRevision) {
      throw new OcrCheckpointError("OCR_REVISION_CONFLICT", 409);
    }
    if (
      edits.length !== current.pages.length ||
      edits.some((edit, index) => edit.pageIndex !== index)
    ) {
      throw new TypeError("OCR edits must contain every page in order");
    }
    const next = ocrCheckpointSchema.parse({
      ...current,
      ocrRevision: current.ocrRevision + 1,
      editedAt: new Date().toISOString(),
      pages: current.pages.map((page, index) => ({ ...page, text: edits[index].text })),
    });
    const result = await this.database.prepare(`
      UPDATE reviews SET ocr_checkpoint = ?
      WHERE id = ? AND owner_id = ? AND deleting_at IS NULL AND image_revision = ?
        AND json_extract(ocr_checkpoint, '$.ocrRevision') = ?
    `).bind(
      JSON.stringify(next), reviewId, ownerId, current.sourceRevision, expectedOcrRevision,
    ).run();
    if (result.meta.changes === 0) throw new OcrCheckpointError("OCR_REVISION_CONFLICT", 409);
    return next;
  }

  static publicView(checkpoint: OcrCheckpoint) {
    return {
      ocrRevision: checkpoint.ocrRevision,
      editedAt: checkpoint.editedAt,
      pages: checkpoint.pages.map(({ pageIndex, text, readable, warnings }) => ({
        pageIndex,
        text,
        readable,
        warnings,
      })),
    };
  }
}
