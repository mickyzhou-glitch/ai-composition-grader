import { createReviewImagesRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  return createReviewImagesRouteHandlers(getApplicationServices()).POST(
    request,
    context,
  );
}

export async function PATCH(request: Request, context: Context) {
  return createReviewImagesRouteHandlers(getApplicationServices()).PATCH(
    request,
    context,
  );
}
