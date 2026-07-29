"use client";

import { useEffect, useState } from "react";

import { apiFetch, errorMessage } from "@/app/lib/api";
import type { ReviewView } from "@/app/lib/types";

import { PrintReview } from "./PrintReview";

export function PrintReviewPage({ reviewId }: { reviewId: string }) {
  const [review, setReview] = useState<ReviewView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void apiFetch<ReviewView>(`/api/reviews/${encodeURIComponent(reviewId)}`)
      .then((nextReview) => { if (active) setReview(nextReview); })
      .catch((caught: unknown) => { if (active) setError(errorMessage(caught)); });
    return () => { active = false; };
  }, [reviewId]);

  if (error) return <main><p role="alert">{error}</p></main>;
  if (!review) return <main aria-busy="true" />;
  if (!review.report || review.images.length === 0) {
    return <main><p role="alert">该批改记录尚不能打印。</p></main>;
  }
  return <PrintReview review={review} imageSources={review.images.map((image) =>
    `/api/reviews/${encodeURIComponent(review.id)}/files?imageId=${image.id}&variant=original`,
  )} />;
}
