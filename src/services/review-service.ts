import { randomUUID } from "node:crypto";

import type { AiReviewEnvelope, AssignmentConfig } from "../domain/contracts";
import type {
  ReviewRecord,
  ReviewRepository,
  TeacherReviewEdits,
} from "../db/review-repository";
import type { ReviewFileStore } from "../storage/review-file-store";

export interface AiReviewer {
  analyze(input: {
    config: AssignmentConfig;
    imageDataUrls: string[];
  }): Promise<AiReviewEnvelope>;
}

interface ReviewServiceOptions {
  createId?: () => string;
}

export class ReviewServiceError extends Error {
  constructor(
    readonly code: "REVIEW_NOT_FOUND" | "IMAGES_REQUIRED",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ReviewServiceError";
  }
}

export class ReviewService {
  private readonly createId: () => string;

  constructor(
    private readonly repository: ReviewRepository,
    private readonly fileStore: ReviewFileStore,
    private readonly aiReviewer: AiReviewer,
    options: ReviewServiceOptions = {},
  ) {
    this.createId = options.createId ?? randomUUID;
  }

  list(): ReviewRecord[] {
    return this.repository.list();
  }

  get(id: string): ReviewRecord {
    const review = this.repository.getById(id);
    if (!review) throw new ReviewServiceError("REVIEW_NOT_FOUND", "批改记录不存在", 404);
    return review;
  }

  async create(config: AssignmentConfig): Promise<ReviewRecord> {
    const id = this.createId();
    await this.fileStore.createReview(id);
    try {
      return this.repository.create({ id, config });
    } catch (error) {
      await this.fileStore.deleteReview(id);
      throw error;
    }
  }

  update(id: string, input: TeacherReviewEdits): ReviewRecord {
    this.get(id);
    return this.repository.updateTeacherEdits(id, input);
  }

  async delete(id: string): Promise<void> {
    this.get(id);
    await this.fileStore.deleteReview(id);
    this.repository.delete(id);
  }

  async analyze(id: string): Promise<{
    review: ReviewRecord;
    pageWarnings: string[];
  }> {
    const review = this.get(id);
    if (review.images.length < 1 || review.images.length > 3) {
      throw new ReviewServiceError(
        "IMAGES_REQUIRED",
        "请先上传 1 至 3 张作文图片",
        422,
      );
    }
    this.repository.updateStatus(id, "analyzing");
    try {
      const imageDataUrls = await Promise.all(
        review.images.map(async (image) => {
          const filename = image.aiPath.replace(/^images\//, "");
          const data = await this.fileStore.readFile(id, "images", filename);
          return `data:image/jpeg;base64,${data.toString("base64")}`;
        }),
      );
      const envelope = await this.aiReviewer.analyze({
        config: review.config,
        imageDataUrls,
      });
      return {
        review: this.repository.saveAnalysis(id, envelope),
        pageWarnings: envelope.pageWarnings,
      };
    } catch (error) {
      this.repository.updateStatus(id, "failed");
      throw error;
    }
  }
}
