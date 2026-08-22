import type { AnalysisJobRecord } from "../jobs/analysis-job-repository";
import type {
  BatchReanalysisCommitItem,
  BatchReanalysisCommitResult,
  BatchReanalysisPreview,
  PublicAnalysisJobView,
  RevisionRequestInput,
  RevisionRequestResult,
} from "./contracts";
import { ReanalysisRepository } from "./reanalysis-repository";

function toPublicJobView(job: AnalysisJobRecord): PublicAnalysisJobView {
  return {
    id: job.id,
    reviewId: job.reviewId,
    mode: "content_only",
    status: job.status,
    progressStage: job.progressStage,
    message: null,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

export class ReanalysisService {
  constructor(private readonly repository: ReanalysisRepository) {}

  preview(ownerId: string, reviewIds: string[]): BatchReanalysisPreview {
    return this.repository.preview(ownerId, reviewIds);
  }

  requestRevision(
    ownerId: string,
    reviewId: string,
    input: RevisionRequestInput,
  ): RevisionRequestResult {
    return {
      newlyQueued: true,
      job: toPublicJobView(this.repository.requestRevision(ownerId, reviewId, input)),
    };
  }

  commitBatch(
    ownerId: string,
    items: BatchReanalysisCommitItem[],
  ): BatchReanalysisCommitResult {
    return this.repository.commitBatch(ownerId, items);
  }
}
