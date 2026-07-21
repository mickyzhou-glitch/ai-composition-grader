import { notFound } from "next/navigation";

import { ReviewServiceError } from "@/src/services/review-service";
import { getApplicationServices } from "@/src/runtime/application-services";

import { PrintReview } from "./PrintReview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function PrintReviewPage({
  params,
}: PageProps<"/print/reviews/[id]">) {
  const { id } = await params;
  let review;
  try {
    review = getApplicationServices().reviewService.get(id);
  } catch (error) {
    if (error instanceof ReviewServiceError && error.code === "REVIEW_NOT_FOUND") {
      notFound();
    }
    throw error;
  }
  if (!review.report || review.images.length === 0) notFound();
  return <PrintReview review={review} />;
}
