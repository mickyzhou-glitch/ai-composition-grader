import { createReviewRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return createReviewRouteHandlers(getApplicationServices()).GET(request, context);
}

export async function PATCH(request: Request, context: Context) {
  return createReviewRouteHandlers(getApplicationServices()).PATCH(request, context);
}

export async function DELETE(request: Request, context: Context) {
  return createReviewRouteHandlers(getApplicationServices()).DELETE(request, context);
}
