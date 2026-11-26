import {
  isParagraphEvaluationReport,
} from "../domain/contracts";
import { composeReviewGuidance, readReviewGuidance } from "../grading-opinions/review-guidance";
import { listD1EssayOpinions, listD1StandingOpinions } from "./d1-grading-opinions";
import {
  annotationSchema,
  assignmentConfigSchema,
  evaluationReportSchema,
  normalizedCropSchema,
  reviewStatusSchema,
  type ReviewStatus,
} from "../domain/contracts";
import { deliveryReadiness } from "../delivery/readiness";
import { describePublicAnalysisFailure } from "../jobs/public-analysis-failure";
import { readStoredOcrCheckpoint } from "../ocr/contracts";
import { D1OcrCheckpointRepository } from "./d1-ocr-checkpoint";
import { D1ClassRosters } from "./d1-class-rosters";
import type { TitleSubmissionItemView } from "../domain/class-roster";
import {
  backfillReviewSummaryBatch,
  EXPECTED_SUMMARY_KEY_SQL,
  parseSummaryDiagnostics,
  runSummaryBackfillCursorStep,
  summaryEligibilityFromMaterialized,
} from "./review-summary-state";
import type {
  ReviewHistoryStatsView,
  ReviewSummaryPageView,
  ReviewSummaryView,
} from "../../app/lib/types";
import {
  normalizeStudentSearch,
  type HistoryStatusFilter,
} from "../../app/lib/review-queue";

