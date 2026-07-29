import {
  annotationSchema,
  assignmentConfigSchema,
  evaluationReportSchema,
  normalizedCropSchema,
  reviewStatusSchema,
} from "../domain/contracts";

interface ReviewRow {
  id: string;
  status: string;
  student_name: string;
  config: string;
  report: string | null;
  revision: number;
  pdf_filename: string | null;
  pdf_path: string | null;
  pdf_revision: number | null;
  exported_at: number | null;
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
      SELECT id, status, student_name, config, report, revision, pdf_filename, pdf_path, pdf_revision, exported_at, expires_at, created_at, updated_at
      FROM reviews WHERE owner_id = ? AND deleting_at IS NULL ORDER BY updated_at DESC, created_at DESC
    `).bind(ownerId).all<ReviewRow>();
    return Promise.all(results.map((review) => this.hydrate(ownerId, review)));
  }

  async get(ownerId: string, reviewId: string): Promise<unknown | null> {
    const row = await this.database.prepare(`
      SELECT id, status, student_name, config, report, revision, pdf_filename, pdf_path, pdf_revision, exported_at, expires_at, created_at, updated_at
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
    const hasPdf = review.pdf_filename !== null && review.pdf_path === `pdf/${review.pdf_filename}` && review.pdf_revision === review.revision && review.exported_at !== null;
    return {
      id: review.id, status: reviewStatusSchema.parse(review.status), studentName: review.student_name, config, report,
      revision: review.revision, createdAt: date(review.created_at), updatedAt: date(review.updated_at), expiresAt: date(review.expires_at),
      images, annotations, hasPdf, pdfFilename: hasPdf ? review.pdf_filename : null,
    };
  }
}

function normalizedRotation(value: number): 0 | 90 | 180 | 270 {
  if (value === 0 || value === 90 || value === 180 || value === 270) return value;
  throw new TypeError("Invalid image rotation");
}
