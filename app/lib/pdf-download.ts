export async function downloadReviewPdf(reviewId: string): Promise<string> {
  const popup = window.open(`/print/reviews?id=${encodeURIComponent(reviewId)}`, "_blank", "noopener");
  if (!popup) throw new Error("浏览器拦截了打印窗口，请允许弹窗后重试");
  return "print-review.pdf";
}

export async function downloadReviewPdfArchive(reviewIds: string[]): Promise<string> {
  if (reviewIds.length === 0) throw new Error("请先选择批改记录");
  for (const reviewId of reviewIds) await downloadReviewPdf(reviewId);
  return "print-reviews.pdf";
}
