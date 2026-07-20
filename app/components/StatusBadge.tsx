import type { ReviewStatus } from "@/src/domain/contracts";

const statusLabels: Record<ReviewStatus, string> = {
  draft: "草稿",
  analyzing: "分析中",
  needs_better_images: "需重拍",
  ready_for_review: "待复核",
  exported: "已导出",
  failed: "分析失败",
};

export function StatusBadge({ status }: { status: ReviewStatus }) {
  return <span className={`status-badge status-badge--${status}`}>{statusLabels[status]}</span>;
}
