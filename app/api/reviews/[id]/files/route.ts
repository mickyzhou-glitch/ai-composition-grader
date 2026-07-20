import { createReviewFilesRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return createReviewFilesRouteHandlers(getApplicationServices()).GET(request, context);
}
