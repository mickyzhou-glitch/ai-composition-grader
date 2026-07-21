import { createReviewPdfRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return createReviewPdfRouteHandlers(getApplicationServices()).GET(
    request,
    context,
  );
}
