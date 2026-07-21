import type { AiReviewEnvelope, AssignmentConfig } from "../domain/contracts";
import type { AnalysisToken } from "../db/review-repository";
import type { AnalysisJobStatus } from "../db/schema";
import {
  AnalysisJobLostClaimError,
  type AnalysisJobClaim,
  type ClaimedAnalysisJobRecord,
} from "./analysis-job-repository";

export interface AnalysisJobQueue {
  claimNext(): ClaimedAnalysisJobRecord | null;
  updateProgress(
    claim: AnalysisJobClaim,
    stage: "generating_review" | "validating_result" | "saving_result",
  ): ClaimedAnalysisJobRecord;
  transition(
    claim: AnalysisJobClaim,
    status: Extract<AnalysisJobStatus, "succeeded" | "failed" | "canceled">,
    options?: { errorCode?: string | null; message?: string | null },
  ): unknown;
  renewLease(id: string, expectedLeaseExpiresAt: Date): ClaimedAnalysisJobRecord | null;
  retry(claim: AnalysisJobClaim, errorCode: string): "queued" | "failed";
}

export interface AnalysisExecutionService {
  prepare(ownerId: string, reviewId: string): Promise<{
    token: AnalysisToken;
    config: AssignmentConfig;
    imageDataUrls: string[];
  }>;
  analyze(input: { config: AssignmentConfig; imageDataUrls: string[] }): Promise<AiReviewEnvelope>;
  save(
    ownerId: string,
    reviewId: string,
    token: AnalysisToken,
    envelope: AiReviewEnvelope,
    claim: AnalysisJobClaim,
  ): Promise<unknown>;
  fail(ownerId: string, reviewId: string, token: AnalysisToken): Promise<unknown>;
}

export type WorkerRunResult =
  | { jobId: string; outcome: "succeeded" }
  | { jobId: string; outcome: "retrying"; errorCode: string }
  | { jobId: string; outcome: "failed"; errorCode: string }
  | { jobId: string; outcome: "claim_lost" };

export interface AnalysisWorkerOptions {
  renewEveryMs?: number;
}

const DEFAULT_RENEW_EVERY_MS = 60_000;

function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string") {
      if (code === "AI_SETTINGS_INCOMPLETE") return code;
      if (code === "AI_INVALID_RESPONSE") return code;
      if (code === "AI_REQUEST_FAILED") return code;
      if (code === "IMAGES_REQUIRED") return code;
      if (code === "JOB_CLAIM_LOST") return code;
      if (code === "REVIEW_NOT_FOUND" || code === "NOT_FOUND") return "REVIEW_UNAVAILABLE";
    }
  }
  return "ANALYSIS_FAILED";
}

function isRetryable(errorCode: string): boolean {
  // The adapter already performs its one transport retry and one structure
  // repair request. The durable queue adds at most its configured claim cap.
  return errorCode === "AI_REQUEST_FAILED" || errorCode === "AI_INVALID_RESPONSE";
}

/**
 * One-process worker. It has no HTTP concerns and never logs composition data,
 * model responses, file paths, credentials, or raw exception messages.
 */
export class AnalysisWorker {
  private readonly renewEveryMs: number;
  private active = false;
  private stopping = false;

  constructor(
    private readonly jobs: AnalysisJobQueue,
    private readonly execution: AnalysisExecutionService,
    options: AnalysisWorkerOptions = {},
  ) {
    this.renewEveryMs = options.renewEveryMs ?? DEFAULT_RENEW_EVERY_MS;
    if (!Number.isSafeInteger(this.renewEveryMs) || this.renewEveryMs <= 0) {
      throw new TypeError("renewEveryMs must be positive");
    }
  }

  stop(): void {
    this.stopping = true;
  }

  isStopping(): boolean {
    return this.stopping;
  }

  async runOnce(): Promise<WorkerRunResult | null> {
    if (this.active || this.stopping) return null;
    this.active = true;
    try {
      const initialClaim = this.jobs.claimNext();
      if (!initialClaim) return null;
      return await this.process(initialClaim);
    } finally {
      this.active = false;
    }
  }

  private async process(initialClaim: ClaimedAnalysisJobRecord): Promise<WorkerRunResult> {
    let claim = initialClaim;
    let prepared: Awaited<ReturnType<AnalysisExecutionService["prepare"]>> | null = null;
    let claimLost = false;
    const renew = () => {
      if (claimLost) return;
      try {
        const next = this.jobs.renewLease(claim.id, claim.leaseExpiresAt);
        if (!next) claimLost = true;
        else claim = next;
      } catch {
        // A renewal fault is treated as a lost claim so this process cannot
        // write after its ownership becomes uncertain.
        claimLost = true;
      }
    };
    const timer = setInterval(renew, this.renewEveryMs);
    try {
      prepared = await this.execution.prepare(claim.ownerId, claim.reviewId);
      this.assertClaimCurrent(claimLost, claim.id);
      claim = this.jobs.updateProgress(claim, "generating_review");

      const envelope = await this.execution.analyze({
        config: prepared.config,
        imageDataUrls: prepared.imageDataUrls,
      });
      this.assertClaimCurrent(claimLost, claim.id);
      claim = this.jobs.updateProgress(claim, "validating_result");
      // The adapter performs schema repair and validation before returning, so
      // this stage records that the validated envelope is ready to persist.
      claim = this.jobs.updateProgress(claim, "saving_result");
      await this.execution.save(claim.ownerId, claim.reviewId, prepared.token, envelope, claim);
      this.assertClaimCurrent(claimLost, claim.id);
      return { jobId: claim.id, outcome: "succeeded" };
    } catch (error) {
      if (claimLost || error instanceof AnalysisJobLostClaimError) {
        return { jobId: claim.id, outcome: "claim_lost" };
      }
      const errorCode = safeErrorCode(error);
      if (errorCode === "JOB_CLAIM_LOST") {
        return { jobId: claim.id, outcome: "claim_lost" };
      }
      if (isRetryable(errorCode)) {
        try {
          const state = this.jobs.retry(claim, errorCode);
          if (state === "queued") return { jobId: claim.id, outcome: "retrying", errorCode };
          // retry() already made the job terminal. Do not transition it a
          // second time; only release the review's transient analyzing state.
          if (prepared) {
            try {
              await this.execution.fail(claim.ownerId, claim.reviewId, prepared.token);
            } catch {
              // The queue's durable terminal state remains authoritative.
            }
          }
          return { jobId: claim.id, outcome: "failed", errorCode };
        } catch (retryError) {
          if (retryError instanceof AnalysisJobLostClaimError) {
            return { jobId: claim.id, outcome: "claim_lost" };
          }
          throw retryError;
        }
      }
      // A terminal error must also release the review's transient "analyzing"
      // state. This is idempotent if preparation already failed it locally.
      try {
        if (prepared) {
          await this.execution.fail(claim.ownerId, claim.reviewId, prepared.token);
        }
      } catch {
        // Never replace the safe queue result with a raw storage/upstream error.
      }
      try {
        this.jobs.transition(claim, "failed", { errorCode, message: null });
      } catch (transitionError) {
        if (transitionError instanceof AnalysisJobLostClaimError) {
          return { jobId: claim.id, outcome: "claim_lost" };
        }
        throw transitionError;
      }
      return { jobId: claim.id, outcome: "failed", errorCode };
    } finally {
      clearInterval(timer);
    }
  }

  private assertClaimCurrent(lost: boolean, id: string): void {
    if (lost) throw new AnalysisJobLostClaimError(id);
  }
}
