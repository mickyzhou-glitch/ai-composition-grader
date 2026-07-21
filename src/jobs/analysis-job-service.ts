import type { AnalysisJobStatus, AnalysisProgressStage } from "../db/schema";
import {
  AnalysisJobRepository,
  type AnalysisJobRecord,
} from "./analysis-job-repository";

export type AnalysisJobView = {
  id: string;
  reviewId: string;
  status: AnalysisJobStatus;
  progressStage: AnalysisProgressStage;
  message: string | null;
  createdAt: string;
  finishedAt: string | null;
};

function toView(job: AnalysisJobRecord): AnalysisJobView {
  return {
    id: job.id,
    reviewId: job.reviewId,
    status: job.status,
    progressStage: job.progressStage,
    // Message storage is intentionally not a public error channel: workers may
    // retain diagnostic text while handling upstream failures. Only fixed,
    // teacher-safe terminal copy can cross this boundary.
    message: job.status === "failed"
      ? "分析暂未完成，请稍后重试"
      : job.status === "canceled"
        ? "作文已删除或已到期，分析已取消"
        : null,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

/** Public facade: it never returns leases, retry counters, error codes, or upstream detail. */
export class AnalysisJobService {
  constructor(private readonly repository: AnalysisJobRepository) {}

  enqueue(ownerId: string, reviewId: string): AnalysisJobView {
    return toView(this.repository.createOrGet(ownerId, reviewId));
  }

  get(ownerId: string, jobId: string): AnalysisJobView {
    return toView(this.repository.requireById(ownerId, jobId));
  }
}
