import { createReviewRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";
import { runProtectedApi } from "@/src/api/secure-route";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  return runProtectedApi(request, (user) => createReviewRouteHandlers({ ...getApplicationServices(), ownerId: user.id }).GET(request, context));
}

export async function PATCH(request: Request, context: Context) {
  return runProtectedApi(request, (user) => createReviewRouteHandlers({ ...getApplicationServices(), ownerId: user.id }).PATCH(request, context), { write: true });
}

export async function DELETE(request: Request, context: Context) {
  return runProtectedApi(request, (user) => createReviewRouteHandlers({ ...getApplicationServices(), ownerId: user.id }).DELETE(request, context), { write: true });
}