interface ReviewRow {
  id: string;
  status: string;
  student_name: string;
  class_name: string;
  config: string;
  report: string | null;
  revision: number;
  image_revision: number;
  ocr_checkpoint: string | null;
  report_ocr_revision: number | null;
  pdf_filename: string | null;
  pdf_path: string | null;
  pdf_revision: number | null;
  exported_at: number | null;
  teacher_reviewed_at: number | null;
  rejection_reason: string | null;
  rejection_change_request: string | null;
  teacher_guidance?: string | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ImageRow {
  id: number;
  review_id: string;
  position: number;
  original_name: string;
  mime_type: string;
  original_path: string;
  annotation_path: string;
  ai_path: string;
  width: number;
  height: number;
  rotation: number;
  crop: string | null;
}

interface AnnotationRow {
  review_id?: string;
  position: number;
  page_index: number;
  x: number;
  y: number;
  category: string;
  anchor_text: string;
  comment: string;
  is_highlight: number;
}

interface FailureRow {
  review_id?: string;
  error_code: string | null;
  progress_stage: string;
  message: string | null;
}

const D1_IN_CLAUSE_CHUNK_SIZE = 80;

function chunkItems<T>(items: readonly T[], size = D1_IN_CLAUSE_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function date(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

const MAX_LAZY_BACKFILL_PER_REQUEST = 20;

const EXPECTED_EXPORT_READY_SQL = `(
  CAST(revision AS TEXT) || ':' || CAST(image_revision AS TEXT) || ':' ||
  CAST(COALESCE(ocr_revision_cached, -1) AS TEXT) || ':' ||
  CAST(COALESCE(report_ocr_revision, -1) AS TEXT)
)`;

function buildSummaryFilterWhere(
  ownerId: string,
  classFilter: string | null,
  titleFilter: string | null,
  statusFilter: HistoryStatusFilter,
  normalizedSearch: string,
): { whereSql: string; bindings: unknown[] } {
  const clauses: string[] = ["owner_id = ?", "deleting_at IS NULL"];
  const bindings: unknown[] = [ownerId];

  if (classFilter !== null) {
    clauses.push("COALESCE(class_name, '') = ?");
    bindings.push(classFilter);
  }
  if (titleFilter !== null) {
    clauses.push("COALESCE(summary_title, '') = ?");
    bindings.push(titleFilter);
  }
  if (normalizedSearch) {
    clauses.push("instr(LOWER(COALESCE(student_name, '')), ?) > 0");
    bindings.push(normalizedSearch);
  }
  if (statusFilter === "draft") {
    clauses.push("status = 'draft'");
  } else if (statusFilter === "review") {
    clauses.push(
      "teacher_reviewed_at IS NULL AND (status IN ('analyzing', 'needs_better_images') OR (status = 'ready_for_review' AND COALESCE(has_report, 0) = 1))",
    );
  } else if (statusFilter === "failed") {
    clauses.push("(status = 'failed' OR (status = 'ready_for_review' AND COALESCE(has_report, 0) = 0))");
  } else if (statusFilter === "reviewed") {
    clauses.push("teacher_reviewed_at IS NOT NULL AND status <> 'exported'");
  } else if (statusFilter === "exported") {
    clauses.push("status = 'exported'");
  } else if (statusFilter === "rejected") {
    clauses.push("status = 'rejected'");
  }

  return { whereSql: clauses.join(" AND "), bindings };
}

interface SummaryStatsQueryRow {
  total: number;
  draft: number;
  review: number;
  failed: number;
  reviewed: number;
  exported: number;
  rejected: number;
  stale_summary_count: number;
}

interface SummaryPageScalarRow {
  id: string;
  status: string;
  student_name: string | null;
  class_name: string | null;
  revision: number;
  image_revision: number;
  has_report: number;
  summary_title: string | null;
  summary_grade: string | null;
  summary_is_legacy: number | null;
  summary_diagnostics?: string | null;
  ocr_revision_cached: number | null;
  report_ocr_revision: number | null;
  export_ready_version: string | null;
  export_blocked_reason: string | null;
  summary_state_key: string | null;
  pdf_filename: string | null;
  pdf_path: string | null;
  pdf_revision: number | null;
  exported_at: number | null;
  teacher_reviewed_at: number | null;
  created_at: number;
  updated_at: number;
}

export class D1ReviewReader {
  constructor(private readonly database: D1Database) {}

  async classes(ownerId: string): Promise<string[]> {
    const [reviewClassesResult, rosterClasses] = await Promise.all([
      this.database.prepare(`
        SELECT DISTINCT class_name FROM reviews
        WHERE owner_id = ? AND deleting_at IS NULL AND class_name <> '' ORDER BY class_name
      `).bind(ownerId).all<{ class_name: string }>(),
      new D1ClassRosters(this.database).classNames(ownerId),
    ]);
    return [...new Set([
      ...(reviewClassesResult.results ?? []).map((row) => row.class_name),
      ...rosterClasses,
    ].filter(Boolean))].sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));
  }

  async list(
    ownerId: string,
    options?: { ids?: readonly string[]; scope?: "pending_export" },
  ): Promise<unknown[]> {
    let results: ReviewRow[];
    if (options?.ids !== undefined) {
      const requestedIds = [...new Set(options.ids)];
      if (requestedIds.length === 0) return [];
      const chunks = await Promise.all(chunkItems(requestedIds).map(async (chunk) => {
        const placeholders = chunk.map(() => "?").join(", ");
        const { results: rows = [] } = await this.database.prepare(`
          SELECT id, status, student_name, class_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, pdf_filename, pdf_path, pdf_revision, exported_at, teacher_reviewed_at, rejection_reason, rejection_change_request, expires_at, created_at, updated_at
          FROM reviews WHERE owner_id = ? AND deleting_at IS NULL AND id IN (${placeholders}) ORDER BY updated_at DESC, created_at DESC
        `).bind(ownerId, ...chunk).all<ReviewRow>();
        return rows;
      }));
      results = chunks.flat().sort((left, right) => (right.updated_at - left.updated_at) || (right.created_at - left.created_at));
    } else if (options?.scope === "pending_export") {
      const queried = await this.database.prepare(`
        SELECT id, status, student_name, class_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, pdf_filename, pdf_path, pdf_revision, exported_at, teacher_reviewed_at, rejection_reason, rejection_change_request, expires_at, created_at, updated_at
        FROM reviews
        WHERE owner_id = ?
          AND deleting_at IS NULL
          AND teacher_reviewed_at IS NOT NULL
          AND status <> 'exported'
        ORDER BY updated_at DESC, created_at DESC
      `).bind(ownerId).all<ReviewRow>();
      results = queried.results ?? [];
    } else {
      const queried = await this.database.prepare(`
        SELECT id, status, student_name, class_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, pdf_filename, pdf_path, pdf_revision, exported_at, teacher_reviewed_at, rejection_reason, rejection_change_request, expires_at, created_at, updated_at
        FROM reviews WHERE owner_id = ? AND deleting_at IS NULL ORDER BY updated_at DESC, created_at DESC
      `).bind(ownerId).all<ReviewRow>();
      results = queried.results ?? [];
    }
    if (results.length === 0) return [];
    const reviewIds = results.map((review) => review.id);
    const failedReviewIds = results.filter((review) => review.status === "failed").map((review) => review.id);
    const [imagesByReview, annotationsByReview, failuresByReview] = await Promise.all([
      this.batchImages(reviewIds),
      this.batchAnnotations(reviewIds),
      failedReviewIds.length > 0 ? this.batchLatestFailures(ownerId, failedReviewIds) : Promise.resolve(new Map<string, ReturnType<typeof describePublicAnalysisFailure>>()),
    ]);
    return Promise.all(results.map((review) => this.hydrate(ownerId, review, false, {
      images: imagesByReview.get(review.id) ?? [],
      annotations: annotationsByReview.get(review.id) ?? [],
      analysisFailure: failuresByReview.get(review.id) ?? null,
    })));
  }

  async summaryByIds(ownerId: string, ids: readonly string[]): Promise<ReviewSummaryView[]> {
    const requestedIds = [...new Set(ids)];
    if (requestedIds.length === 0) return [];

    for (const backfillChunk of chunkItems(requestedIds, MAX_LAZY_BACKFILL_PER_REQUEST)) {
      const placeholders = backfillChunk.map(() => "?").join(", ");
      const staleRow = await this.database.prepare(`
        SELECT COALESCE(SUM(CASE WHEN summary_state_key IS NULL OR summary_state_key <> ${EXPECTED_SUMMARY_KEY_SQL} THEN 1 ELSE 0 END), 0) AS stale_count
        FROM reviews
        WHERE owner_id = ? AND deleting_at IS NULL AND id IN (${placeholders})
      `).bind(ownerId, ...backfillChunk).first<{ stale_count: number }>();
      if ((staleRow?.stale_count ?? 0) > 0) {
        await runSummaryBackfillCursorStep(this.database, {
          ownerId,
          ids: backfillChunk,
          limit: backfillChunk.length,
        });
      }
    }

    const rowChunks = await Promise.all(chunkItems(requestedIds).map(async (chunk) => {
      const placeholders = chunk.map(() => "?").join(", ");
      const { results: rows = [] } = await this.database.prepare(`
        SELECT id, status, student_name, class_name, revision, image_revision,
               COALESCE(has_report, 0) AS has_report,
               summary_title, summary_grade, summary_is_legacy, summary_diagnostics,
               ocr_revision_cached, report_ocr_revision,
               export_ready_version, export_blocked_reason, summary_state_key,
               pdf_filename, pdf_path, pdf_revision, exported_at, teacher_reviewed_at,
               created_at, updated_at
        FROM reviews
        WHERE owner_id = ? AND deleting_at IS NULL AND id IN (${placeholders})
        ORDER BY updated_at DESC, created_at DESC, id DESC
      `).bind(ownerId, ...chunk).all<SummaryPageScalarRow>();
      return rows;
    }));
    const rows = rowChunks
      .flat()
      .sort((left, right) => (right.updated_at - left.updated_at) || (right.created_at - left.created_at) || right.id.localeCompare(left.id));
    if (rows.length === 0) return [];
    const failedIds = rows.filter((row) => row.status === "failed").map((row) => row.id);
    const failuresByReview = failedIds.length > 0
      ? await this.batchLatestFailures(ownerId, failedIds)
      : new Map<string, ReturnType<typeof describePublicAnalysisFailure>>();
    return rows.map((row) => this.mapScalarSummaryRow(row, failuresByReview.get(row.id) ?? null));
  }

  async pendingExportSummaries(ownerId: string): Promise<ReviewSummaryView[]> {
    const staleRow = await this.database.prepare(`
      SELECT COALESCE(SUM(CASE WHEN summary_state_key IS NULL OR summary_state_key <> ${EXPECTED_SUMMARY_KEY_SQL} THEN 1 ELSE 0 END), 0) AS stale_count
      FROM reviews
      WHERE owner_id = ? AND deleting_at IS NULL AND teacher_reviewed_at IS NOT NULL AND status <> 'exported'
    `).bind(ownerId).first<{ stale_count: number }>();

    if ((staleRow?.stale_count ?? 0) > 0) {
      await backfillReviewSummaryBatch(this.database, {
        ownerId,
        limit: MAX_LAZY_BACKFILL_PER_REQUEST,
        onlyPendingExport: true,
      });
    }

    const { results: rows = [] } = await this.database.prepare(`
      SELECT id, status, student_name, class_name, revision, image_revision,
             COALESCE(has_report, 0) AS has_report,
             summary_title, summary_grade, summary_is_legacy, summary_diagnostics,
             ocr_revision_cached, report_ocr_revision,
             export_ready_version, export_blocked_reason, summary_state_key,
             pdf_filename, pdf_path, pdf_revision, exported_at, teacher_reviewed_at,
             created_at, updated_at
      FROM reviews
      WHERE owner_id = ?
        AND deleting_at IS NULL
        AND teacher_reviewed_at IS NOT NULL
        AND status <> 'exported'
      ORDER BY updated_at DESC, created_at DESC, id DESC
    `).bind(ownerId).all<SummaryPageScalarRow>();

    return rows.map((row) => this.mapScalarSummaryRow(row, null));
  }

  async summaryPage(
    ownerId: string,
    options?: {
      page?: number;
      pageSize?: number;
      classFilter?: string | null;
      titleFilter?: string | null;
      statusFilter?: HistoryStatusFilter;
      studentSearch?: string;
    },
  ): Promise<ReviewSummaryPageView> {
    const requestedPage = Math.max(1, Math.trunc(options?.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.trunc(options?.pageSize ?? 20)));
    const classFilter = options?.classFilter ?? null;
    const titleFilter = options?.titleFilter ?? null;
    const statusFilter: HistoryStatusFilter = options?.statusFilter ?? "";
    const normalizedSearch = normalizeStudentSearch(options?.studentSearch ?? "");

    // 第 1 步：纯标量聚合统计（不读 report / ocr_checkpoint / config 溢出页，也不读 review_images）
    let statsRow = await this.querySummaryStats(ownerId);
    if ((statsRow?.stale_summary_count ?? 0) > 0) {
      // 仅针对尚未回填的历史行执行严格有界（单次最多 20 条）的权威回填；常规写入路径 stale_summary_count 恒为 0
      await backfillReviewSummaryBatch(this.database, {
        ownerId,
        limit: MAX_LAZY_BACKFILL_PER_REQUEST,
      });
      statsRow = await this.querySummaryStats(ownerId);
    }

    const stats: ReviewHistoryStatsView = {
      total: Number(statsRow?.total ?? 0),
      draft: Number(statsRow?.draft ?? 0),
      review: Number(statsRow?.review ?? 0),
      failed: Number(statsRow?.failed ?? 0),
      reviewed: Number(statsRow?.reviewed ?? 0),
      exported: Number(statsRow?.exported ?? 0),
      rejected: Number(statsRow?.rejected ?? 0),
    };

    const { whereSql, bindings } = buildSummaryFilterWhere(ownerId, classFilter, titleFilter, statusFilter, normalizedSearch);
    const canMatchFailed = statusFilter === "" || statusFilter === "failed";
    const exportableBindings: unknown[] = [
      ownerId,
      ...(classFilter !== null ? [classFilter] : []),
      ...(titleFilter !== null ? [titleFilter] : []),
    ];
    const shouldLoadTitleSubmissions = titleFilter !== null && titleFilter !== "";
    const titleSubmissionBindings: unknown[] = shouldLoadTitleSubmissions
      ? [ownerId, titleFilter, ...(classFilter !== null ? [classFilter] : [])]
      : [];

    // 第 2 步：并行查询班级列表、题目列表、班级花名册、当前筛选可导出 ID、当前筛选总数、失败记录与所选题目的交齐比对行
    const [
      classesResult,
      titlesResult,
      rosters,
      exportableResult,
      filteredCountRow,
      failedRowsResult,
      titleSubmissionsResult,
    ] = await Promise.all([
      this.database.prepare(`
        SELECT DISTINCT class_name FROM reviews
        WHERE owner_id = ? AND deleting_at IS NULL AND class_name <> ''
      `).bind(ownerId).all<{ class_name: string }>(),
      this.database.prepare(`
        SELECT summary_title, MAX(updated_at) AS latest_at
        FROM reviews
        WHERE owner_id = ? AND deleting_at IS NULL AND COALESCE(summary_title, '') <> ''
        GROUP BY summary_title
        ORDER BY latest_at DESC, summary_title ASC
      `).bind(ownerId).all<{ summary_title: string; latest_at: number }>(),
      new D1ClassRosters(this.database).list(ownerId),
      this.database.prepare(`
        SELECT id
        FROM reviews
        WHERE owner_id = ?
          AND deleting_at IS NULL
          AND teacher_reviewed_at IS NOT NULL
          AND status NOT IN ('exported', 'rejected')
          ${classFilter !== null ? "AND COALESCE(class_name, '') = ?" : ""}
          ${titleFilter !== null ? "AND COALESCE(summary_title, '') = ?" : ""}
          AND export_ready_version = ${EXPECTED_EXPORT_READY_SQL}
        ORDER BY updated_at DESC, created_at DESC, id DESC
      `).bind(...exportableBindings).all<{ id: string }>(),
      this.database.prepare(`
        SELECT COUNT(*) AS total_filtered FROM reviews WHERE ${whereSql}
      `).bind(...bindings).first<{ total_filtered: number }>(),
      canMatchFailed
        ? this.database.prepare(`
            SELECT id, student_name FROM reviews
            WHERE ${whereSql} AND status = 'failed'
            ORDER BY updated_at DESC, created_at DESC, id DESC
          `).bind(...bindings).all<{ id: string; student_name: string | null }>()
        : Promise.resolve({ results: [] as Array<{ id: string; student_name: string | null }> }),
      shouldLoadTitleSubmissions
        ? this.database.prepare(`
            SELECT id, class_name, student_name, status, teacher_reviewed_at
            FROM reviews
            WHERE owner_id = ?
              AND deleting_at IS NULL
              AND COALESCE(summary_title, '') = ?
              ${classFilter !== null ? "AND COALESCE(class_name, '') = ?" : ""}
            ORDER BY updated_at DESC, created_at DESC, id DESC
            LIMIT 1001
          `).bind(...titleSubmissionBindings).all<{
            id: string;
            class_name: string | null;
            student_name: string | null;
            status: string;
            teacher_reviewed_at: number | null;
          }>()
        : Promise.resolve({
            results: [] as Array<{
              id: string;
              class_name: string | null;
              student_name: string | null;
              status: string;
              teacher_reviewed_at: number | null;
            }>,
          }),
    ]);

    const classes = [...new Set([
      ...(classesResult.results ?? []).map((row) => row.class_name),
      ...rosters.map((roster) => roster.className),
    ].filter(Boolean))].sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));

