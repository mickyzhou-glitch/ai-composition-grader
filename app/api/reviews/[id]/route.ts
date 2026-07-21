import { createReviewRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";
import { requireApiUser } from "@/src/auth/request-auth";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const user = await requireApiUser(request);
  return createReviewRouteHandlers({ ...getApplicationServices(), ownerId: user.id }).GET(request, context);
}

export async function PATCH(request: Request, context: Context) {
  const user = await requireApiUser(request);
  return createReviewRouteHandlers({ ...getApplicationServices(), ownerId: user.id }).PATCH(request, context);
}

export async function DELETE(request: Request, context: Context) {
  const user = await requireApiUser(request);
  return createReviewRouteHandlers({ ...getApplicationServices(), ownerId: user.id }).DELETE(request, context);
}
