import { createReviewPdfRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";
import { requireApiUser } from "@/src/auth/request-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const user = await requireApiUser(request);
  return createReviewPdfRouteHandlers({ pdfService: getApplicationServices().pdfService, ownerId: user.id }).GET(
    request,
    context,
  );
}
