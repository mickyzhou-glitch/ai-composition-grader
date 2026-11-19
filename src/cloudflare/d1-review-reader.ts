import { isParagraphEvaluationReport } from "../domain/contracts";
import { composeReviewGuidance, readReviewGuidance } from "../grading-opinions/review-guidance";
import { listD1EssayOpinions, listD1StandingOpinions } from "./d1-grading-opinions";
import {
  annotationSchema,
  assignmentConfigSchema,
  evaluationReportSchema,
  normalizedCropSchema,
  reviewStatusSchema,
} from "../domain/contracts";
import { deliveryReadiness } from "../delivery/readiness";
import { describePublicAnalysisFailure } from "../jobs/public-analysis-failure";
import { readStoredOcrCheckpoint } from "../ocr/contracts";
import { D1OcrCheckpointRepository } from "./d1-ocr-checkpoint";

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

export class D1ReviewReader {
  constructor(private readonly database: D1Database) {}

  async classes(ownerId: string): Promise<string[]> {
    const { results = [] } = await this.database.prepare(`
      SELECT DISTINCT class_name FROM reviews
      WHERE owner_id = ? AND deleting_at IS NULL AND class_name <> '' ORDER BY class_name
    `).bind(ownerId).all<{ class_name: string }>();
    return results.map((row) => row.class_name);
  }

  async list(ownerId: string): Promise<unknown[]> {
    const { results = [] } = await this.database.prepare(`
      SELECT id, status, student_name, class_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, pdf_filename, pdf_path, pdf_revision, exported_at, teacher_reviewed_at, rejection_reason, rejection_change_request, expires_at, created_at, updated_at
      FROM reviews WHERE owner_id = ? AND deleting_at IS NULL ORDER BY updated_at DESC, created_at DESC
    `).bind(ownerId).all<ReviewRow>();
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
