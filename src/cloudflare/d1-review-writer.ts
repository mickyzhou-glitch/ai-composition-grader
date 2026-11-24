import { syncEssayBeforeApproval } from "../domain/essay-paragraph-sync";
import { z } from "zod";

import { deliveryReadiness } from "../delivery/readiness";
import {
  annotationSchema,
  assignmentConfigSchema,
  evaluationReportSchema,
  isParagraphEvaluationReport,
  studentNameSchema,
  classNameSchema,
} from "../domain/contracts";
import { validateReport } from "../domain/report-validation";
import { ocrCheckpointSchema, readStoredOcrCheckpoint } from "../ocr/contracts";
import {
  buildExportReadyVersion,
  buildSnapshotConcurrencyBindings,
  buildSummaryStateKey,
  extractConfigTitle,
  extractReportSummaryFields,
  OCR_SNAPSHOT_TOKEN_SQL,
  precheckTeacherReviewReadiness,
  SNAPSHOT_CONCURRENCY_GUARD_SQL,
  SUMMARY_BLOCKED_REASON_MAX_CHARS,
  truncateSummaryField,
} from "./review-summary-state";

export class D1ReviewWriter {
  constructor(private readonly database: D1Database) {}

  async create(ownerId: string, input: { config: unknown; studentName?: unknown; className?: unknown }): Promise<{ id: string; revision: number }> {
    const config = assignmentConfigSchema.parse(input.config);
    const studentName = studentNameSchema.parse(input.studentName ?? "");
    const className = classNameSchema.parse(input.className ?? "");
    const id = crypto.randomUUID();
    const now = Date.now();
    const initialStateKey = buildSummaryStateKey({
      revision: 0,
      imageRevision: 0,
      ocrRevisionCached: null,
      reportOcrRevision: null,
      status: "draft",
      teacherReviewedAt: null,
    });
    const statements: D1PreparedStatement[] = [
      this.database.prepare(`
        INSERT INTO reviews (
          id, owner_id, status, student_name, config, report, revision, analysis_run_id,
          pdf_filename, pdf_path, pdf_revision, exported_at, expires_at, deleting_at,
          privacy_consent_version, privacy_consented_at, created_at, updated_at, class_name,
          has_report, summary_title, summary_grade, summary_is_legacy, summary_diagnostics,
          ocr_revision_cached, export_ready_version, export_blocked_reason, summary_state_key
        )
        VALUES (?, ?, 'draft', ?, ?, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, 0, ?, NULL, 0, NULL, NULL, NULL, '批改报告尚未完成', ?)
      `).bind(id, ownerId, studentName, JSON.stringify(config), now, now, className, extractConfigTitle(config), initialStateKey),
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
      className: classNameSchema.optional(),
      config: assignmentConfigSchema.optional(),
      report: evaluationReportSchema.optional(),
      annotations: z.array(annotationSchema).optional(),
    }).strict().refine((value) => value.className !== undefined || value.studentName !== undefined || value.config !== undefined || value.report !== undefined || value.annotations !== undefined).parse(input);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await this.database.prepare(`SELECT student_name, config, report, status, revision, analysis_run_id, image_revision, ocr_checkpoint, ${OCR_SNAPSHOT_TOKEN_SQL} AS ocr_snapshot_token, report_ocr_revision, teacher_reviewed_at, ocr_revision_cached, export_ready_version, export_blocked_reason, summary_state_key FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL`).bind(reviewId, ownerId).first<{
        student_name: string;
        config: string;
        report: string | null;
        status: string;
        revision: number;
        analysis_run_id: string | null;
        image_revision?: number;
        ocr_checkpoint?: string | null;
        ocr_snapshot_token?: string;
        report_ocr_revision?: number | null;
        teacher_reviewed_at?: number | null;
        ocr_revision_cached?: number | null;
        export_ready_version?: string | null;
        export_blocked_reason?: string | null;
        summary_state_key?: string | null;
      }>();
      if (!current) return null;
      if (current.revision !== parsed.expectedRevision || current.analysis_run_id !== null) {
        throw new RevisionConflictError();
      }
      const hasSnapshotColumns = current.ocr_snapshot_token !== undefined;
      const currentImageRevision = current.image_revision ?? 0;
      const currentReportOcrRevision = current.report_ocr_revision ?? null;
      const config = parsed.config ?? assignmentConfigSchema.parse(JSON.parse(current.config));
      const paragraphReport = parsed.report !== undefined && isParagraphEvaluationReport(parsed.report);
      const checkpoint = paragraphReport && current.ocr_checkpoint
        ? ocrCheckpointSchema.parse(JSON.parse(current.ocr_checkpoint))
        : undefined;
      if (
        paragraphReport
        && (
          checkpoint === undefined
          || checkpoint.sourceRevision !== currentImageRevision
          || checkpoint.ocrRevision !== currentReportOcrRevision
        )
      ) {
        throw new RevisionConflictError();
      }
      const report = parsed.config
        ? null
        : parsed.report !== undefined
          ? validateReport(syncEssayBeforeApproval(parsed.report, checkpoint), { templateType: config.templateType, ocr: checkpoint })
          : current.report === null
            ? null
            : evaluationReportSchema.parse(JSON.parse(current.report));
      const annotations = parsed.config ? [] : parsed.annotations;
      const status = current.status === "rejected" && parsed.config === undefined
        ? "rejected"
        : parsed.config ? "draft" : parsed.report !== undefined || parsed.annotations !== undefined ? (report === null ? "draft" : "ready_for_review") : current.status;
      const now = Date.now();
      const writeNonce = crypto.randomUUID();
      const nextRevision = parsed.expectedRevision + 1;
      const summaryFields = extractReportSummaryFields(report);
      const storedCheckpointForMeta = checkpoint ?? (
        current.ocr_checkpoint
          ? readStoredOcrCheckpoint(current.ocr_checkpoint, currentImageRevision) ?? undefined
          : undefined
      );
      const cachedOcrRevision = current.ocr_checkpoint !== undefined
        ? (storedCheckpointForMeta?.version === 2 ? storedCheckpointForMeta.ocrRevision : null)
        : (current.ocr_revision_cached ?? null);
      const effectiveTeacherReviewedAt = parsed.config !== undefined ? null : (current.teacher_reviewed_at ?? null);
      const previousExpectedStateKey = buildSummaryStateKey({
        revision: parsed.expectedRevision,
        imageRevision: currentImageRevision,
        ocrRevisionCached: current.ocr_revision_cached ?? null,
        reportOcrRevision: currentReportOcrRevision,
        status: current.status,
        teacherReviewedAt: current.teacher_reviewed_at ?? null,
      });
      const wasMaterialized = Boolean(current.summary_state_key && current.summary_state_key === previousExpectedStateKey);
      const nextSummaryStateKey = buildSummaryStateKey({
        revision: nextRevision,
        imageRevision: currentImageRevision,
        ocrRevisionCached: cachedOcrRevision,
        reportOcrRevision: currentReportOcrRevision,
        status,
        teacherReviewedAt: effectiveTeacherReviewedAt,
      });
      let updateReadinessSql = "export_ready_version = ?, export_blocked_reason = ?,";
      let updateReadinessBindings: unknown[] = [];

