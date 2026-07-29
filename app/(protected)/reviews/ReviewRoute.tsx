"use client";

import { useSearchParams } from "next/navigation";

import { ReviewPage } from "./ReviewPage";

export function ReviewRoute() {
  const reviewId = useSearchParams().get("id");

  if (!reviewId) return <main className="page-shell"><p role="alert">缺少批改记录编号。</p></main>;
  return <ReviewPage reviewId={reviewId} />;
}
