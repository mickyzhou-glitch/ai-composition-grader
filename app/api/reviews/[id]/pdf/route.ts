import { createReviewPdfRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";
import { runProtectedApi } from "@/src/api/secure-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return runProtectedApi(request, (user) => createReviewPdfRouteHandlers({ pdfService: getApplicationServices().pdfService, ownerId: user.id }).GET(request, context));
}
