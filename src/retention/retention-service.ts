import type { ReviewRepository, RetentionCandidate } from "../db/review-repository";
import { ReviewNotFoundError } from "../db/review-repository";
import type { SecurityEventInput } from "../auth/auth-types";
import { InMemoryReviewLock, type ReviewLock } from "../services/review-lock";
import type { ReviewFileStore } from "../storage/review-file-store";

interface RetentionAudit {
  recordSecurityEvent(input: SecurityEventInput): unknown;
}

export interface RetentionServiceOptions {
  now?: () => Date;
  lock?: ReviewLock;
  audit?: RetentionAudit;
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
  private readonly lock: ReviewLock;
  private readonly audit?: RetentionAudit;

  constructor(
    private readonly repository: ReviewRepository,
    private readonly fileStore: ReviewFileStore,
    options: RetentionServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.lock = options.lock ?? new InMemoryReviewLock();
    this.audit = options.audit;
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
      const outcome = await this.lock.runExclusive(candidate.id, () =>
        this.processCandidate(candidate, false),
      );
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
    // A request that observed the review before waiting for the lock succeeds
    // when a concurrent cleanup finishes first. A genuinely absent review stays
    // a 404 to preserve the owner-scoped API contract.
    const existedBeforeWaiting = this.repository.existsOwned(ownerId, reviewId);
    if (!existedBeforeWaiting) throw new ReviewNotFoundError(reviewId);
    await this.lock.runExclusive(reviewId, async () => {
    const now = this.now();
    const marked = this.repository.markDeleting(ownerId, reviewId, now, { force: true });
    if (!marked) {
      if (!this.repository.existsOwned(ownerId, reviewId)) return;
      throw new ReviewNotFoundError(reviewId);
    }
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
    });
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
      if (!claimed) {
        // Another manual/automatic caller may have finalized the same record
        // while this candidate was waiting for the shared lock.
        if (!this.repository.existsOwned(candidate.ownerId, candidate.id)) {
          return { claimed: false, deleted: true };
        }
        return this.failure(candidate.ownerId, claimed, "NOT_FOUND");
      }

      // 任务取消先于文件删除，避免 worker 在删除期间重新写入作文目录。
      this.repository.cancelActiveAnalysis(candidate.ownerId, candidate.id, this.now());
      // Older installations may still hold the only copy under .data/reviews.
      // Migrate it while deletion is exclusively locked, then remove that exact
      // tenant-scoped review directory.
      await this.fileStore.migrateLegacyReview(candidate.ownerId, candidate.id);
      await this.fileStore.deleteReview(candidate.ownerId, candidate.id);
      const finalized = this.repository.finalizeDeletion(candidate.ownerId, candidate.id);
      if (finalized || !this.repository.existsOwned(candidate.ownerId, candidate.id)) {
        return { claimed: true, deleted: true };
      }
      return this.failure(candidate.ownerId, claimed, "FINALIZE_FAILED");
    } catch (error) {
      return this.failure(candidate.ownerId, claimed, safeErrorCode(error));
    }
  }

  private failure(
    ownerId: string,
    claimed: boolean,
    code: string,
  ): { claimed: boolean; deleted: false; errorCode: string } {
    try {
      this.audit?.recordSecurityEvent({
        userId: ownerId,
        eventType: "retention.delete_failed",
        metadata: { code },
      });
    } catch {
      // Audit storage failure must not erase the durable deletingAt retry mark.
    }
    return { claimed, deleted: false, errorCode: code };
  }
}
