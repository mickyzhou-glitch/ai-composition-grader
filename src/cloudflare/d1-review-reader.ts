import {
  annotationSchema,
  assignmentConfigSchema,
  evaluationReportSchema,
  normalizedCropSchema,
  reviewStatusSchema,
} from "../domain/contracts";
import { ocrCheckpointSchema } from "../ocr/contracts";
import { D1OcrCheckpointRepository } from "./d1-ocr-checkpoint";

interface ReviewRow {
  id: string;
  status: string;
  student_name: string;
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
  position: number;
  page_index: number;
  x: number;
  y: number;
  category: string;
  anchor_text: string;
  comment: string;
  is_highlight: number;
}

function date(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export class D1ReviewReader {
  constructor(private readonly database: D1Database) {}

  async list(ownerId: string): Promise<unknown[]> {
    const { results = [] } = await this.database.prepare(`
      SELECT id, status, student_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, pdf_filename, pdf_path, pdf_revision, exported_at, teacher_reviewed_at, expires_at, created_at, updated_at
      FROM reviews WHERE owner_id = ? AND deleting_at IS NULL ORDER BY updated_at DESC, created_at DESC
    `).bind(ownerId).all<ReviewRow>();
    return Promise.all(results.map((review) => this.hydrate(ownerId, review)));
  }

  async queue(ownerId: string): Promise<unknown[]> {
    const { results = [] } = await this.database.prepare(`
      SELECT id, student_name, config, status, revision, created_at
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
    `).bind(ownerId).all<Pick<ReviewRow, "id" | "student_name" | "config" | "status" | "revision" | "created_at">>();
    return results.map((review) => ({
      id: review.id,
      studentName: review.student_name,
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
      SELECT id, revision
      FROM reviews
      WHERE owner_id = ?
        AND deleting_at IS NULL
        AND teacher_reviewed_at IS NOT NULL
        AND report IS NOT NULL
        AND status IN ('ready_for_review', 'exported')
        AND (
          ocr_checkpoint IS NULL
          OR report_ocr_revision = json_extract(ocr_checkpoint, '$.ocrRevision')
        )
        AND (${requestedPairs})
    `).bind(ownerId, ...entries.flatMap(({ id, revision }) => [id, revision])).all<{
      id: string;
      revision: number;
    }>();
    const eligible = new Set(results.map(({ id, revision }) => `${id}:${revision}`));
    return entries.length === eligible.size
      && entries.every(({ id, revision }) => eligible.has(`${id}:${revision}`));
  }

  async get(ownerId: string, reviewId: string): Promise<unknown | null> {
    const row = await this.database.prepare(`
      SELECT id, status, student_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, pdf_filename, pdf_path, pdf_revision, exported_at, teacher_reviewed_at, expires_at, created_at, updated_at
      FROM reviews WHERE id = ? AND owner_id = ? AND deleting_at IS NULL
    `).bind(reviewId, ownerId).first<ReviewRow>();
    return row ? this.hydrate(ownerId, row) : null;
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

  private async hydrate(ownerId: string, review: ReviewRow): Promise<unknown> {
    const [imagesResult, annotationsResult] = await Promise.all([
      this.database.prepare(`SELECT id, review_id, position, original_name, mime_type, original_path, annotation_path, ai_path, width, height, rotation, crop FROM review_images WHERE review_id = ? ORDER BY position, id`).bind(review.id).all<ImageRow>(),
      this.database.prepare(`SELECT position, page_index, x, y, category, anchor_text, comment, is_highlight FROM annotations WHERE review_id = ? ORDER BY position`).bind(review.id).all<AnnotationRow>(),
    ]);
    const images = (imagesResult.results ?? []).map((image) => ({
      id: image.id, position: image.position, originalName: image.original_name, mimeType: image.mime_type,
      width: image.width, height: image.height, rotation: image.rotation, crop: image.crop === null ? null : JSON.parse(image.crop),
    })).map((image) => ({ ...image, rotation: normalizedRotation(image.rotation), crop: image.crop === null ? null : normalizedCropSchema.parse(image.crop) }));
    const annotations = (annotationsResult.results ?? []).map((annotation) => annotationSchema.parse({
      pageIndex: annotation.page_index, x: annotation.x, y: annotation.y, category: annotation.category,
      anchorText: annotation.anchor_text, comment: annotation.comment, isHighlight: annotation.is_highlight === 1,
    }));
    const config = assignmentConfigSchema.parse(JSON.parse(review.config));
    const report = review.report === null ? null : evaluationReportSchema.parse(JSON.parse(review.report));
    const checkpoint = review.ocr_checkpoint === null
      ? null
      : ocrCheckpointSchema.parse(JSON.parse(review.ocr_checkpoint));
    const currentCheckpoint = checkpoint?.sourceRevision === review.image_revision ? checkpoint : null;
    const ocr = currentCheckpoint ? D1OcrCheckpointRepository.publicView(currentCheckpoint) : null;
    const reportStale = report !== null && currentCheckpoint !== null && review.report_ocr_revision !== currentCheckpoint.ocrRevision;
    const hasPdf = review.pdf_filename !== null && review.pdf_path === `pdf/${review.pdf_filename}` && review.pdf_revision === review.revision && review.exported_at !== null;
    return {
      id: review.id, status: reviewStatusSchema.parse(review.status), studentName: review.student_name, config, report,
      revision: review.revision, createdAt: date(review.created_at), updatedAt: date(review.updated_at),
      teacherReviewedAt: date(review.teacher_reviewed_at), expiresAt: date(review.expires_at),
      images, annotations, ocr, reportStale, hasPdf, pdfFilename: hasPdf ? review.pdf_filename : null,
    };
  }
}

function normalizedRotation(value: number): 0 | 90 | 180 | 270 {
  if (value === 0 || value === 90 || value === 180 || value === 270) return value;
  throw new TypeError("Invalid image rotation");
}
