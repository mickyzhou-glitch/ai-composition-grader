"use client";

import type { ReviewView } from "../lib/types";
import { exportEligibility } from "../lib/review-queue";

interface ReviewExportListProps {
  reviews: ReviewView[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onReturnToReview: (id: string) => void;
}

export function ReviewExportList({ reviews, selectedIds, onToggle, onReturnToReview }: ReviewExportListProps) {
  if (reviews.length === 0) {
    return <div className="batch-empty"><h2>还没有已复核待导出作文</h2><p>完成教师复核的作文会出现在这里，导出前可再次核对修改意见。</p></div>;
  }
  return <div className="review-export-list">
    {reviews.map((review) => {
      const eligibility = exportEligibility(review);
      const diagnostics = review.report?.diagnostics;
      return <article className="review-export-item" key={review.id}>
        <div className="review-export-heading">
          <label><input type="checkbox" aria-label={`选择${review.studentName || "未填写学生"}的作文导出`} checked={selectedIds.has(review.id)} disabled={!eligibility.eligible} onChange={() => onToggle(review.id)} /></label>
          <div><h3>{review.studentName || "未填写学生"}</h3><p>{review.config.title} · <b>{review.report?.grade ?? "未评级"}</b></p></div>
          <time>{review.teacherReviewedAt ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(review.teacherReviewedAt)) : "未审核"}</time>
        </div>
        {eligibility.eligible ? <div className="review-export-comments">
          <section><h4>生活常识与真实度</h4><p>{diagnostics?.authenticityAndRelevance.finding}</p><p className="muted">修改：{diagnostics?.authenticityAndRelevance.action}</p></section>
          <section><h4>前后逻辑与结构</h4><p>{diagnostics?.structure.finding}</p><p className="muted">修改：{diagnostics?.structure.action}</p></section>
        </div> : <p className="inline-error">{eligibility.reason}</p>}
        <button type="button" className="button button--quiet" onClick={() => onReturnToReview(review.id)}>返回修改</button>
      </article>;
    })}
  </div>;
}
