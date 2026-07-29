"use client";

import { useSearchParams } from "next/navigation";

import { PrintReviewPage } from "../reviews/[id]/PrintReviewPage";

export function PrintReviewRoute() {
  const reviewId = useSearchParams().get("id");

  if (!reviewId) return <main><p role="alert">缺少批改记录编号。</p></main>;
  return <PrintReviewPage reviewId={reviewId} />;
}
