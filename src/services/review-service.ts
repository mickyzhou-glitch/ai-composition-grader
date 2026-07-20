import { randomUUID } from "node:crypto";

import type { AiReviewEnvelope, AssignmentConfig } from "../domain/contracts";
import type {
  ReviewRecord,
  ReviewRepository,
  TeacherReviewEdits,
} from "../db/review-repository";
import type { ReviewFileStore } from "../storage/review-file-store";
import { InMemoryReviewLock, type ReviewLock } from "./review-lock";

export interface AiReviewer {
  analyze(input: {
    config: AssignmentConfig;
    imageDataUrls: string[];
  }): Promise<AiReviewEnvelope>;
}

interface ReviewServiceOptions {
  createId?: () => string;
  createRunId?: () => string;
  lock?: ReviewLock;
}

export class ReviewServiceError extends Error {
  constructor(
    readonly code:
      | "REVIEW_NOT_FOUND"
      | "IMAGES_REQUIRED"
      | "INVALID_FILE_PATH"
      | "FILE_NOT_FOUND",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ReviewServiceError";
  }
}

export class ReviewService {
  private readonly createId: () => string;
  private readonly createRunId: () => string;
  private readonly lock: ReviewLock;
  private readonly recovery: Promise<void>;

  constructor(
    private readonly repository: ReviewRepository,
    private readonly fileStore: ReviewFileStore,
    private readonly aiReviewer: AiReviewer,
    options: ReviewServiceOptions = {},
  ) {
    this.createId = options.createId ?? randomUUID;
    this.createRunId = options.createRunId ?? randomUUID;
    this.lock = options.lock ?? new InMemoryReviewLock();
    this.recovery = this.fileStore.recoverStagedDeletes(
      (id) => this.repository.getById(id) !== null,
    );
  }

  list(): ReviewRecord[] {
    return this.repository.list();
  }

  get(id: string): ReviewRecord {
    const review = this.repository.getById(id);
    if (!review) throw new ReviewServiceError("REVIEW_NOT_FOUND", "批改记录不存在", 404);
    return review;
  }

  async readImageFile(id: string, storedPath: string): Promise<{
    data: Buffer;
    contentType: string;
  }> {
    const review = this.get(id);
    if (!/^images\/[^/\\\0]+$/.test(storedPath)) {
      throw new ReviewServiceError("INVALID_FILE_PATH", "图片路径无效", 400);
    }
    const registered = review.images.some((image) =>
      [image.originalPath, image.annotationPath, image.aiPath].includes(storedPath),
    );
    if (!registered) {
      throw new ReviewServiceError("FILE_NOT_FOUND", "图片不存在", 404);
    }
    const extension = storedPath.split(".").at(-1)?.toLowerCase();
    const contentTypes: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      heic: "image/heic",
      heif: "image/heif",
    };
    const contentType = extension ? contentTypes[extension] : undefined;
    if (!contentType) {
      throw new ReviewServiceError("INVALID_FILE_PATH", "图片格式无效", 400);
    }
    try {
      return {
        data: await this.fileStore.readFile(
          id,
          "images",
          storedPath.slice("images/".length),
        ),
        contentType,
      };
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        throw new ReviewServiceError("FILE_NOT_FOUND", "图片不存在", 404);
      }
      throw error;
    }
  }

  async create(config: AssignmentConfig): Promise<ReviewRecord> {
    await this.recovery;
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
    await this.recovery;
    await this.lock.runExclusive(id, async () => {
      this.get(id);
      const staged = await this.fileStore.stageDelete(id);
      try {
        if (!this.repository.delete(id)) {
          throw new ReviewServiceError(
            "REVIEW_NOT_FOUND",
            "批改记录不存在",
            404,
          );
        }
      } catch (error) {
        await staged.rollback();
        throw error;
      }
      try {
        await staged.commit();
      } catch {
        // The DB deletion is authoritative; startup recovery retries trash cleanup.
      }
    });
  }

  async analyze(id: string): Promise<{
    review: ReviewRecord;
    pageWarnings: string[];
  }> {
    await this.recovery;
    const review = this.get(id);
    if (review.images.length < 1 || review.images.length > 3) {
      throw new ReviewServiceError(
        "IMAGES_REQUIRED",
        "请先上传 1 至 3 张作文图片",
        422,
      );
    }
    const token = this.repository.beginAnalysis(
      id,
      this.createRunId(),
      review.revision,
    );
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
        review: this.repository.saveAnalysis(id, token, envelope),
        pageWarnings: envelope.pageWarnings,
      };
    } catch (error) {
      this.repository.failAnalysis(id, token);
      throw error;
    }
  }
}
