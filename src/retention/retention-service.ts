import type { ReviewRepository, RetentionCandidate } from "../db/review-repository";
import { ReviewNotFoundError } from "../db/review-repository";
import type { ReviewFileStore } from "../storage/review-file-store";

export interface RetentionServiceOptions {
  now?: () => Date;
}
export interface RetentionInspectItem {
  id: string;
  ownerId: string;
  expiresAt: Date | null;
  deletingAt: Date | null;
}

export interface RetentionRunResult {
  inspected: number;
  claimed: number;
  deleted: number;
  failed: number;
  errors: Array<{ id: string; ownerId: string; code: string }>;
}

function safeErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "UNKNOWN";
  if ("code" in error && typeof error.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)) {
    return error.code;
  }
  if (error instanceof Error && error.name && /^[A-Z0-9_]{1,64}$/.test(error.name)) {
    return error.name;
  }
  return "STORAGE_ERROR";
}

/**
 * 作文到期和手动删除共用的幂等删除状态机。
 * deletingAt 是数据库中的恢复标记：文件或数据库任何一步失败时都不清除它，
 * 下次 run 会继续精确删除同一 owner/review 目录并完成收尾。
 */
export class RetentionService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: ReviewRepository,
    private readonly fileStore: ReviewFileStore,
    options: RetentionServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  inspect(): RetentionInspectItem[] {
    return this.repository.listRetentionCandidates(this.now()).map((item) => ({
      id: item.id,
      ownerId: item.ownerId,
      expiresAt: item.expiresAt ?? null,
      deletingAt: item.deletingAt ?? null,
    }));
  }

  async run(): Promise<RetentionRunResult> {
    const candidates = this.repository.listRetentionCandidates(this.now());
    const result: RetentionRunResult = {
      inspected: candidates.length,
      claimed: 0,
      deleted: 0,
      failed: 0,
      errors: [],
    };
    for (const candidate of candidates) {
      const outcome = await this.processCandidate(candidate, false);
      if (outcome.claimed) result.claimed += 1;
      if (outcome.deleted) result.deleted += 1;
      if (!outcome.deleted && outcome.errorCode) {
        result.failed += 1;
        result.errors.push({
          id: candidate.id,
          ownerId: candidate.ownerId,
          code: outcome.errorCode,
        });
      }
    }
    return result;
  }

  async delete(ownerId: string, reviewId: string): Promise<void> {
    const now = this.now();
    const marked = this.repository.markDeleting(ownerId, reviewId, now, { force: true });
    if (!marked) throw new ReviewNotFoundError(reviewId);
    const candidate: RetentionCandidate = {
      id: reviewId,
      ownerId,
      createdAt: now,
      expiresAt: null,
      deletingAt: now,
      imageCount: 0,
    };
    const outcome = await this.processCandidate(candidate, true);
    if (!outcome.deleted) {
      const error = new Error("作文删除暂未完成");
      error.name = outcome.errorCode ?? "RETENTION_DELETE_FAILED";
      throw error;
    }
  }

  private async processCandidate(
    candidate: RetentionCandidate,
    alreadyClaimed: boolean,
  ): Promise<{ claimed: boolean; deleted: boolean; errorCode?: string }> {
    let claimed = alreadyClaimed || candidate.deletingAt !== null;
    try {
      if (!claimed) {
        claimed = this.repository.markDeleting(candidate.ownerId, candidate.id, this.now());
      }
      if (!claimed) return { claimed: false, deleted: false, errorCode: "NOT_FOUND" };

      // 任务取消先于文件删除，避免 worker 在删除期间重新写入作文目录。
      this.repository.cancelActiveAnalysis(candidate.ownerId, candidate.id, this.now());
      await this.fileStore.deleteReview(candidate.ownerId, candidate.id);
      const finalized = this.repository.finalizeDeletion(candidate.ownerId, candidate.id);
      return { claimed: true, deleted: finalized };
    } catch (error) {
      return { claimed, deleted: false, errorCode: safeErrorCode(error) };
    }
  }
}
