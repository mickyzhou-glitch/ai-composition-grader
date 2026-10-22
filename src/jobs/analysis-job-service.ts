import type { AnalysisJobMode, AnalysisJobStatus, AnalysisProgressStage } from "../db/schema";
import {
  AnalysisJobRepository,
  type AnalysisJobRecord,
} from "./analysis-job-repository";
import { describePublicAnalysisFailure } from "./public-analysis-failure";

export type AnalysisJobView = {
  id: string;
  reviewId: string;
  status: AnalysisJobStatus;
  progressStage: AnalysisProgressStage;
  message: string | null;
  detail: string | null;
  createdAt: string;
  finishedAt: string | null;
};

function toView(job: AnalysisJobRecord): AnalysisJobView {
  const failure = job.status === "failed"
    ? describePublicAnalysisFailure({
      errorCode: job.errorCode,
      progressStage: job.progressStage,
      rawMessage: job.message,
    })
    : null;
  return {
    id: job.id,
    reviewId: job.reviewId,
    status: job.status,
    progressStage: job.progressStage,
    message: failure?.summary ?? (job.status === "canceled" ? "作文已删除或已到期，分析已取消" : null),
    detail: failure?.detail ?? null,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

/** Public facade: Chinese failure summary plus a sanitized raw note. Never returns leases, retry counters, or error codes. */
export class AnalysisJobService {
  constructor(private readonly repository: AnalysisJobRepository) {}

  enqueue(
    ownerId: string,
    reviewId: string,
    teacherGuidance?: string,
    mode: AnalysisJobMode = "full",
  ): AnalysisJobView {
    return toView(this.repository.createOrGet(ownerId, reviewId, teacherGuidance, mode));
  }

  get(ownerId: string, jobId: string): AnalysisJobView {
    return toView(this.repository.requireById(ownerId, jobId));
  }

  getForReview(ownerId: string, reviewId: string): AnalysisJobView | null {
    const job = this.repository.findLatestByReview(ownerId, reviewId);
    return job ? toView(job) : null;
  }
}
