import { desc, eq, sql } from "drizzle-orm";
import { ZodError } from "zod";

import {
  annotationSchema,
  assignmentConfigSchema,
  reviewStatusSchema,
  type Annotation,
  type AssignmentConfig,
  type EvaluationReport,
  type NormalizedCrop,
  type ReviewStatus,
} from "../domain/contracts";
import { validateReport } from "../domain/report-validation";
import type { AppDatabase } from "./client";
import { annotations, reviewImages, reviews } from "./schema";

export interface ReviewImageInput {
  position: number;
  originalName: string;
  mimeType: string;
  originalPath: string;
  annotationPath: string;
  aiPath: string;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  crop: NormalizedCrop | null;
}

export interface ReviewImage extends ReviewImageInput {
  id: number;
  reviewId: string;
  createdAt: Date;
}

export interface ReviewRecord {
  id: string;
  status: ReviewStatus;
  config: AssignmentConfig;
  report: EvaluationReport | null;
  createdAt: Date;
  updatedAt: Date;
  images: ReviewImage[];
  annotations: Annotation[];
}

export interface CreateReviewInput {
  id: string;
  config: AssignmentConfig;
  status?: ReviewStatus;
  images?: ReviewImageInput[];
}

interface ReviewRepositoryOptions {
  now?: () => Date;
}

export class ReviewNotFoundError extends Error {
  constructor(id: string) {
    super(`Review not found: ${id}`);
    this.name = "ReviewNotFoundError";
  }
}

export class CorruptReviewDataError extends Error {
  constructor(id: string, field: string) {
    super(`Corrupt review data in ${field} for review: ${id}`);
    this.name = "CorruptReviewDataError";
  }
}

function validateImage(image: ReviewImageInput): ReviewImageInput {
  if (!Number.isInteger(image.position) || image.position < 0) {
    throw new TypeError("image.position must be a non-negative integer");
  }
  for (const [field, value] of Object.entries({
    originalName: image.originalName,
    mimeType: image.mimeType,
    originalPath: image.originalPath,
    annotationPath: image.annotationPath,
    aiPath: image.aiPath,
  })) {
    if (value.trim().length === 0) throw new TypeError(`image.${field} must not be empty`);
  }
  if (!Number.isInteger(image.width) || image.width <= 0) {
    throw new TypeError("image.width must be a positive integer");
  }
  if (!Number.isInteger(image.height) || image.height <= 0) {
    throw new TypeError("image.height must be a positive integer");
  }
  if (![0, 90, 180, 270].includes(image.rotation)) {
    throw new TypeError("image.rotation must be 0, 90, 180, or 270");
  }
  return { ...image };
}

export class ReviewRepository {
  private readonly now: () => Date;