    const titles = (titlesResult.results ?? [])
      .map((row) => row.summary_title)
      .filter((title): title is string => Boolean(title));

    const rawTitleSubmissions = titleSubmissionsResult.results ?? [];
    const titleSubmissionsTruncated = rawTitleSubmissions.length > 1000;
    const titleSubmissions: TitleSubmissionItemView[] | undefined = shouldLoadTitleSubmissions
      ? rawTitleSubmissions.slice(0, 1000).map((row) => ({
          id: row.id,
          className: row.class_name ?? "",
          studentName: row.student_name ?? "",
          status: reviewStatusSchema.parse(row.status),
          teacherReviewedAt: date(row.teacher_reviewed_at),
        }))
      : undefined;

    const exportableReviewedIds = (exportableResult.results ?? []).map((row) => row.id);
    const matchingFailed = (failedRowsResult.results ?? []).map((row) => ({
      id: row.id,
      studentName: row.student_name ?? "",
    }));

    const totalFiltered = Number(filteredCountRow?.total_filtered ?? 0);
    const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * pageSize;

    // 第 3 步：仅按 LIMIT ? OFFSET ? 读取当前页最多 pageSize 条轻量标量摘要列（零 report / ocr_checkpoint / review_images 读取）
    const pageRows: SummaryPageScalarRow[] = totalFiltered > 0
      ? ((await this.database.prepare(`
          SELECT id, status, student_name, class_name, revision, image_revision,
                 COALESCE(has_report, 0) AS has_report,
                 summary_title, summary_grade, summary_is_legacy, summary_diagnostics,
                 ocr_revision_cached, report_ocr_revision,
                 export_ready_version, export_blocked_reason, summary_state_key,
                 pdf_filename, pdf_path, pdf_revision, exported_at, teacher_reviewed_at,
                 created_at, updated_at
          FROM reviews
          WHERE ${whereSql}
          ORDER BY updated_at DESC, created_at DESC, id DESC
          LIMIT ? OFFSET ?
        `).bind(...bindings, pageSize, offset).all<SummaryPageScalarRow>()).results ?? [])
      : [];

