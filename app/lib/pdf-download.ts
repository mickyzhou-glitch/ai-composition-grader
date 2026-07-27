import { ApiError } from "./api";

function responseFilename(response: Response): string {
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // Fall through to the ASCII filename supplied by the server.
    }
  }
  return disposition.match(/filename="([^"]+)"/i)?.[1] ?? "composition-review.pdf";
}

async function responseError(response: Response): Promise<ApiError> {
  try {
    const body = await response.json() as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    return new ApiError(
      body.error?.message ?? `请求失败（${response.status}）`,
      response.status,
      body.error?.code,
      body.error?.details,
    );
  } catch {
    return new ApiError(`请求失败（${response.status}）`, response.status);
  }
}

export async function downloadReviewPdf(reviewId: string): Promise<string> {
  const response = await fetch(
    `/api/reviews/${encodeURIComponent(reviewId)}/pdf`,
  );
  if (!response.ok) throw await responseError(response);

  const filename = responseFilename(response);
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  return filename;
}

export async function downloadReviewPdfArchive(reviewIds: string[]): Promise<string> {
  const response = await fetch("/api/reviews/batch-pdf", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reviewIds }),
  });
  if (!response.ok) throw await responseError(response);

  const filename = responseFilename(response);
  const objectUrl = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  return filename;
}
