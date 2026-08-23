import type { ReviewStatus } from "@/src/domain/contracts";
import type { ReviewDisplayStatus } from "../lib/review-queue";

const statusLabels: Record<ReviewStatus, string> = {
  draft: "草稿",
  analyzing: "分析中",
  needs_better_images: "需重拍",
  ready_for_review: "待复核",
  exported: "已导出",
  failed: "分析失败",
};

const displayStatusLabels: Record<ReviewDisplayStatus, string> = {
  ...statusLabels,
  reviewed: "已复核",
};

export function StatusBadge({ status }: { status: ReviewDisplayStatus }) {
  return <span className={`status-badge status-badge--${status}`}>{displayStatusLabels[status]}</span>;
}