  constructor(
    private readonly database: AppDatabase,
    options: ReviewRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  create(input: CreateReviewInput): ReviewRecord {
    const config = assignmentConfigSchema.parse(input.config);
    const status = reviewStatusSchema.parse(input.status ?? "draft");
    const images = (input.images ?? []).map(validateImage);
    const now = this.now();

    this.database.transaction((transaction) => {
      transaction.insert(reviews).values({
        id: input.id,
        config,
        status,
        report: null,
        createdAt: now,
        updatedAt: now,
      }).run();

      if (images.length > 0) {
        transaction.insert(reviewImages).values(
          images.map((image) => ({
            reviewId: input.id,
            pageIndex: image.position,
            path: image.annotationPath,
            ...image,
            createdAt: now,
          })),
        ).run();
      }
    });

    return this.requireById(input.id);
  }

  createReview(input: CreateReviewInput): ReviewRecord {
    return this.create(input);
  }

  getById(id: string): ReviewRecord | null {
    return this.database.transaction((database) => {
    const review = database
      .select({
        id: reviews.id,
        status: reviews.status,
        createdAt: reviews.createdAt,
        updatedAt: reviews.updatedAt,
      })
      .from(reviews)
      .where(eq(reviews.id, id))
      .get();

    if (!review) return null;

    let storedConfig: unknown;
    try {
      const configJson = database
        .select({ config: sql<string>`${reviews.config}` })
        .from(reviews)
        .where(eq(reviews.id, id))
        .get()?.config;
      storedConfig = configJson === undefined ? undefined : JSON.parse(configJson);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new CorruptReviewDataError(id, "config");
    }

    let config: AssignmentConfig;
    try {
      config = assignmentConfigSchema.parse(storedConfig);
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      throw new CorruptReviewDataError(id, "config");
    }
    let status: ReviewStatus;
    try {
      status = reviewStatusSchema.parse(review.status);
    } catch (error) {
      if (!(error instanceof ZodError)) throw error;
      throw new CorruptReviewDataError(id, "status");
    }
    let report: EvaluationReport | null = null;
    let storedReport: unknown;
    try {
      const reportJson = database
        .select({ report: sql<string | null>`${reviews.report}` })
        .from(reviews)
        .where(eq(reviews.id, id))
        .get()?.report;
      storedReport =
        reportJson === null || reportJson === undefined
          ? reportJson
          : JSON.parse(reportJson);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new CorruptReviewDataError(id, "report");
    }
    if (storedReport !== null) {
      try {
        report = validateReport(storedReport, {
          templateType: config.templateType,
        });
      } catch {
        throw new CorruptReviewDataError(id, "report");
      }
    }

    const storedImages = database
      .select()
      .from(reviewImages)
      .where(eq(reviewImages.reviewId, id))
      .orderBy(reviewImages.position, reviewImages.id)
      .all();
    const images: ReviewImage[] = storedImages.map((image) => {
      if (![0, 90, 180, 270].includes(image.rotation)) {
        throw new CorruptReviewDataError(id, "images.rotation");
      }
      return {
        id: image.id,
        reviewId: image.reviewId,
        position: image.position,
        originalName: image.originalName,
        mimeType: image.mimeType,
        originalPath: image.originalPath,
        annotationPath: image.annotationPath,
        aiPath: image.aiPath,
        width: image.width,
        height: image.height,
        rotation: image.rotation as ReviewImageInput["rotation"],
        crop: image.crop,
        createdAt: image.createdAt,
      };
    });
    const storedAnnotations = database
      .select()
      .from(annotations)
      .where(eq(annotations.reviewId, id))
      .orderBy(annotations.position)
      .all();

    return {
      ...review,
      config,
      status,
      report,
      images,
      annotations: storedAnnotations.map((annotation) => ({
        pageIndex: annotation.pageIndex,
        x: annotation.x,
        y: annotation.y,
        category: annotation.category,
        anchorText: annotation.anchorText,
        comment: annotation.comment,
        isHighlight: annotation.isHighlight,
      })),
    };
    });
  }

  getReview(id: string): ReviewRecord | null {
    return this.getById(id);
  }

  list(): ReviewRecord[] {
    return this.database
      .select({ id: reviews.id })
      .from(reviews)
      .orderBy(desc(reviews.updatedAt), desc(reviews.createdAt))
      .all()
      .map(({ id }) => this.requireById(id));
  }

  listReviews(): ReviewRecord[] {
    return this.list();
  }

  updateReport(
    id: string,
    input: EvaluationReport,
    options: { incompleteEvent?: boolean } = {},
  ): ReviewRecord {
    const review = this.requireById(id);
    const report = validateReport(input, {
      templateType: review.config.templateType,
      incompleteEvent: options.incompleteEvent,
    });
    this.database
      .update(reviews)
      .set({ report, updatedAt: this.now() })
      .where(eq(reviews.id, id))
      .run();
    return this.requireById(id);
  }

  updateStatus(id: string, input: ReviewStatus): ReviewRecord {
    this.requireById(id);
    const status = reviewStatusSchema.parse(input);
    this.database
      .update(reviews)
      .set({ status, updatedAt: this.now() })
      .where(eq(reviews.id, id))
      .run();
    return this.requireById(id);
  }

  updateConfig(id: string, input: AssignmentConfig): ReviewRecord {
    const config = assignmentConfigSchema.parse(input);
    const updatedAt = this.now();
    this.database.transaction((transaction) => {
      const current = transaction
        .select({ report: reviews.report })
        .from(reviews)
        .where(eq(reviews.id, id))
        .get();
      if (!current) throw new ReviewNotFoundError(id);

      let reportIsValid = true;
      if (current.report !== null) {
        try {
          validateReport(current.report, { templateType: config.templateType });
        } catch {
          reportIsValid = false;
        }
      }

      transaction
        .update(reviews)
        .set({
          config,
          updatedAt,
          ...(reportIsValid ? {} : { report: null, status: "draft" as const }),
        })
        .where(eq(reviews.id, id))
        .run();
      if (!reportIsValid) {
        transaction.delete(annotations).where(eq(annotations.reviewId, id)).run();
      }
    });
    return this.requireById(id);
  }

  replaceImages(id: string, input: ReviewImageInput[]): ReviewRecord {
    this.requireById(id);
    const images = input.map(validateImage);
    const now = this.now();
    this.database.transaction((transaction) => {
      transaction.delete(reviewImages).where(eq(reviewImages.reviewId, id)).run();
      if (images.length > 0) {
        transaction.insert(reviewImages).values(
          images.map((image) => ({
            reviewId: id,
            pageIndex: image.position,
            path: image.annotationPath,
            ...image,
            createdAt: now,
          })),
        ).run();
      }
      transaction
        .update(reviews)
        .set({ updatedAt: now })
        .where(eq(reviews.id, id))
        .run();
    });
    return this.requireById(id);
  }

  replaceAnnotations(id: string, input: Annotation[]): Annotation[] {
    this.requireById(id);
    const parsed = input.map((annotation) => annotationSchema.parse(annotation));
    const now = this.now();
    this.database.transaction((transaction) => {
      transaction.delete(annotations).where(eq(annotations.reviewId, id)).run();
      if (parsed.length > 0) {
        transaction.insert(annotations).values(
          parsed.map((annotation, position) => ({
            reviewId: id,
            position,
            ...annotation,
          })),
        ).run();
      }
      transaction
        .update(reviews)
        .set({ updatedAt: now })
        .where(eq(reviews.id, id))
        .run();
    });
    return this.requireById(id).annotations;
  }

  delete(id: string): boolean {
    return (
      this.database.delete(reviews).where(eq(reviews.id, id)).run().changes > 0
    );
  }

  deleteReview(id: string): boolean {
    return this.delete(id);
  }

  private requireById(id: string): ReviewRecord {
    const review = this.getById(id);
    if (!review) throw new ReviewNotFoundError(id);
    return review;
  }
}
