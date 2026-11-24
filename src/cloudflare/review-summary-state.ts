import {
  assignmentConfigSchema,
  evaluationReportSchema,
  gradeFromLegacyTotal,
  isLegacyEvaluationReport,
} from "../domain/contracts";
import { deliveryReadiness } from "../delivery/readiness";
import { publicOcrView, readStoredOcrCheckpoint, type OcrCheckpoint } from "../ocr/contracts";
import type { ReviewSummaryDiagnosticsView } from "../../app/lib/types";

export const EXPECTED_SUMMARY_KEY_SQL = `(
  CAST(revision AS TEXT) || ':' || CAST(image_revision AS TEXT) || ':' ||
  CAST(COALESCE(ocr_revision_cached, -1) AS TEXT) || ':' ||
  CAST(COALESCE(report_ocr_revision, -1) AS TEXT) || ':' ||
  status || ':' || CAST(COALESCE(teacher_reviewed_at, -1) AS TEXT)
)`;

export interface SummaryStateInputs {
  revision: number;
  imageRevision: number;
  ocrRevisionCached: number | null;
  reportOcrRevision: number | null;
  status: string;
  teacherReviewedAt: number | null;
}

export function buildExportReadyVersion(
  revision: number,
  imageRevision: number,
  ocrRevisionCached: number | null,
  reportOcrRevision: number | null,
): string {
  return `${revision}:${imageRevision}:${ocrRevisionCached ?? -1}:${reportOcrRevision ?? -1}`;
}

export function buildSummaryStateKey(input: SummaryStateInputs): string {
  return `${input.revision}:${input.imageRevision}:${input.ocrRevisionCached ?? -1}:${input.reportOcrRevision ?? -1}:${input.status}:${input.teacherReviewedAt ?? -1}`;
}

export const SUMMARY_TITLE_MAX_CHARS = 200;
export const SUMMARY_GRADE_MAX_CHARS = 16;
export const SUMMARY_DIAGNOSTIC_FIELD_MAX_CHARS = 500;
export const SUMMARY_BLOCKED_REASON_MAX_CHARS = 300;

export function truncateSummaryField(value: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  const codePoints = Array.from(value);
  if (codePoints.length <= maxChars) return value;
  return maxChars === 1 ? "…" : `${codePoints.slice(0, maxChars - 1).join("")}…`;
}

export function extractConfigTitle(rawConfig: unknown): string {
  try {
    const parsed = typeof rawConfig === "string" ? JSON.parse(rawConfig) : rawConfig;
    if (parsed && typeof parsed === "object" && "title" in parsed && typeof (parsed as { title?: unknown }).title === "string") {
      return truncateSummaryField((parsed as { title: string }).title.trim(), SUMMARY_TITLE_MAX_CHARS);
    }
    return truncateSummaryField(assignmentConfigSchema.parse(parsed).title, SUMMARY_TITLE_MAX_CHARS);
  } catch {
    return "";
  }
}

