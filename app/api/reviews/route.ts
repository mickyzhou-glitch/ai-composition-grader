import { createReviewsRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";
import { runProtectedApi } from "@/src/api/secure-route";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return runProtectedApi(request, (user) => createReviewsRouteHandlers({ ...getApplicationServices(), ownerId: user.id }).GET());
}

export async function POST(request: Request) {
  return runProtectedApi(request, (user) => createReviewsRouteHandlers({ ...getApplicationServices(), ownerId: user.id }).POST(request), { write: true });
}
