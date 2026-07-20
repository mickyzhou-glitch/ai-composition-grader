import { desc, eq } from "drizzle-orm";

import {
  annotationSchema,
  assignmentConfigSchema,
  reviewStatusSchema,
  type Annotation,
  type AssignmentConfig,
  type EvaluationReport,
  type ReviewStatus,
} from "../domain/contracts";
import { validateReport } from "../domain/report-validation";
import type { AppDatabase } from "./client";
import { annotations, reviewImages, reviews } from "./schema";

export interface ReviewImageInput {
  pageIndex: number;
  path: string;
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

function validateImage(image: ReviewImageInput): ReviewImageInput {
  if (!Number.isInteger(image.pageIndex) || image.pageIndex < 0) {
    throw new TypeError("image.pageIndex must be a non-negative integer");
  }
  if (image.path.trim().length === 0) {
    throw new TypeError("image.path must not be empty");
  }
  return { pageIndex: image.pageIndex, path: image.path };
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
            pageIndex: image.pageIndex,
            path: image.path,
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
    const review = this.database
      .select()
      .from(reviews)
      .where(eq(reviews.id, id))
      .get();

    if (!review) return null;

    const images = this.database
      .select()
      .from(reviewImages)
      .where(eq(reviewImages.reviewId, id))
      .orderBy(reviewImages.pageIndex, reviewImages.id)
      .all();
    const storedAnnotations = this.database
      .select()
      .from(annotations)
      .where(eq(annotations.reviewId, id))
      .orderBy(annotations.position)
      .all();

    return {
      ...review,
      report: review.report ?? null,
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
    this.requireById(id);
    const config = assignmentConfigSchema.parse(input);
    this.database
      .update(reviews)
      .set({ config, updatedAt: this.now() })
      .where(eq(reviews.id, id))
      .run();
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
            pageIndex: image.pageIndex,
            path: image.path,
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
