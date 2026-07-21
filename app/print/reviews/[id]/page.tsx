import { notFound } from "next/navigation";
import { headers } from "next/headers";

import { ReviewServiceError } from "@/src/services/review-service";
import { getApplicationServices } from "@/src/runtime/application-services";
import { consumePrintToken, PRINT_TOKEN_HEADER } from "@/src/pdf/print-token";

import { PrintReview } from "./PrintReview";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function PrintReviewPage({
  params,
}: PageProps<"/print/reviews/[id]">) {
  const { id } = await params;
  const token = consumePrintToken((await headers()).get(PRINT_TOKEN_HEADER), {
    reviewId: id,
  });
  if (!token) notFound();
  let review;
  try {
    // The signed token is the only authority for this internal, one-shot page.
    review = getApplicationServices().reviewService.get(token.ownerId, id);
  } catch (error) {
    if (error instanceof ReviewServiceError && error.code === "REVIEW_NOT_FOUND") {
      notFound();
    }
    throw error;
  }
  if (!review.report || review.images.length === 0) notFound();
  const imageSources = await Promise.all(review.images.map(async (image) => {
    const file = await getApplicationServices().reviewService.readImageFile(
      token.ownerId,
      id,
      image.id,
      "annotation",
    );
    return `data:${file.contentType};base64,${file.data.toString("base64")}`;
  }));
  return <PrintReview review={review} imageSources={imageSources} />;
}