      if (parsed.config !== undefined) {
        updateReadinessBindings = [null, "批改报告尚未完成"];
      } else if (effectiveTeacherReviewedAt === null || status === "rejected" || summaryFields.isLegacy || report === null) {
        const reason = status === "rejected"
          ? "审核不通过的作文不能导出"
          : report === null
            ? "批改报告尚未完成"
            : (summaryFields.isLegacy ? "旧版示范段落报告需要完整重新分析后才能导出新格式" : "尚未经过老师审核");
        updateReadinessBindings = [null, reason];
      } else if (parsed.report === undefined && wasMaterialized) {
        // 仅当先前已完成权威物化且计算快照与当前库内 OCR/图片/状态严格一致时，才平移已有就绪标记
        const previousExpectedReady = buildExportReadyVersion(
          parsed.expectedRevision,
          currentImageRevision,
          cachedOcrRevision,
          currentReportOcrRevision,
        );
        if (current.export_ready_version && current.export_ready_version === previousExpectedReady) {
          updateReadinessBindings = [
            buildExportReadyVersion(nextRevision, currentImageRevision, cachedOcrRevision, currentReportOcrRevision),
            null,
          ];
        } else {
          updateReadinessBindings = [null, current.export_blocked_reason ?? null];
        }
      } else {
        // 已审核 v2 记录（含单篇修改报告，或迁移后尚未回填前仅修改姓名/班级/批注）：当场用权威 precheck + review_images 原子核验写入就绪标记
        const precheck = precheckTeacherReviewReadiness(report, storedCheckpointForMeta, currentReportOcrRevision);
        if (!precheck.ok) {
          updateReadinessBindings = [null, truncateSummaryField(precheck.reason, SUMMARY_BLOCKED_REASON_MAX_CHARS)];
        } else {
          const candidateReady = buildExportReadyVersion(
            nextRevision,
            currentImageRevision,
            cachedOcrRevision,
            currentReportOcrRevision,
          );
          const pagePlaceholders = precheck.requiredPages.map(() => "?").join(", ");
          updateReadinessSql = `export_ready_version = CASE
            WHEN (SELECT COUNT(DISTINCT position) FROM review_images WHERE review_id = ? AND position IN (${pagePlaceholders})) = ?
            THEN ?
            ELSE NULL
          END,
          export_blocked_reason = CASE
            WHEN (SELECT COUNT(DISTINCT position) FROM review_images WHERE review_id = ? AND position IN (${pagePlaceholders})) = ?
            THEN NULL
            ELSE '图片页缺失，请重新上传后再导出'
          END,`;
          updateReadinessBindings = [
            reviewId,
            ...precheck.requiredPages,
            precheck.requiredPages.length,
            candidateReady,
            reviewId,
            ...precheck.requiredPages,
            precheck.requiredPages.length,
          ];
        }
      }
      const snapshotWhereSql = hasSnapshotColumns ? SNAPSHOT_CONCURRENCY_GUARD_SQL : "";
      const snapshotBindings = hasSnapshotColumns
        ? buildSnapshotConcurrencyBindings({
            image_revision: currentImageRevision,
            status: current.status,
            teacher_reviewed_at: current.teacher_reviewed_at ?? null,
            report_ocr_revision: currentReportOcrRevision,
            ocr_snapshot_token: current.ocr_snapshot_token!,
          })
        : [];
      const updateStatement = this.database.prepare(`
        UPDATE reviews SET student_name = ?, config = ?, report = ?, status = ?, revision = revision + 1, updated_at = ?,
          has_report = ?, summary_title = ?, summary_grade = ?, summary_is_legacy = ?, summary_diagnostics = ?,
          ocr_revision_cached = ?,
          ${updateReadinessSql}
          summary_state_key = ?,
          write_nonce = ?,
          analysis_run_id = CASE WHEN ? THEN NULL ELSE analysis_run_id END,
          teacher_reviewed_at = CASE WHEN ? THEN NULL ELSE teacher_reviewed_at END,
          pdf_filename = NULL, pdf_path = NULL, pdf_revision = NULL, exported_at = NULL,
          class_name = COALESCE(?, class_name)
        WHERE id = ? AND owner_id = ? AND deleting_at IS NULL AND revision = ?
          AND analysis_run_id IS NULL
          ${snapshotWhereSql}
          ${paragraphReport ? `
          AND json_extract(ocr_checkpoint, '$.version') = 2
          AND json_extract(ocr_checkpoint, '$.sourceRevision') = image_revision
          AND json_extract(ocr_checkpoint, '$.ocrRevision') = ?
          AND report_ocr_revision = ?` : ""}
      `).bind(
        parsed.studentName ?? current.student_name,
        JSON.stringify(config),
        report === null ? null : JSON.stringify(report),
        status,
        now,
        summaryFields.hasReport,
        extractConfigTitle(config),
        summaryFields.grade,
        summaryFields.isLegacy,
        summaryFields.diagnosticsJson,
        cachedOcrRevision,
        ...updateReadinessBindings,
        nextSummaryStateKey,
        writeNonce,
        parsed.config !== undefined ? 1 : 0,
        parsed.config !== undefined ? 1 : 0,
        parsed.className ?? null,
        reviewId,
        ownerId,
        parsed.expectedRevision,
        ...snapshotBindings,
        ...(paragraphReport && checkpoint ? [checkpoint.ocrRevision, checkpoint.ocrRevision] : []),
      );
      let changes = 0;
      if (annotations === undefined) {
        const updated = await updateStatement.run();
        changes = updated.meta.changes ?? 0;
      } else {
        // 用单次随机 write_nonce 将批注清空与重建严格绑定到本次胜出的主表 UPDATE，彻底消除同毫秒并发冲突覆盖他人批注
        const annotationGuard = `EXISTS (
          SELECT 1 FROM reviews
          WHERE id = ? AND owner_id = ? AND deleting_at IS NULL
            AND revision = ? AND write_nonce = ? AND analysis_run_id IS NULL
        )`;
        const guardBindings = [reviewId, ownerId, nextRevision, writeNonce];
        const outcomes = await this.database.batch([
          updateStatement,
          this.database.prepare(`DELETE FROM annotations WHERE review_id = ? AND ${annotationGuard}`)
            .bind(reviewId, ...guardBindings),
          ...annotations.map((annotation, position) => this.database.prepare(`
            INSERT INTO annotations (review_id, position, page_index, x, y, category, anchor_text, comment, is_highlight)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${annotationGuard}
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
            ...guardBindings,
          )),
        ]);
        changes = outcomes[0]?.meta.changes ?? 0;
      }
      if (changes === 1) {
        return { revision: nextRevision };
      }
      // 若仅修改姓名/班级/批注时与并发 OCR 修正（不递增 revision）发生快照交叉，重读最新 OCR 快照重试一次，确保摘要资格与最终门禁一致
      if (attempt === 0 && hasSnapshotColumns && parsed.report === undefined && parsed.config === undefined) {
        continue;
      }
      throw new RevisionConflictError();
    }
    throw new RevisionConflictError();
  }

  async completeTeacherReview(
    ownerId: string,
    reviewId: string,
    input: unknown,
  ): Promise<{ revision: number } | null> {
    const parsed = z.object({
      expectedRevision: z.number().int().nonnegative(),
      studentName: studentNameSchema,
      className: classNameSchema.optional(),
      report: evaluationReportSchema,
      annotations: z.array(annotationSchema),
    }).strict().parse(input);
    const current = await this.database.prepare(
      "SELECT config, status, revision, image_revision, ocr_checkpoint, report_ocr_revision FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL",
    ).bind(reviewId, ownerId).first<{
      config: string;
      status: string;
      revision: number;
      image_revision: number;
      ocr_checkpoint: string | null;
      report_ocr_revision: number | null;
    }>();
    if (!current) return null;
    if (current.status === "rejected") {
      const rejected = new Error("审核不通过的作文不能直接通过，请先重新分析。");
      rejected.name = "ReviewRejectedError";
      throw rejected;
    }
    if (current.revision !== parsed.expectedRevision) throw new RevisionConflictError();
    const config = assignmentConfigSchema.parse(JSON.parse(current.config));
    const paragraphReport = isParagraphEvaluationReport(parsed.report);
    const checkpoint = paragraphReport && current.ocr_checkpoint !== null
      ? ocrCheckpointSchema.parse(JSON.parse(current.ocr_checkpoint))
      : undefined;
    if (
      paragraphReport
      && (
        checkpoint === undefined
        || checkpoint.sourceRevision !== current.image_revision
        || checkpoint.ocrRevision !== current.report_ocr_revision
      )
    ) {
      throw new RevisionConflictError();
    }
    // 审核通过时强制「同步到逐段」，通过后的作文两边一定一致，导出也用同步后的内容。
    const report = validateReport(syncEssayBeforeApproval(parsed.report, checkpoint), { config, ocr: checkpoint });
    const now = Date.now();
    const writeNonce = crypto.randomUUID();
    const nextRevision = parsed.expectedRevision + 1;
    const currentImageRevision = current.image_revision ?? 0;
    const currentReportOcrRevision = current.report_ocr_revision ?? null;
    const cachedOcrRevision = checkpoint ? checkpoint.ocrRevision : null;
    const summaryFields = extractReportSummaryFields(report);
    const precheck = summaryFields.isLegacy
      ? { ok: false as const, reason: "旧版示范段落报告需要完整重新分析后才能导出新格式" }
      : precheckTeacherReviewReadiness(report, checkpoint, currentReportOcrRevision);
    const candidateReadyVersion = buildExportReadyVersion(
      nextRevision,
      currentImageRevision,
      cachedOcrRevision,
      currentReportOcrRevision,
    );
    const nextSummaryStateKey = buildSummaryStateKey({
      revision: nextRevision,
      imageRevision: currentImageRevision,
      ocrRevisionCached: cachedOcrRevision,
      reportOcrRevision: currentReportOcrRevision,
      status: "ready_for_review",
      teacherReviewedAt: now,
    });
    const pagePlaceholders = precheck.ok ? precheck.requiredPages.map(() => "?").join(", ") : "";
    const readinessSqlClause = precheck.ok
      ? `export_ready_version = CASE
           WHEN (SELECT COUNT(DISTINCT position) FROM review_images WHERE review_id = ? AND position IN (${pagePlaceholders})) = ?
           THEN ?
           ELSE NULL
         END,
         export_blocked_reason = CASE
           WHEN (SELECT COUNT(DISTINCT position) FROM review_images WHERE review_id = ? AND position IN (${pagePlaceholders})) = ?
           THEN NULL
           ELSE '图片页缺失，请重新上传后再导出'
         END,`
      : `export_ready_version = NULL,
         export_blocked_reason = ?,`;
    const readinessBindings = precheck.ok
      ? [
          reviewId,
          ...precheck.requiredPages,
          precheck.requiredPages.length,
          candidateReadyVersion,
          reviewId,
          ...precheck.requiredPages,
          precheck.requiredPages.length,
        ]
      : [truncateSummaryField(precheck.reason, SUMMARY_BLOCKED_REASON_MAX_CHARS)];
    const eligibility = `
      EXISTS (
        SELECT 1 FROM reviews
        WHERE id = ? AND owner_id = ? AND deleting_at IS NULL
          AND revision = ? AND teacher_reviewed_at = ? AND write_nonce = ?
      )
    `;
    const statements: D1PreparedStatement[] = [
      this.database.prepare(`
        UPDATE reviews SET student_name = ?, class_name = COALESCE(?, class_name), report = ?, status = 'ready_for_review',
          has_report = 1, summary_title = ?, summary_grade = ?, summary_is_legacy = ?, summary_diagnostics = ?,
          ocr_revision_cached = ?,
          ${readinessSqlClause}
          summary_state_key = ?,
          write_nonce = ?,
          revision = revision + 1, teacher_reviewed_at = ?, updated_at = ?,
          analysis_run_id = NULL,
          pdf_filename = NULL, pdf_path = NULL, pdf_revision = NULL, exported_at = NULL
        WHERE id = ? AND owner_id = ? AND deleting_at IS NULL
          AND revision = ? AND report IS NOT NULL
          AND status IN ('ready_for_review', 'exported')
          ${paragraphReport ? `
          AND json_extract(ocr_checkpoint, '$.version') = 2
          AND json_extract(ocr_checkpoint, '$.sourceRevision') = image_revision
          AND json_extract(ocr_checkpoint, '$.ocrRevision') = ?
          AND report_ocr_revision = ?` : ""}
      `).bind(
        parsed.studentName,
        parsed.className ?? null,
        JSON.stringify(report),
        extractConfigTitle(config),
        summaryFields.grade,
        summaryFields.isLegacy,
        summaryFields.diagnosticsJson,
        cachedOcrRevision,
        ...readinessBindings,
        nextSummaryStateKey,
        writeNonce,
        now,
        now,
        reviewId,
        ownerId,
        parsed.expectedRevision,
        ...(paragraphReport && checkpoint ? [checkpoint.ocrRevision, checkpoint.ocrRevision] : []),
      ),
      this.database.prepare(`
        DELETE FROM annotations WHERE review_id = ? AND ${eligibility}
      `).bind(reviewId, reviewId, ownerId, nextRevision, now, writeNonce),
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
        writeNonce,
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
    const [current, imageResult] = await Promise.all([
      this.database.prepare(`
        SELECT revision, report, image_revision, ocr_checkpoint, report_ocr_revision, teacher_reviewed_at
        FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL
      `).bind(reviewId, ownerId).first<{
        revision: number;
        report: string | null;
        image_revision: number;
        ocr_checkpoint: string | null;
        report_ocr_revision: number | null;
        teacher_reviewed_at: number | null;
      }>(),
      this.database.prepare(`
        SELECT position, width, height FROM review_images
        WHERE review_id = ? AND EXISTS (
          SELECT 1 FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL
        ) ORDER BY position, id
      `).bind(reviewId, reviewId, ownerId).all<{
        position: number;
        width: number;
        height: number;
      }>(),
    ]);
    if (!current) return false;
    let cachedOcrRevision: number | null = null;
    try {
      const report = current.report === null ? null : JSON.parse(current.report);
      const parsedCheckpoint = current.ocr_checkpoint === null
        ? null
        : ocrCheckpointSchema.parse(JSON.parse(current.ocr_checkpoint));
      const checkpoint = parsedCheckpoint?.sourceRevision === current.image_revision
        ? parsedCheckpoint
        : null;
      cachedOcrRevision = checkpoint?.version === 2 ? checkpoint.ocrRevision : null;
      const images = imageResult.results ?? [];
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
    const now = Date.now();
    const readyVersion = buildExportReadyVersion(
      current.revision,
      current.image_revision,
      cachedOcrRevision,
      current.report_ocr_revision,
    );
    const exportedStateKey = buildSummaryStateKey({
      revision: current.revision,
      imageRevision: current.image_revision,
      ocrRevisionCached: cachedOcrRevision,
      reportOcrRevision: current.report_ocr_revision,
      status: "exported",
      teacherReviewedAt: current.teacher_reviewed_at,
    });
    const updated = await this.database.prepare(`
      UPDATE reviews SET status = 'exported', exported_at = COALESCE(exported_at, ?), updated_at = ?,
        ocr_revision_cached = ?, export_ready_version = ?, export_blocked_reason = NULL, summary_state_key = ?
      WHERE id = ? AND owner_id = ? AND deleting_at IS NULL AND revision = ?
        AND teacher_reviewed_at IS NOT NULL AND report IS NOT NULL
        AND json_extract(ocr_checkpoint, '$.version') = 2
        AND report_ocr_revision = json_extract(ocr_checkpoint, '$.ocrRevision')
    `).bind(now, now, cachedOcrRevision, readyVersion, exportedStateKey, reviewId, ownerId, current.revision).run();
    return updated.meta.changes > 0;
  }

  async deleteReview(ownerId: string, reviewId: string): Promise<string[] | null> {
    const [images, exists] = await Promise.all([
      this.database.prepare(`
        SELECT original_path, annotation_path, ai_path FROM review_images
        WHERE review_id = ? AND EXISTS (SELECT 1 FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL)
      `).bind(reviewId, reviewId, ownerId).all<{ original_path: string; annotation_path: string; ai_path: string }>(),
      this.database.prepare("SELECT id FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL").bind(reviewId, ownerId).first<{ id: string }>(),
    ]);
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
