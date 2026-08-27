import { z } from "zod";

import { deliveryReadiness } from "../delivery/readiness";
import { annotationSchema, assignmentConfigSchema, evaluationReportSchema, studentNameSchema } from "../domain/contracts";
import { validateReport } from "../domain/report-validation";
import { ocrCheckpointSchema } from "../ocr/contracts";

export class D1ReviewWriter {
  constructor(private readonly database: D1Database) {}

  async create(ownerId: string, input: { config: unknown; studentName?: unknown }): Promise<{ id: string; revision: number }> {
    const config = assignmentConfigSchema.parse(input.config);
    const studentName = studentNameSchema.parse(input.studentName ?? "");
    const id = crypto.randomUUID();
    const now = Date.now();
    const statements: D1PreparedStatement[] = [
      this.database.prepare(`
        INSERT INTO reviews (id, owner_id, status, student_name, config, report, revision, analysis_run_id, pdf_filename, pdf_path, pdf_revision, exported_at, expires_at, deleting_at, privacy_consent_version, privacy_consented_at, created_at, updated_at)
        VALUES (?, ?, 'draft', ?, ?, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `).bind(id, ownerId, studentName, JSON.stringify(config), now, now),
    ];
    if (config.templateType === "custom") {
      statements.push(this.database.prepare(`
        INSERT INTO saved_assignments (id, owner_id, title, config, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, title) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at
      `).bind(crypto.randomUUID(), ownerId, config.title, JSON.stringify(config), now, now));
    }
    await this.database.batch(statements);
    return { id, revision: 0 };
  }

  async deleteSavedAssignment(ownerId: string, id: string): Promise<boolean> {
    const result = await this.database.prepare("DELETE FROM saved_assignments WHERE id = ? AND owner_id = ?").bind(id, ownerId).run();
    return result.meta.changes > 0;
  }

