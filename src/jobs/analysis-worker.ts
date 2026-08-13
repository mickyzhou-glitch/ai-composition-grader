import type { AiReviewEnvelope, AssignmentConfig } from "../domain/contracts";
import type { CompositionReviewResult } from "../ai/composition-review-adapter";
import type { VisionOcrResult } from "../ai/vision-ocr-adapter";
import type { AnalysisToken } from "../db/review-repository";
import { mapAnnotationAnchors } from "../ocr/annotation-mapper";
import type { OcrCheckpoint } from "../ocr/contracts";
import { ReviewPreparationError } from "../services/review-service";
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
    stage:
      | "saving_ocr"
      | "generating_review"
      | "mapping_annotations"
      | "validating_result"
      | "saving_result",
  ): ClaimedAnalysisJobRecord;
  transition(
    claim: AnalysisJobClaim,
    status: Extract<AnalysisJobStatus, "succeeded" | "failed" | "canceled">,
    options?: { errorCode?: string | null; message?: string | null },
  ): unknown;
  renewLease(id: string, expectedLeaseExpiresAt: Date): ClaimedAnalysisJobRecord | null;
  retry(claim: AnalysisJobClaim, errorCode: string): "queued" | "at_limit";
}

export interface AnalysisExecutionService {
  prepare(ownerId: string, reviewId: string, mode?: "full" | "content_only"): Promise<{
    token: AnalysisToken;
    config: AssignmentConfig;
    imageDataUrls: string[];
    imageRevision?: number;
    checkpoint?: OcrCheckpoint | null;
    studentName?: string;
  }>;
  analyze(input: {
    config: AssignmentConfig;
    imageDataUrls: string[];
    teacherGuidance?: string;
    studentName?: string;
  }): Promise<AiReviewEnvelope>;
  recognize?(imageDataUrls: string[]): Promise<VisionOcrResult>;
  saveOcr?(
    ownerId: string,
    reviewId: string,
    token: AnalysisToken,
    imageRevision: number,
    pages: VisionOcrResult["pages"],
  ): Promise<OcrCheckpoint>;
  analyzeText?(input: {
    config: AssignmentConfig;
    pages: Array<{ pageIndex: number; text: string }>;
    teacherGuidance?: string;
    studentName?: string;
  }): Promise<CompositionReviewResult>;
  save(
    ownerId: string,
    reviewId: string,
    token: AnalysisToken,
    envelope: AiReviewEnvelope,
    claim: AnalysisJobClaim,
    expectedOcrRevision?: number,
  ): Promise<unknown>;
  fail(
    ownerId: string,
    reviewId: string,
    token: AnalysisToken,
    claim: AnalysisJobClaim,
    errorCode: string,
  ): Promise<unknown>;
}

