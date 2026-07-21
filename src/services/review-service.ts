import { randomUUID } from "node:crypto";

import type { AiReviewEnvelope, AssignmentConfig } from "../domain/contracts";
import type {
  ReviewRecord,
  ReviewRepository,
  TeacherReviewEdits,
} from "../db/review-repository";
import type { ReviewFileStore } from "../storage/review-file-store";
import type { RetentionService } from "../retention/retention-service";
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
  retention?: Pick<RetentionService, "delete">;
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

export const reviewImageVariants = ["original", "annotation", "ai"] as const;
export type ReviewImageVariant = (typeof reviewImageVariants)[number];

export class ReviewService {
  private readonly createId: () => string;
  private readonly createRunId: () => string;
  private readonly lock: ReviewLock;
  private readonly recovery: Promise<void>;
  private readonly retention?: Pick<RetentionService, "delete">;

  constructor(
    private readonly repository: ReviewRepository,
    private readonly fileStore: ReviewFileStore,
    private readonly aiReviewer: AiReviewer,
    options: ReviewServiceOptions = {},
  ) {
    this.createId = options.createId ?? randomUUID;
    this.createRunId = options.createRunId ?? randomUUID;
    this.lock = options.lock ?? new InMemoryReviewLock();
    this.retention = options.retention;
    this.recovery = this.fileStore.recoverStagedDeletes(
      (_ownerId, id) => this.repository.exists(id),
    );
  }

  list(ownerId: string): ReviewRecord[] {
    return this.repository.list(ownerId);
  }

  get(ownerId: string, id: string): ReviewRecord {
    const review = this.repository.getById(ownerId, id);
    if (!review) throw new ReviewServiceError("REVIEW_NOT_FOUND", "批改记录不存在", 404);
    return review;
  }

  async readImageFile(
    ownerId: string,
    id: string,
    imageId: number,
    variant: ReviewImageVariant,
  ): Promise<{
    data: Buffer;
    contentType: string;
  }> {
    const review = this.get(ownerId, id);
    await this.fileStore.migrateLegacyReview(ownerId, id);
    const image = review.images.find((candidate) => candidate.id === imageId);
    if (!image) {
      throw new ReviewServiceError("FILE_NOT_FOUND", "图片不存在", 404);
    }
    const storedPath = image[`${variant}Path`];
    if (!/^images\/[^/\\\0]+$/.test(storedPath)) {
      throw new ReviewServiceError("INVALID_FILE_PATH", "图片路径无效", 400);
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
          ownerId,
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

  async create(ownerId: string, config: AssignmentConfig): Promise<ReviewRecord> {
    await this.recovery;
    const id = this.createId();
    await this.fileStore.createReview(ownerId, id);
    try {
      return this.repository.create(ownerId, { id, config });
    } catch (error) {
      await this.fileStore.deleteReview(ownerId, id);
      throw error;
    }
  }

  async update(ownerId: string, id: string, input: TeacherReviewEdits): Promise<ReviewRecord> {
    return this.lock.runExclusive(id, async () => {
      const current = this.get(ownerId, id);
      await this.fileStore.migrateLegacyReview(ownerId, id);
      const updated = this.repository.updateTeacherEdits(ownerId, id, input);
      if (current.pdfFilename) {
        await this.fileStore.queuePdfCleanup(ownerId, id, [current.pdfFilename]);
      }
      return updated;
    });
  }

  async delete(ownerId: string, id: string): Promise<void> {
    await this.recovery;
    if (this.retention) {
      await this.retention.delete(ownerId, id);
      return;
    }
    await this.lock.runExclusive(id, async () => {
      this.get(ownerId, id);
      await this.fileStore.migrateLegacyReview(ownerId, id);
      const staged = await this.fileStore.stageDelete(ownerId, id);
      try {
        this.repository.delete(ownerId, id);
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

  async analyze(ownerId: string, id: string): Promise<{
    review: ReviewRecord;
    pageWarnings: string[];
  }> {
    await this.recovery;
    const prepared = await this.lock.runExclusive(id, async () => {
      const review = this.get(ownerId, id);
      await this.fileStore.migrateLegacyReview(ownerId, id);
      if (review.images.length < 1 || review.images.length > 3) {
        throw new ReviewServiceError(
          "IMAGES_REQUIRED",
          "请先上传 1 至 3 张作文图片",
          422,
        );
      }
      const token = this.repository.beginAnalysis(
        ownerId,
        id,
        this.createRunId(),
        review.revision,
      );
      if (review.pdfFilename) {
        await this.fileStore.queuePdfCleanup(ownerId, id, [review.pdfFilename]);
      }
      try {
        const imageDataUrls = await Promise.all(
          review.images.map(async (image) => {
            const filename = image.aiPath.replace(/^images\//, "");
            const data = await this.fileStore.readFile(ownerId, id, "images", filename);
            return `data:image/jpeg;base64,${data.toString("base64")}`;
          }),
        );
        return { review, token, imageDataUrls };
      } catch (error) {
        this.repository.failAnalysis(ownerId, id, token);
        throw error;
      }
    });

    let envelope: AiReviewEnvelope;
    try {
      envelope = await this.aiReviewer.analyze({
        config: prepared.review.config,
        imageDataUrls: prepared.imageDataUrls,
      });
    } catch (error) {
      await this.lock.runExclusive(id, async () => {
        this.repository.failAnalysis(ownerId, id, prepared.token);
      });
      throw error;
    }

    try {
      const saved = await this.lock.runExclusive(id, async () =>
        this.repository.saveAnalysis(ownerId, id, prepared.token, envelope),
      );
      return { review: saved, pageWarnings: envelope.pageWarnings };
    } catch (error) {
      await this.lock.runExclusive(id, async () => {
        this.repository.failAnalysis(ownerId, id, prepared.token);
      });
      throw error;
    }
  }
}