    const pageFailedIds = pageRows
      .filter((row) => row.status === "failed")
      .map((row) => row.id);
    const failuresByReview = pageFailedIds.length > 0
      ? await this.batchLatestFailures(ownerId, pageFailedIds)
      : new Map<string, ReturnType<typeof describePublicAnalysisFailure>>();

    const items: ReviewSummaryView[] = pageRows.map((row) =>
      this.mapScalarSummaryRow(row, failuresByReview.get(row.id) ?? null),
    );

    const remainingBackfill = Number(statsRow?.stale_summary_count ?? 0);

    return {
      items,
      page,
      pageSize,
      totalFiltered,
      stats,
      classes,
      titles,
      rosters,
      ...(titleSubmissions !== undefined ? { titleSubmissions } : {}),
      ...(titleSubmissionsTruncated ? { titleSubmissionsTruncated: true } : {}),
      exportableReviewedIds,
      matchingFailed,
      ...(remainingBackfill > 0 ? { summaryBackfillPending: remainingBackfill } : {}),
    };
  }

  private mapScalarSummaryRow(
    row: SummaryPageScalarRow,
    failure: ReturnType<typeof describePublicAnalysisFailure> | null,
  ): ReviewSummaryView {
    const status = reviewStatusSchema.parse(row.status);
    const hasReport = Boolean(row.has_report);
    const hasPdf = row.pdf_filename !== null
      && row.pdf_path === `pdf/${row.pdf_filename}`
      && row.pdf_revision === row.revision
      && row.exported_at !== null;
    const diagnostics = parseSummaryDiagnostics(row.summary_diagnostics);
    const expectedStateKey = `${row.revision}:${row.image_revision}:${row.ocr_revision_cached ?? -1}:${row.report_ocr_revision ?? -1}:${status}:${row.teacher_reviewed_at ?? -1}`;
    const summarySyncPending = row.summary_state_key === null || row.summary_state_key !== expectedStateKey;
    return {
      id: row.id,
      status: status as ReviewStatus,
      studentName: row.student_name ?? "",
      className: row.class_name ?? "",
      config: { title: row.summary_title ?? "" },
      revision: row.revision,
      createdAt: date(row.created_at)!,
      updatedAt: date(row.updated_at)!,
      teacherReviewedAt: date(row.teacher_reviewed_at),
      hasReport,
      isLegacyReport: Boolean(row.summary_is_legacy),
      grade: hasReport ? (row.summary_grade ?? null) : null,
      ...(diagnostics ? { diagnostics } : {}),
      hasPdf,
      pdfFilename: hasPdf ? row.pdf_filename : null,
      exportEligibility: summaryEligibilityFromMaterialized({
        status,
        has_report: row.has_report,
        summary_is_legacy: row.summary_is_legacy,
        revision: row.revision,
        image_revision: row.image_revision,
        ocr_revision_cached: row.ocr_revision_cached,
        report_ocr_revision: row.report_ocr_revision,
        teacher_reviewed_at: row.teacher_reviewed_at,
        export_ready_version: row.export_ready_version,
        export_blocked_reason: row.export_blocked_reason,
        summary_state_key: row.summary_state_key,
      }),
      ...(summarySyncPending ? { summarySyncPending: true } : {}),
      ...(failure ? { analysisFailure: failure } : {}),
    };
  }

  private async querySummaryStats(ownerId: string): Promise<SummaryStatsQueryRow | null> {
    return this.database.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END), 0) AS draft,
        COALESCE(SUM(CASE WHEN teacher_reviewed_at IS NULL
          AND (status IN ('analyzing', 'needs_better_images') OR (status = 'ready_for_review' AND COALESCE(has_report, 0) = 1))
          THEN 1 ELSE 0 END), 0) AS review,
        COALESCE(SUM(CASE WHEN status = 'failed'
          OR (status = 'ready_for_review' AND COALESCE(has_report, 0) = 0)
          THEN 1 ELSE 0 END), 0) AS failed,
        COALESCE(SUM(CASE WHEN teacher_reviewed_at IS NOT NULL AND status <> 'exported' THEN 1 ELSE 0 END), 0) AS reviewed,
        COALESCE(SUM(CASE WHEN status = 'exported' THEN 1 ELSE 0 END), 0) AS exported,
        COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
        COALESCE(SUM(CASE WHEN summary_state_key IS NULL OR summary_state_key <> ${EXPECTED_SUMMARY_KEY_SQL} THEN 1 ELSE 0 END), 0) AS stale_summary_count
      FROM reviews
      WHERE owner_id = ? AND deleting_at IS NULL
    `).bind(ownerId).first<SummaryStatsQueryRow>();
  }

  async queue(ownerId: string): Promise<unknown[]> {
    const { results = [] } = await this.database.prepare(`
      SELECT id, student_name, class_name, config, status, revision, created_at
      FROM reviews
      WHERE owner_id = ?
        AND deleting_at IS NULL
        AND teacher_reviewed_at IS NULL
        AND report IS NOT NULL
        AND status IN ('ready_for_review', 'exported')
        AND (
          ocr_checkpoint IS NULL
          OR report_ocr_revision = json_extract(ocr_checkpoint, '$.ocrRevision')
        )
      ORDER BY created_at ASC, id ASC
    `).bind(ownerId).all<Pick<ReviewRow, "id" | "student_name" | "class_name" | "config" | "status" | "revision" | "created_at">>();
    return results.map((review) => ({
      id: review.id,
      studentName: review.student_name, className: review.class_name ?? "",
      title: assignmentConfigSchema.parse(JSON.parse(review.config)).title,
      status: reviewStatusSchema.parse(review.status),
      revision: review.revision,
      createdAt: date(review.created_at),
    }));
  }

  async checkExportable(
    ownerId: string,
    entries: Array<{ id: string; revision: number }>,
  ): Promise<boolean> {
    if (entries.length === 0) return false;
    const requestedPairs = entries.map(() => "(id = ? AND revision = ?)").join(" OR ");
    const { results = [] } = await this.database.prepare(`
      SELECT id, revision, report, image_revision, ocr_checkpoint, report_ocr_revision, teacher_reviewed_at
      FROM reviews
      WHERE owner_id = ?
        AND deleting_at IS NULL
        AND (${requestedPairs})
    `).bind(ownerId, ...entries.flatMap(({ id, revision }) => [id, revision])).all<{
      id: string;
      revision: number;
      report: string | null;
      image_revision: number;
      ocr_checkpoint: string | null;
      report_ocr_revision: number | null;
      teacher_reviewed_at: number | null;
    }>();
    const found = new Set(results.map(({ id, revision }) => `${id}:${revision}`));
    if (
      entries.length !== found.size
      || !entries.every(({ id, revision }) => found.has(`${id}:${revision}`))
    ) return false;
    try {
      const reviewIds = results.map(({ id }) => id);
      const placeholders = reviewIds.map(() => "?").join(", ");
      const { results: imageRows = [] } = await this.database.prepare(`
        SELECT review_id, position, width, height FROM review_images
        WHERE review_id IN (${placeholders}) AND EXISTS (
          SELECT 1 FROM reviews WHERE id = review_images.review_id AND owner_id = ? AND deleting_at IS NULL
        ) ORDER BY position, id
      `).bind(...reviewIds, ownerId).all<{
        review_id?: string;
        position: number;
        width: number;
        height: number;
      }>();
      const imagesByReview = new Map<string, Array<{ position: number; width: number; height: number }>>();
      for (const row of imageRows) {
        const key = row.review_id ?? (reviewIds.length === 1 ? reviewIds[0]! : "");
        if (!key) continue;
        const list = imagesByReview.get(key) ?? [];
        list.push({ position: row.position, width: row.width, height: row.height });
        imagesByReview.set(key, list);
      }
      return results.every((review) => {
        const report = review.report === null ? null : JSON.parse(review.report);
        const checkpoint = readStoredOcrCheckpoint(review.ocr_checkpoint, review.image_revision);
        return deliveryReadiness({
          report,
          teacherReviewedAt: date(review.teacher_reviewed_at),
          reportStale: report !== null && (
            checkpoint === null
            || review.report_ocr_revision !== checkpoint.ocrRevision
          ),
          reportOcrRevision: review.report_ocr_revision,
          ocr: checkpoint,
          images: imagesByReview.get(review.id) ?? [],
        }).ready;
      });
    } catch {
      return false;
    }
  }

  async get(ownerId: string, reviewId: string): Promise<unknown | null> {
    const row = await this.database.prepare(`
      SELECT id, status, student_name, class_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, pdf_filename, pdf_path, pdf_revision, exported_at, teacher_reviewed_at, rejection_reason, rejection_change_request, expires_at, created_at, updated_at,
        (
          SELECT teacher_guidance FROM analysis_jobs
          WHERE analysis_jobs.review_id = reviews.id
            AND analysis_jobs.owner_id = reviews.owner_id
          ORDER BY analysis_jobs.created_at DESC, analysis_jobs.id DESC
          LIMIT 1
        ) AS teacher_guidance
      FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL
    `).bind(reviewId, ownerId).first<ReviewRow>();
    return row ? this.hydrate(ownerId, row, true) : null;
  }

  async imageObjectKey(ownerId: string, reviewId: string, imageId: number, variant: "original" | "annotation" | "ai"): Promise<{ key: string; contentType: string } | null> {
    const row = await this.database.prepare(`
      SELECT review_images.original_path, review_images.annotation_path, review_images.ai_path, review_images.mime_type
      FROM review_images INNER JOIN reviews ON reviews.id = review_images.review_id
      WHERE review_images.id = ? AND review_images.review_id = ? AND reviews.owner_id = ? AND reviews.deleting_at IS NULL
    `).bind(imageId, reviewId, ownerId).first<{ original_path: string; annotation_path: string; ai_path: string; mime_type: string }>();
    if (!row) return null;
    const storedPath = row[`${variant}_path`];
    if (!/^images\/[^/\\\0]+$/u.test(storedPath)) return null;
    return { key: `users/${ownerId}/reviews/${reviewId}/${storedPath}`, contentType: row.mime_type };
  }

  async imageObjectKeyForAi(reviewId: string, imageId: number, variant: "original" | "annotation" | "ai"): Promise<{ key: string; contentType: string } | null> {
    const row = await this.database.prepare(`
      SELECT reviews.owner_id, review_images.original_path, review_images.annotation_path, review_images.ai_path, review_images.mime_type
      FROM review_images INNER JOIN reviews ON reviews.id = review_images.review_id
      WHERE review_images.id = ? AND review_images.review_id = ? AND reviews.deleting_at IS NULL
    `).bind(imageId, reviewId).first<{ owner_id: string; original_path: string; annotation_path: string; ai_path: string; mime_type: string }>();
    if (!row) return null;
    const storedPath = row[`${variant}_path`];
    if (!/^images\/[^/\\\0]+$/u.test(storedPath)) return null;
    return { key: `users/${row.owner_id}/reviews/${reviewId}/${storedPath}`, contentType: row.mime_type };
  }

  async aiImageObjectsForReview(ownerId: string, reviewId: string): Promise<Array<{ key: string; mimeType: string }>> {
    const { results = [] } = await this.database.prepare(`
      SELECT original_path, ai_path, mime_type
      FROM review_images WHERE review_id = ? ORDER BY position, id
    `).bind(reviewId).all<{ original_path?: string | null; ai_path?: string | null; mime_type?: string | null }>();
    return results.map((row) => {
      const candidate = [row.original_path, row.ai_path].find(
        (path): path is string => typeof path === "string" && /^images\/[^/\\\0]+$/u.test(path),
      );
      if (!candidate || typeof row.mime_type !== "string" || !row.mime_type) {
        throw new Error("AI_IMAGE_UNAVAILABLE");
      }
      return { key: `users/${ownerId}/reviews/${reviewId}/${candidate}`, mimeType: row.mime_type };
    });
  }

  async savedAssignments(ownerId: string): Promise<unknown[]> {
    const { results = [] } = await this.database.prepare(`
      SELECT id, config, created_at, updated_at FROM saved_assignments WHERE owner_id = ? ORDER BY updated_at DESC
    `).bind(ownerId).all<{ id: string; config: string; created_at: number; updated_at: number }>();
    return results.map((assignment) => ({
      id: assignment.id,
      config: assignmentConfigSchema.parse(JSON.parse(assignment.config)),
      createdAt: date(assignment.created_at),
      updatedAt: date(assignment.updated_at),
    }));
  }

  private async batchImages(reviewIds: readonly string[]): Promise<Map<string, ImageRow[]>> {
    const grouped = new Map<string, ImageRow[]>();
    for (const chunk of chunkItems(reviewIds)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const { results = [] } = await this.database.prepare(`
        SELECT id, review_id, position, original_name, mime_type, original_path, annotation_path, ai_path, width, height, rotation, crop
        FROM review_images WHERE review_id IN (${placeholders}) ORDER BY position, id
      `).bind(...chunk).all<ImageRow>();
      for (const row of results) {
        const key = row.review_id ?? (chunk.length === 1 ? chunk[0]! : "");
        if (!key) continue;
        const list = grouped.get(key) ?? [];
        list.push(row);
        grouped.set(key, list);
      }
    }
    return grouped;
  }

  private async batchAnnotations(reviewIds: readonly string[]): Promise<Map<string, AnnotationRow[]>> {
    const grouped = new Map<string, AnnotationRow[]>();
    for (const chunk of chunkItems(reviewIds)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const { results = [] } = await this.database.prepare(`
        SELECT review_id, position, page_index, x, y, category, anchor_text, comment, is_highlight
        FROM annotations WHERE review_id IN (${placeholders}) ORDER BY position
      `).bind(...chunk).all<AnnotationRow>();
      for (const row of results) {
        const key = row.review_id ?? (chunk.length === 1 ? chunk[0]! : "");
        if (!key) continue;
        const list = grouped.get(key) ?? [];
        list.push(row);
        grouped.set(key, list);
      }
    }
    return grouped;
  }

  private async batchLatestFailures(
    ownerId: string,
    reviewIds: readonly string[],
  ): Promise<Map<string, ReturnType<typeof describePublicAnalysisFailure>>> {
    const latestByReview = new Map<string, ReturnType<typeof describePublicAnalysisFailure>>();
    for (const chunk of chunkItems(reviewIds)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const { results = [] } = await this.database.prepare(`
        SELECT review_id, error_code, progress_stage, message
        FROM analysis_jobs
        WHERE owner_id = ? AND status = 'failed' AND review_id IN (${placeholders})
        ORDER BY COALESCE(finished_at, created_at) DESC, created_at DESC
      `).bind(ownerId, ...chunk).all<FailureRow>();
      for (const row of results) {
        const key = row.review_id ?? (chunk.length === 1 ? chunk[0]! : "");
        if (!key || latestByReview.has(key)) continue;
        latestByReview.set(key, describePublicAnalysisFailure({
          errorCode: row.error_code,
          progressStage: row.progress_stage,
          rawMessage: row.message,
        }));
      }
    }
    return latestByReview;
  }

  private async hydrate(
    ownerId: string,
    review: ReviewRow,
    includeGuidance = false,
    preloaded?: {
      images: ImageRow[];
      annotations: AnnotationRow[];
      analysisFailure: ReturnType<typeof describePublicAnalysisFailure> | null;
    },
  ): Promise<unknown> {
    let imageRows: ImageRow[];
    let annotationRows: AnnotationRow[];
    if (preloaded) {
      imageRows = preloaded.images;
      annotationRows = preloaded.annotations;
    } else {
      const [imagesResult, annotationsResult] = await Promise.all([
        this.database.prepare(`SELECT id, review_id, position, original_name, mime_type, original_path, annotation_path, ai_path, width, height, rotation, crop FROM review_images WHERE review_id = ? ORDER BY position, id`).bind(review.id).all<ImageRow>(),
        this.database.prepare(`SELECT position, page_index, x, y, category, anchor_text, comment, is_highlight FROM annotations WHERE review_id = ? ORDER BY position`).bind(review.id).all<AnnotationRow>(),
      ]);
      imageRows = imagesResult.results ?? [];
      annotationRows = annotationsResult.results ?? [];
    }
    const images = imageRows.map((image) => ({
      id: image.id, position: image.position, originalName: image.original_name, mimeType: image.mime_type,
      width: image.width, height: image.height, rotation: image.rotation, crop: image.crop === null ? null : JSON.parse(image.crop),
    })).map((image) => ({ ...image, rotation: normalizedRotation(image.rotation), crop: image.crop === null ? null : normalizedCropSchema.parse(image.crop) }));
    const annotations = annotationRows.map((annotation) => annotationSchema.parse({
      pageIndex: annotation.page_index, x: annotation.x, y: annotation.y, category: annotation.category,
      anchorText: annotation.anchor_text, comment: annotation.comment, isHighlight: annotation.is_highlight === 1,
    }));
    const config = assignmentConfigSchema.parse(JSON.parse(review.config));
    const report = review.report === null ? null : evaluationReportSchema.parse(JSON.parse(review.report));
    const currentCheckpoint = readStoredOcrCheckpoint(review.ocr_checkpoint, review.image_revision);
    const ocr = currentCheckpoint ? D1OcrCheckpointRepository.publicView(currentCheckpoint) : null;
    const reportStale = report !== null && (
      currentCheckpoint === null
      || review.report_ocr_revision !== currentCheckpoint.ocrRevision
    );
    const hasPdf = review.pdf_filename !== null && review.pdf_path === `pdf/${review.pdf_filename}` && review.pdf_revision === review.revision && review.exported_at !== null;
    const analysisFailure = preloaded
      ? preloaded.analysisFailure
      : (review.status === "failed" ? await this.latestFailure(ownerId, review.id) : null);
    const layers = readReviewGuidance(review.teacher_guidance);
    const teacherGuidance = report && isParagraphEvaluationReport(report) && report.teacherGuidanceDraft !== undefined
      ? report.teacherGuidanceDraft : layers.current;
    const [essayHistory, standingRules] = includeGuidance ? await Promise.all([
      listD1EssayOpinions(this.database, ownerId, review.id),
      listD1StandingOpinions(this.database, ownerId, config.title),
    ]) : [[], []];
    const effectiveTeacherGuidance = composeReviewGuidance(teacherGuidance, standingRules, essayHistory);
    return {
      id: review.id, status: reviewStatusSchema.parse(review.status), studentName: review.student_name, className: review.class_name ?? "", config, report,
      revision: review.revision, createdAt: date(review.created_at), updatedAt: date(review.updated_at),
      teacherReviewedAt: date(review.teacher_reviewed_at),
      rejectionReason: review.rejection_reason,
      rejectionChangeRequest: review.rejection_change_request,
      teacherGuidance,
      essayHistory,
      effectiveTeacherGuidance,
      expiresAt: date(review.expires_at),
      images, annotations, ocr, reportStale, hasPdf, pdfFilename: hasPdf ? review.pdf_filename : null,
      ...(analysisFailure ? { analysisFailure } : {}),
    };
  }

  private async latestFailure(ownerId: string, reviewId: string) {
    const row = await this.database.prepare(`
      SELECT error_code, progress_stage, message
      FROM analysis_jobs
      WHERE review_id = ? AND owner_id = ? AND status = 'failed'
      ORDER BY COALESCE(finished_at, created_at) DESC, created_at DESC
      LIMIT 1
    `).bind(reviewId, ownerId).first<{
      error_code: string | null;
      progress_stage: string;
      message: string | null;
    }>();
    if (!row) return null;
    return describePublicAnalysisFailure({
      errorCode: row.error_code,
      progressStage: row.progress_stage,
      rawMessage: row.message,
    });
  }
}

function normalizedRotation(value: number): 0 | 90 | 180 | 270 {
  if (value === 0 || value === 90 || value === 180 || value === 270) return value;
  throw new TypeError("Invalid image rotation");
}