export function parseSummaryDiagnostics(raw: string | null | undefined): ReviewSummaryDiagnosticsView | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ReviewSummaryDiagnosticsView>;
    if (
      parsed
      && typeof parsed.authenticityAndRelevance?.finding === "string"
      && typeof parsed.authenticityAndRelevance?.action === "string"
      && typeof parsed.structure?.finding === "string"
      && typeof parsed.structure?.action === "string"
    ) {
      return {
        authenticityAndRelevance: {
          finding: parsed.authenticityAndRelevance.finding,
          action: parsed.authenticityAndRelevance.action,
        },
        structure: {
          finding: parsed.structure.finding,
          action: parsed.structure.action,
        },
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function extractReportSummaryFields(rawReport: unknown): {
  hasReport: 0 | 1;
  grade: string | null;
  isLegacy: 0 | 1;
  diagnosticsJson: string | null;
} {
  if (rawReport === null || rawReport === undefined) {
    return { hasReport: 0, grade: null, isLegacy: 0, diagnosticsJson: null };
  }
  try {
    const parsed = typeof rawReport === "string" ? JSON.parse(rawReport) : rawReport;
    if (!parsed || typeof parsed !== "object") {
      return { hasReport: 1, grade: null, isLegacy: 0, diagnosticsJson: null };
    }
    const record = parsed as {
      version?: unknown;
      grade?: unknown;
      sampleParagraphs?: unknown;
      scores?: { total?: unknown } | null;
      diagnostics?: {
        authenticityAndRelevance?: { finding?: unknown; action?: unknown };
        structure?: { finding?: unknown; action?: unknown };
      } | null;
    };
    const isLegacy = isLegacyEvaluationReport(parsed)
      || (Array.isArray(record.sampleParagraphs) && record.version !== 2);
    let grade: string | null = typeof record.grade === "string" && record.grade.trim()
      ? Array.from(record.grade.trim()).slice(0, SUMMARY_GRADE_MAX_CHARS).join("")
      : null;
    if (!grade && record.scores && typeof record.scores.total === "number" && Number.isInteger(record.scores.total)) {
      try {
        grade = gradeFromLegacyTotal(record.scores.total);
      } catch {
        grade = null;
      }
    }
    let diagnosticsJson: string | null = null;
    const ar = record.diagnostics?.authenticityAndRelevance;
    const st = record.diagnostics?.structure;
    if (
      ar && st
      && typeof ar.finding === "string" && typeof ar.action === "string"
      && typeof st.finding === "string" && typeof st.action === "string"
    ) {
      diagnosticsJson = JSON.stringify({
        authenticityAndRelevance: {
          finding: truncateSummaryField(ar.finding, SUMMARY_DIAGNOSTIC_FIELD_MAX_CHARS),
          action: truncateSummaryField(ar.action, SUMMARY_DIAGNOSTIC_FIELD_MAX_CHARS),
        },
        structure: {
          finding: truncateSummaryField(st.finding, SUMMARY_DIAGNOSTIC_FIELD_MAX_CHARS),
          action: truncateSummaryField(st.action, SUMMARY_DIAGNOSTIC_FIELD_MAX_CHARS),
        },
      });
    } else if (isLegacy) {
      try {
        const normalized = evaluationReportSchema.parse(parsed);
        if (normalized.diagnostics) {
          diagnosticsJson = JSON.stringify({
            authenticityAndRelevance: {
              finding: truncateSummaryField(normalized.diagnostics.authenticityAndRelevance.finding, SUMMARY_DIAGNOSTIC_FIELD_MAX_CHARS),
              action: truncateSummaryField(normalized.diagnostics.authenticityAndRelevance.action, SUMMARY_DIAGNOSTIC_FIELD_MAX_CHARS),
            },
            structure: {
              finding: truncateSummaryField(normalized.diagnostics.structure.finding, SUMMARY_DIAGNOSTIC_FIELD_MAX_CHARS),
              action: truncateSummaryField(normalized.diagnostics.structure.action, SUMMARY_DIAGNOSTIC_FIELD_MAX_CHARS),
            },
          });
        }
      } catch {
        diagnosticsJson = null;
      }
    }
    return {
      hasReport: 1,
      grade,
      isLegacy: isLegacy ? 1 : 0,
      diagnosticsJson,
    };
  } catch {
    return { hasReport: 1, grade: null, isLegacy: 0, diagnosticsJson: null };
  }
}

export function precheckTeacherReviewReadiness(
  report: unknown,
  checkpoint: OcrCheckpoint | null | undefined,
  reportOcrRevision: number | null,
): { ok: true; requiredPages: number[] } | { ok: false; reason: string } {
  if (!checkpoint || checkpoint.version !== 2) {
    return { ok: false, reason: "需要完整重新分析为自然段识别结果后才能导出" };
  }
  const ocrView = publicOcrView(checkpoint);
  const syntheticImages = checkpoint.pages.map((page) => ({ position: page.pageIndex }));
  const reportStale = reportOcrRevision !== checkpoint.ocrRevision;
  const readiness = deliveryReadiness({
    report,
    teacherReviewedAt: "pending-teacher-review",
    reportStale,
    reportOcrRevision,
    ocr: ocrView,
    images: syntheticImages,
  });
  if (!readiness.ready) {
    return { ok: false, reason: readiness.message };
  }
  const requiredPages = [...new Set(
    checkpoint.paragraphs.flatMap((paragraph) =>
      paragraph.segments.map((segment) => segment.pageIndex),
    ),
  )].sort((a, b) => a - b);
  return { ok: true, requiredPages };
}

export function summaryEligibilityFromMaterialized(row: {
  status: string;
  has_report: number;
  summary_is_legacy: number | null;
  revision: number;
  image_revision: number;
  ocr_revision_cached: number | null;
  report_ocr_revision: number | null;
  teacher_reviewed_at: number | null;
  export_ready_version: string | null;
  export_blocked_reason: string | null;
  summary_state_key?: string | null;
}): { eligible: true } | { eligible: false; reason: string } {
  if (row.status === "rejected") {
    return { eligible: false, reason: "审核不通过的作文不能导出" };
  }
  if (!row.has_report) {
    return { eligible: false, reason: "批改报告尚未完成" };
  }
  if (row.summary_is_legacy) {
    return { eligible: false, reason: "旧版示范段落报告需要完整重新分析后才能导出新格式" };
  }
  if (row.teacher_reviewed_at === null) {
    return { eligible: false, reason: "尚未经过老师审核" };
  }
  if (row.summary_state_key !== undefined) {
    const expectedStateKey = buildSummaryStateKey({
      revision: row.revision,
      imageRevision: row.image_revision,
      ocrRevisionCached: row.ocr_revision_cached,
      reportOcrRevision: row.report_ocr_revision,
      status: row.status,
      teacherReviewedAt: row.teacher_reviewed_at,
    });
    if (row.summary_state_key === null || row.summary_state_key !== expectedStateKey) {
      return { eligible: false, reason: "历史批改摘要正在同步导出资格，请稍后刷新再导出" };
    }
  }
  const expectedReady = buildExportReadyVersion(
    row.revision,
    row.image_revision,
    row.ocr_revision_cached,
    row.report_ocr_revision,
  );
  if (row.export_ready_version === expectedReady) {
    return { eligible: true };
  }
  if (row.ocr_revision_cached === null) {
    return { eligible: false, reason: "需要完整重新分析为自然段识别结果后才能导出" };
  }
  if (row.report_ocr_revision === null || row.report_ocr_revision !== row.ocr_revision_cached) {
    return { eligible: false, reason: "批改报告基于旧版识别原文，请重新生成批改" };
  }
  return {
    eligible: false,
    reason: row.export_blocked_reason || "当前作文暂不满足新格式导出条件，请进入单篇复核核对",
  };
}

export interface StaleSummaryRow {
  id: string;
  owner_id: string;
  status: string;
  config: string;
  report: string | null;
  revision: number;
  image_revision: number;
  ocr_checkpoint: string | null;
  ocr_snapshot_token: string;
  report_ocr_revision: number | null;
  teacher_reviewed_at: number | null;
  analysis_run_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface SummaryBackfillCursor {
  priorityTier: 0 | 1;
  updatedAt: number;
  createdAt: number;
  id: string;
}

export const SUMMARY_PRIORITY_TIER_SQL = `(CASE WHEN teacher_reviewed_at IS NOT NULL AND status NOT IN ('exported', 'rejected') THEN 0 ELSE 1 END)`;

export const MAX_SUMMARY_BACKFILL_BATCH = 20;

/**
 * 由 SQLite 在读取与更新两侧统一求值的硬封顶并发指纹（字符上限 <= 2100，UTF-8 字节上限恒 <= 8400B）：
 * - 字节长度 <= 2048B 时比对完整文本；
 * - 字节长度 > 2048B 时对每个提取的 JSON 字段均施加 substr(..., 1, 64) 并在最外层包裹 substr(..., 1, 2100)，
 *   杜绝超长 editedAt 时间戳或异常历史长字段将远端 UPDATE 撑破 D1 的 100 KB 语句上限。
 */
export const OCR_SNAPSHOT_TOKEN_SQL = `substr(
  (CASE
    WHEN ocr_checkpoint IS NULL THEN 'null'
    WHEN length(CAST(ocr_checkpoint AS BLOB)) <= 2048 THEN 'full:' || ocr_checkpoint
    WHEN json_valid(ocr_checkpoint) = 0 THEN
      'large-raw:' || CAST(length(CAST(ocr_checkpoint AS BLOB)) AS TEXT)
      || ':' || substr(ocr_checkpoint, 1, 128)
      || ':' || substr(ocr_checkpoint, -128)
    ELSE
      'large-json:' || CAST(length(CAST(ocr_checkpoint AS BLOB)) AS TEXT)
      || ':' || COALESCE(json_type(ocr_checkpoint, '$.version'), 'null')
      || '=' || substr(CAST(COALESCE(json_extract(ocr_checkpoint, '$.version'), '') AS TEXT), 1, 64)
      || ':' || COALESCE(json_type(ocr_checkpoint, '$.sourceRevision'), 'null')
      || '=' || substr(CAST(COALESCE(json_extract(ocr_checkpoint, '$.sourceRevision'), '') AS TEXT), 1, 64)
      || ':' || COALESCE(json_type(ocr_checkpoint, '$.ocrRevision'), 'null')
      || '=' || substr(CAST(COALESCE(json_extract(ocr_checkpoint, '$.ocrRevision'), '') AS TEXT), 1, 64)
      || ':' || COALESCE(json_type(ocr_checkpoint, '$.editedAt'), 'null')
      || '=' || substr(CAST(COALESCE(json_extract(ocr_checkpoint, '$.editedAt'), '') AS TEXT), 1, 64)
      || ':' || substr(ocr_checkpoint, 1, 128)
      || ':' || substr(ocr_checkpoint, -128)
  END),
  1,
  2100
)`;

export const SNAPSHOT_CONCURRENCY_GUARD_SQL = `
  AND image_revision = ?
  AND status = ?
  AND teacher_reviewed_at IS ?
  AND report_ocr_revision IS ?
  AND ${OCR_SNAPSHOT_TOKEN_SQL} = ?
`;

export function buildSnapshotConcurrencyBindings(row: {
  image_revision: number;
  status: string;
  teacher_reviewed_at: number | null;
  report_ocr_revision: number | null;
  ocr_snapshot_token: string;
}): unknown[] {
  return [
    row.image_revision,
    row.status,
    row.teacher_reviewed_at,
    row.report_ocr_revision,
    row.ocr_snapshot_token,
  ];
}

export function cursorFromSummaryRow(row: Pick<StaleSummaryRow, "teacher_reviewed_at" | "status" | "updated_at" | "created_at" | "id">): SummaryBackfillCursor {
  const priorityTier: 0 | 1 = (
    row.teacher_reviewed_at !== null
    && row.status !== "exported"
    && row.status !== "rejected"
  ) ? 0 : 1;
  return {
    priorityTier,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    id: row.id,
  };
}

/**
 * 正式回填与只读预演共用的单页 Keyset 查询入口，确保排序与游标推进逻辑 100% 同源。
 */
export async function selectStaleSummaryRows(
  database: D1Database,
  options: {
    ownerId?: string;
    ids?: readonly string[];
    limit: number;
    onlyPendingExport?: boolean;
    cursor?: SummaryBackfillCursor | null;
  },
): Promise<StaleSummaryRow[]> {
  const safeLimit = Math.min(MAX_SUMMARY_BACKFILL_BATCH, Math.max(1, Math.trunc(options.limit)));
  const targetIds = options.ids ? [...new Set(options.ids)].slice(0, MAX_SUMMARY_BACKFILL_BATCH) : null;
  if (targetIds !== null && targetIds.length === 0) return [];
  const ownerClause = options.ownerId !== undefined ? "owner_id = ? AND " : "";
  const idsClause = targetIds !== null ? `id IN (${targetIds.map(() => "?").join(", ")}) AND ` : "";
  const pendingClause = options.onlyPendingExport
    ? "teacher_reviewed_at IS NOT NULL AND status NOT IN ('exported', 'rejected') AND "
    : "";
  const c = options.cursor ?? null;
  const cursorClause = c !== null
    ? `(
        ${SUMMARY_PRIORITY_TIER_SQL} > ?
        OR (${SUMMARY_PRIORITY_TIER_SQL} = ? AND updated_at < ?)
        OR (${SUMMARY_PRIORITY_TIER_SQL} = ? AND updated_at = ? AND created_at < ?)
        OR (${SUMMARY_PRIORITY_TIER_SQL} = ? AND updated_at = ? AND created_at = ? AND id < ?)
      ) AND `
    : "";
  const queryBindings: unknown[] = [
    ...(options.ownerId !== undefined ? [options.ownerId] : []),
    ...(targetIds !== null ? targetIds : []),
    ...(c !== null
      ? [
          c.priorityTier,
          c.priorityTier, c.updatedAt,
          c.priorityTier, c.updatedAt, c.createdAt,
          c.priorityTier, c.updatedAt, c.createdAt, c.id,
        ]
      : []),
    safeLimit,
  ];

  const { results: staleRows = [] } = await database.prepare(`
    SELECT id, owner_id, status, config, report, revision, image_revision, ocr_checkpoint,
           ${OCR_SNAPSHOT_TOKEN_SQL} AS ocr_snapshot_token,
           report_ocr_revision, teacher_reviewed_at, analysis_run_id, created_at, updated_at
    FROM reviews
    WHERE ${ownerClause}${idsClause}${pendingClause}${cursorClause}deleting_at IS NULL
      AND (summary_state_key IS NULL OR summary_state_key <> ${EXPECTED_SUMMARY_KEY_SQL})
    ORDER BY
      ${SUMMARY_PRIORITY_TIER_SQL} ASC,
      updated_at DESC, created_at DESC, id DESC
    LIMIT ?
  `).bind(...queryBindings).all<StaleSummaryRow>();
  return staleRows;
}

export async function runSummaryBackfillCursorStep(
  database: D1Database,
  options: {
    ownerId?: string;
    ids?: readonly string[];
    limit: number;
    onlyPendingExport?: boolean;
    cursor?: SummaryBackfillCursor | null;
  },
): Promise<{ fetched: number; updated: number; nextCursor: SummaryBackfillCursor | null }> {
  const staleRows = await selectStaleSummaryRows(database, options);
  if (staleRows.length === 0) return { fetched: 0, updated: 0, nextCursor: null };

  const candidateImageIds = staleRows
    .filter((row) => row.report !== null && row.teacher_reviewed_at !== null && row.status !== "rejected")
    .map((row) => row.id);
  const imagesByReview = new Map<string, Array<{ position: number; width: number; height: number }>>();
  if (candidateImageIds.length > 0) {
    const placeholders = candidateImageIds.map(() => "?").join(", ");
    const { results: imageRows = [] } = await database.prepare(`
      SELECT review_id, position, width, height
      FROM review_images
      WHERE review_id IN (${placeholders})
      ORDER BY position, id
    `).bind(...candidateImageIds).all<{ review_id?: string; position: number; width: number; height: number }>();
    for (const image of imageRows) {
      const key = image.review_id ?? (candidateImageIds.length === 1 ? candidateImageIds[0]! : "");
      if (!key) continue;
      const list = imagesByReview.get(key) ?? [];
      list.push({ position: image.position, width: image.width, height: image.height });
      imagesByReview.set(key, list);
    }
  }

  const statements: D1PreparedStatement[] = staleRows.map((row) => {
    const title = extractConfigTitle(row.config);
    const summaryFields = extractReportSummaryFields(row.report);
    const checkpoint = readStoredOcrCheckpoint(row.ocr_checkpoint, row.image_revision);
    const cachedOcrRevision = checkpoint?.version === 2 ? checkpoint.ocrRevision : null;
    let exportReadyVersion: string | null = null;
    let exportBlockedReason: string | null = null;
    let requiredPages: number[] = [];

    if (row.status === "rejected") {
      exportBlockedReason = "审核不通过的作文不能导出";
    } else if (!summaryFields.hasReport || row.report === null) {
      exportBlockedReason = "批改报告尚未完成";
    } else if (summaryFields.isLegacy) {
      exportBlockedReason = "旧版示范段落报告需要完整重新分析后才能导出新格式";
    } else if (row.teacher_reviewed_at === null) {
      exportBlockedReason = "尚未经过老师审核";
    } else {
      try {
        const parsedReport = evaluationReportSchema.parse(JSON.parse(row.report));
        const ocrView = checkpoint ? publicOcrView(checkpoint) : null;
        const reportStale = checkpoint === null || row.report_ocr_revision !== checkpoint.ocrRevision;
        const readiness = deliveryReadiness({
          report: parsedReport,
          teacherReviewedAt: new Date(row.teacher_reviewed_at).toISOString(),
          reportStale,
          reportOcrRevision: row.report_ocr_revision,
          ocr: ocrView,
          images: imagesByReview.get(row.id) ?? [],
        });
        if (readiness.ready && checkpoint?.version === 2) {
          requiredPages = [...new Set(
            checkpoint.paragraphs.flatMap((paragraph) => paragraph.segments.map((segment) => segment.pageIndex)),
          )].sort((a, b) => a - b);
          exportReadyVersion = buildExportReadyVersion(
            row.revision,
            row.image_revision,
            cachedOcrRevision,
            row.report_ocr_revision,
          );
        } else {
          exportBlockedReason = readiness.ready ? "需要完整重新分析为自然段识别结果后才能导出" : readiness.message;
        }
      } catch {
        exportBlockedReason = "逐段批改报告字段或语义不符合要求";
      }
    }

    const stateKey = buildSummaryStateKey({
      revision: row.revision,
      imageRevision: row.image_revision,
      ocrRevisionCached: cachedOcrRevision,
      reportOcrRevision: row.report_ocr_revision,
      status: row.status,
      teacherReviewedAt: row.teacher_reviewed_at,
    });

    const pagePlaceholders = requiredPages.map(() => "?").join(", ");
    const readinessSetClause = exportReadyVersion !== null && requiredPages.length > 0
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
      : "export_ready_version = ?, export_blocked_reason = ?,";
    const readinessSetBindings = exportReadyVersion !== null && requiredPages.length > 0
      ? [
          row.id,
          ...requiredPages,
          requiredPages.length,
          exportReadyVersion,
          row.id,
          ...requiredPages,
          requiredPages.length,
        ]
      : [
          exportReadyVersion,
          exportBlockedReason !== null
            ? truncateSummaryField(exportBlockedReason, SUMMARY_BLOCKED_REASON_MAX_CHARS)
            : null,
        ];

    return database.prepare(`
      UPDATE reviews SET
        has_report = ?, summary_title = ?, summary_grade = ?, summary_is_legacy = ?, summary_diagnostics = ?,
        ocr_revision_cached = ?,
        ${readinessSetClause}
        summary_state_key = ?
      WHERE id = ? AND owner_id = ? AND deleting_at IS NULL
        AND analysis_run_id IS ?
        AND revision = ?
        ${SNAPSHOT_CONCURRENCY_GUARD_SQL}
    `).bind(
      summaryFields.hasReport,
      title,
      summaryFields.grade,
      summaryFields.isLegacy,
      summaryFields.diagnosticsJson,
      cachedOcrRevision,
      ...readinessSetBindings,
      stateKey,
      row.id,
      row.owner_id,
      row.analysis_run_id ?? null,
      row.revision,
      ...buildSnapshotConcurrencyBindings(row),
    );
  });

  let updated = staleRows.length;
  if (typeof database.batch === "function") {
    const outcomes = await database.batch(statements);
    if (Array.isArray(outcomes)) {
      updated = outcomes.reduce((sum, item) => sum + Number(item?.meta?.changes ?? 0), 0);
    }
  }
  const lastRow = staleRows[staleRows.length - 1]!;
  return { fetched: staleRows.length, updated, nextCursor: cursorFromSummaryRow(lastRow) };
}

/**
 * 按硬上限（单批总读取最多 20 条）使用权威 deliveryReadiness() 精确回填缺失或陈旧的摘要字段。
 * 若写入瞬间与并发 OCR 修正竞争，旧快照写入自动跳过并在剩余读取预算内立即重算。
 */
export async function backfillReviewSummaryBatch(
  database: D1Database,
  options?: { ownerId?: string; limit?: number; onlyPendingExport?: boolean; cursor?: SummaryBackfillCursor | null },
): Promise<number> {
  const budget = Math.min(MAX_SUMMARY_BACKFILL_BATCH, Math.max(1, Math.trunc(options?.limit ?? MAX_SUMMARY_BACKFILL_BATCH)));
  const first = await runSummaryBackfillCursorStep(database, {
    ownerId: options?.ownerId,
    limit: budget,
    onlyPendingExport: options?.onlyPendingExport,
    cursor: options?.cursor,
  });
  if (first.fetched === 0) return 0;
  let totalUpdated = first.updated;
  const remainingBudget = budget - first.fetched;
  if (first.updated < first.fetched && remainingBudget > 0 && options?.cursor === undefined) {
    const retry = await runSummaryBackfillCursorStep(database, {
      ownerId: options?.ownerId,
      limit: Math.min(remainingBudget, first.fetched - first.updated),
      onlyPendingExport: options?.onlyPendingExport,
    });
    totalUpdated += retry.updated;
  }
  return totalUpdated;
}

/**
 * 迁移后离线/发布前全库分批权威回填入口：每批最多处理 20 条；
 * 采用 Keyset 游标（priorityTier, updated_at, created_at, id）向后扫描整表，即便前排存在任意数量持续冲突行，
 * 也必先处理完后续全部无冲突记录，再从头复扫瞬时冲突行，绝不卡在队首饿死后续正常记录。
 */
export async function backfillReviewSummaries(
  database: D1Database,
  options?: { ownerId?: string; batchSize?: number; maxBatches?: number },
): Promise<number> {
  const batchSize = Math.min(MAX_SUMMARY_BACKFILL_BATCH, Math.max(1, Math.trunc(options?.batchSize ?? MAX_SUMMARY_BACKFILL_BATCH)));
  const maxBatches = options?.maxBatches ?? 10_000;
  let totalUpdated = 0;
  let cursor: SummaryBackfillCursor | null = null;
  let sweepFetched = 0;
  let sweepUpdated = 0;
  let zeroProgressSweeps = 0;

  for (let round = 0; round < maxBatches; round += 1) {
    const pass = await runSummaryBackfillCursorStep(database, {
      ownerId: options?.ownerId,
      limit: batchSize,
      cursor,
    });
    if (pass.fetched === 0) {
      if (cursor === null && sweepFetched === 0) {
        // 从队首起已无任何待回填记录
        break;
      }
      if (sweepUpdated === 0) {
        zeroProgressSweeps += 1;
        if (zeroProgressSweeps >= 2) break;
      } else {
        zeroProgressSweeps = 0;
      }
      cursor = null;
      sweepFetched = 0;
      sweepUpdated = 0;
      continue;
    }
    totalUpdated += pass.updated;
    sweepFetched += pass.fetched;
    sweepUpdated += pass.updated;
    if (pass.fetched < batchSize) {
      // 本轮扫描已抵达表尾，重置游标进入下一轮顶部核对/冲突复扫
      if (sweepUpdated === 0) {
        zeroProgressSweeps += 1;
        if (zeroProgressSweeps >= 2) break;
      } else {
        zeroProgressSweeps = 0;
      }
      cursor = null;
      sweepFetched = 0;
      sweepUpdated = 0;
    } else {
      cursor = pass.nextCursor;
    }
  }
  return totalUpdated;
}