export type WorkerRunResult =
  | { jobId: string; outcome: "succeeded" }
  | { jobId: string; outcome: "retrying"; errorCode: string }
  | { jobId: string; outcome: "failed"; errorCode: string }
  | { jobId: string; outcome: "canceled"; errorCode: "ANALYSIS_CONFLICT" | "REVISION_CONFLICT" }
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
      if (code === "OCR_NOT_FOUND") return code;
      if (code === "JOB_CLAIM_LOST") return code;
      if (code === "ANALYSIS_CONFLICT" || code === "REVISION_CONFLICT") return code;
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
      prepared = await this.execution.prepare(claim.ownerId, claim.reviewId, claim.mode);
      this.assertClaimCurrent(claimLost, claim.id);
      const dualModel = this.execution.recognize && this.execution.saveOcr && this.execution.analyzeText;
      let checkpoint = prepared.checkpoint ?? null;
      let envelope: AiReviewEnvelope;
      if (dualModel) {
        if (!checkpoint) {
          if (claim.mode === "content_only") {
            throw Object.assign(new Error("OCR_NOT_FOUND"), { code: "OCR_NOT_FOUND" });
          }
          if (prepared.imageRevision === undefined) throw new TypeError("imageRevision is required");
          const recognized = await this.execution.recognize!(prepared.imageDataUrls);
          this.assertClaimCurrent(claimLost, claim.id);
          claim = this.jobs.updateProgress(claim, "saving_ocr");
          checkpoint = await this.execution.saveOcr!(
            claim.ownerId,
            claim.reviewId,
            prepared.token,
            prepared.imageRevision,
            recognized.pages,
          );
        } else {
          claim = this.jobs.updateProgress(claim, "saving_ocr");
        }
        if (checkpoint.pages.some((page) => !page.readable)) {
          envelope = {
            readable: false,
            pageWarnings: checkpoint.pages.flatMap(({ warnings }) => warnings),
            annotations: [],
          };
        } else {
          claim = this.jobs.updateProgress(claim, "generating_review");
          const result = await this.execution.analyzeText!({
            config: prepared.config,
            pages: checkpoint.pages.map(({ pageIndex, text }) => ({ pageIndex, text })),
            teacherGuidance: claim.teacherGuidance ?? undefined,
            studentName: prepared.studentName,
          });
          envelope = {
            readable: true,
            pageWarnings: checkpoint.pages.flatMap(({ warnings }) => warnings),
            report: result.report,
            annotations: mapAnnotationAnchors(checkpoint, result.annotationAnchors),
          };
        }
      } else {
        claim = this.jobs.updateProgress(claim, "saving_ocr");
        claim = this.jobs.updateProgress(claim, "generating_review");
        envelope = await this.execution.analyze({
          config: prepared.config,
          imageDataUrls: prepared.imageDataUrls,
          teacherGuidance: claim.teacherGuidance ?? undefined,
          studentName: prepared.studentName,
        });
      }
      this.assertClaimCurrent(claimLost, claim.id);
      if (claim.progressStage === "saving_ocr") {
        claim = this.jobs.updateProgress(claim, "generating_review");
      }
      claim = this.jobs.updateProgress(claim, "mapping_annotations");
      claim = this.jobs.updateProgress(claim, "validating_result");
      // The adapter performs schema repair and validation before returning, so
      // this stage records that the validated envelope is ready to persist.
      claim = this.jobs.updateProgress(claim, "saving_result");
      await this.execution.save(
        claim.ownerId,
        claim.reviewId,
        prepared.token,
        envelope,
        claim,
        checkpoint?.ocrRevision,
      );
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
      if (errorCode === "ANALYSIS_CONFLICT" || errorCode === "REVISION_CONFLICT") {
        try {
          this.jobs.transition(claim, "canceled", { errorCode, message: null });
          return { jobId: claim.id, outcome: "canceled", errorCode };
        } catch (cancelError) {
          if (cancelError instanceof AnalysisJobLostClaimError || safeErrorCode(cancelError) === "JOB_CLAIM_LOST") {
            return { jobId: claim.id, outcome: "claim_lost" };
          }
          throw cancelError;
        }
      }
      if (isRetryable(errorCode)) {
        try {
          const state = this.jobs.retry(claim, errorCode);
          if (state === "queued") return { jobId: claim.id, outcome: "retrying", errorCode };
        } catch (retryError) {
          if (retryError instanceof AnalysisJobLostClaimError) {
            return { jobId: claim.id, outcome: "claim_lost" };
          }
          throw retryError;
        }
      }
      const failureToken = prepared?.token
        ?? (error instanceof ReviewPreparationError ? error.token : null);
      if (!failureToken) {
        // Validation can fail before a review enters analyzing (for example,
        // no uploaded images). The claim still must terminate without taking
        // the worker process down; the draft itself remains unchanged.
        try {
          this.jobs.transition(claim, "failed", { errorCode, message: null });
        } catch (failureError) {
          if (failureError instanceof AnalysisJobLostClaimError || safeErrorCode(failureError) === "JOB_CLAIM_LOST") {
            return { jobId: claim.id, outcome: "claim_lost" };
          }
          throw failureError;
        }
        return { jobId: claim.id, outcome: "failed", errorCode };
      }
      try {
        await this.execution.fail(claim.ownerId, claim.reviewId, failureToken, claim, errorCode);
      } catch (failureError) {
        if (failureError instanceof AnalysisJobLostClaimError || safeErrorCode(failureError) === "JOB_CLAIM_LOST") {
          return { jobId: claim.id, outcome: "claim_lost" };
        }
        // The atomic transaction rolled both records back; leave the lease
        // recoverable rather than claiming a terminal outcome that was not saved.
        throw failureError;
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