  async update(ownerId: string, reviewId: string, input: unknown): Promise<{ revision: number } | null> {
    const parsed = z.object({
      expectedRevision: z.number().int().nonnegative(),
      studentName: studentNameSchema.optional(),
      config: assignmentConfigSchema.optional(),
      report: evaluationReportSchema.optional(),
      annotations: z.array(annotationSchema).optional(),
    }).strict().refine((value) => value.studentName !== undefined || value.config !== undefined || value.report !== undefined || value.annotations !== undefined).parse(input);
    const current = await this.database.prepare("SELECT student_name, config, report, status, revision, analysis_run_id FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL").bind(reviewId, ownerId).first<{ student_name: string; config: string; report: string | null; status: string; revision: number; analysis_run_id: string | null }>();
    if (!current) return null;
    if (current.revision !== parsed.expectedRevision || current.analysis_run_id !== null) {
      throw new RevisionConflictError();
    }
    const config = parsed.config ?? assignmentConfigSchema.parse(JSON.parse(current.config));
    const report = parsed.config
      ? null
      : parsed.report !== undefined
        ? validateReport(parsed.report, { templateType: config.templateType })
        : current.report === null
          ? null
          : evaluationReportSchema.parse(JSON.parse(current.report));
    const annotations = parsed.config ? [] : parsed.annotations;
    const status = parsed.config ? "draft" : parsed.report !== undefined || parsed.annotations !== undefined ? (report === null ? "draft" : "ready_for_review") : current.status;
    const now = Date.now();
    const updated = await this.database.prepare(`
      UPDATE reviews SET student_name = ?, config = ?, report = ?, status = ?, revision = revision + 1, updated_at = ?,
        analysis_run_id = CASE WHEN ? THEN NULL ELSE analysis_run_id END,
        teacher_reviewed_at = CASE WHEN ? THEN NULL ELSE teacher_reviewed_at END,
        pdf_filename = NULL, pdf_path = NULL, pdf_revision = NULL, exported_at = NULL
      WHERE id = ? AND owner_id = ? AND deleting_at IS NULL AND revision = ?
        AND analysis_run_id IS NULL
    `).bind(parsed.studentName ?? current.student_name, JSON.stringify(config), report === null ? null : JSON.stringify(report), status, now, parsed.config !== undefined ? 1 : 0, parsed.config !== undefined ? 1 : 0, reviewId, ownerId, parsed.expectedRevision).run();
    if (updated.meta.changes === 0) throw new RevisionConflictError();
    if (annotations !== undefined) {
      await this.database.batch([
        this.database.prepare("DELETE FROM annotations WHERE review_id = ?").bind(reviewId),
        ...annotations.map((annotation, position) => this.database.prepare(`
          INSERT INTO annotations (review_id, position, page_index, x, y, category, anchor_text, comment, is_highlight)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(reviewId, position, annotation.pageIndex, annotation.x, annotation.y, annotation.category, annotation.anchorText, annotation.comment, annotation.isHighlight ? 1 : 0)),
      ]);
    }
    return { revision: parsed.expectedRevision + 1 };
  }

  async completeTeacherReview(
    ownerId: string,
    reviewId: string,
    input: unknown,
  ): Promise<{ revision: number } | null> {
    const parsed = z.object({
      expectedRevision: z.number().int().nonnegative(),
      studentName: studentNameSchema,
      report: evaluationReportSchema,
      annotations: z.array(annotationSchema),
    }).strict().parse(input);
    const current = await this.database.prepare(
      "SELECT config, revision FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL",
    ).bind(reviewId, ownerId).first<{ config: string; revision: number }>();
    if (!current) return null;
    if (current.revision !== parsed.expectedRevision) throw new RevisionConflictError();
    const config = assignmentConfigSchema.parse(JSON.parse(current.config));
    const report = validateReport(parsed.report, { config });
    const now = Date.now();
    const nextRevision = parsed.expectedRevision + 1;
    const eligibility = `
      EXISTS (
        SELECT 1 FROM reviews
        WHERE id = ? AND owner_id = ? AND deleting_at IS NULL
          AND revision = ? AND teacher_reviewed_at = ?
      )
    `;
    const statements: D1PreparedStatement[] = [
      this.database.prepare(`
        UPDATE reviews SET student_name = ?, report = ?, status = 'ready_for_review',
          revision = revision + 1, teacher_reviewed_at = ?, updated_at = ?,
          analysis_run_id = NULL,
          pdf_filename = NULL, pdf_path = NULL, pdf_revision = NULL, exported_at = NULL
        WHERE id = ? AND owner_id = ? AND deleting_at IS NULL
          AND revision = ? AND report IS NOT NULL
          AND status IN ('ready_for_review', 'exported')
      `).bind(
        parsed.studentName,
        JSON.stringify(report),
        now,
        now,
        reviewId,
        ownerId,
        parsed.expectedRevision,
      ),
      this.database.prepare(`
        DELETE FROM annotations WHERE review_id = ? AND ${eligibility}
      `).bind(reviewId, reviewId, ownerId, nextRevision, now),
      ...parsed.annotations.map((annotation, position) => this.database.prepare(`
        INSERT INTO annotations (
          review_id, position, page_index, x, y, category, anchor_text, comment, is_highlight
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${eligibility}
      `).bind(
        reviewId,
        position,
        annotation.pageIndex,
        annotation.x,
        annotation.y,
        annotation.category,
        annotation.anchorText,
        annotation.comment,
        annotation.isHighlight ? 1 : 0,
        reviewId,
        ownerId,
        nextRevision,
        now,
      )),
    ];
    const outcomes = await this.database.batch(statements);
    if ((outcomes[0]?.meta.changes ?? 0) === 1) return { revision: nextRevision };
    const exists = await this.database.prepare(
      "SELECT id FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL",
    ).bind(reviewId, ownerId).first<{ id: string }>();
    if (!exists) return null;
    throw new RevisionConflictError();
  }

  async markExported(ownerId: string, reviewId: string): Promise<boolean> {
    const current = await this.database.prepare(`
      SELECT revision, report, image_revision, ocr_checkpoint, report_ocr_revision, teacher_reviewed_at
      FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL
    `).bind(reviewId, ownerId).first<{
      revision: number;
      report: string | null;
      image_revision: number;
      ocr_checkpoint: string | null;
      report_ocr_revision: number | null;
      teacher_reviewed_at: number | null;
    }>();
    if (!current) return false;
    try {
      const report = current.report === null ? null : JSON.parse(current.report);
      const parsedCheckpoint = current.ocr_checkpoint === null
        ? null
        : ocrCheckpointSchema.parse(JSON.parse(current.ocr_checkpoint));
      const checkpoint = parsedCheckpoint?.sourceRevision === current.image_revision
        ? parsedCheckpoint
        : null;
      const { results: images = [] } = await this.database.prepare(`
        SELECT position, width, height FROM review_images
        WHERE review_id = ? AND EXISTS (
          SELECT 1 FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL
        ) ORDER BY position, id
      `).bind(reviewId, reviewId, ownerId).all<{
        position: number;
        width: number;
        height: number;
      }>();
      const readiness = deliveryReadiness({
        report,
        teacherReviewedAt: current.teacher_reviewed_at === null
          ? null
          : new Date(current.teacher_reviewed_at),
        reportStale: report !== null && (
          checkpoint === null
          || current.report_ocr_revision !== checkpoint.ocrRevision
        ),
        reportOcrRevision: current.report_ocr_revision,
        ocr: checkpoint,
        images,
      });
      if (!readiness.ready) return false;
    } catch {
      return false;
    }
    const updated = await this.database.prepare(`
      UPDATE reviews SET status = 'exported', updated_at = ?
      WHERE id = ? AND owner_id = ? AND deleting_at IS NULL AND revision = ?
        AND teacher_reviewed_at IS NOT NULL AND report IS NOT NULL
        AND json_extract(ocr_checkpoint, '$.version') = 2
        AND report_ocr_revision = json_extract(ocr_checkpoint, '$.ocrRevision')
    `).bind(Date.now(), reviewId, ownerId, current.revision).run();
    return updated.meta.changes > 0;
  }

  async deleteReview(ownerId: string, reviewId: string): Promise<string[] | null> {
    const images = await this.database.prepare(`
      SELECT original_path, annotation_path, ai_path FROM review_images
      WHERE review_id = ? AND EXISTS (SELECT 1 FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL)
    `).bind(reviewId, reviewId, ownerId).all<{ original_path: string; annotation_path: string; ai_path: string }>();
    const exists = await this.database.prepare("SELECT id FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL").bind(reviewId, ownerId).first<{ id: string }>();
    if (!exists) return null;
    await this.database.batch([
      this.database.prepare("DELETE FROM annotations WHERE review_id = ?").bind(reviewId),
      this.database.prepare("DELETE FROM analysis_jobs WHERE review_id = ? AND owner_id = ?").bind(reviewId, ownerId),
      this.database.prepare("DELETE FROM review_images WHERE review_id = ?").bind(reviewId),
      this.database.prepare("DELETE FROM reviews WHERE id = ? AND owner_id = ?").bind(reviewId, ownerId),
    ]);
    return (images.results ?? []).flatMap((image) => [image.original_path, image.annotation_path, image.ai_path]);
  }
}

class RevisionConflictError extends Error {
  constructor() {
    super("review revision conflict");
    this.name = "RevisionConflictError";
  }
}
