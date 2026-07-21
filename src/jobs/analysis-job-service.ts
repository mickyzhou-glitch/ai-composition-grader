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
  const failedMessage = job.errorCode === "AI_SETTINGS_INCOMPLETE"
    ? "请联系管理员检查 AI 服务设置后再试"
    : job.errorCode === "AI_INVALID_RESPONSE"
      ? "AI 返回格式异常，请稍后重新分析"
      : job.errorCode === "AI_REQUEST_FAILED"
        ? "AI 服务暂时不可用，请稍后重新分析"
        : "分析暂未完成，请稍后重试";
  return {
    id: job.id,
    reviewId: job.reviewId,
    status: job.status,
    progressStage: job.progressStage,
    // Message storage is intentionally not a public error channel: workers may
    // retain diagnostic text while handling upstream failures. Only fixed,
    // teacher-safe terminal copy can cross this boundary.
    message: job.status === "failed"
      ? failedMessage
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
