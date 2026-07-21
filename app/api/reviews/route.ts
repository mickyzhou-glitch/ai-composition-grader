import { createReviewsRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";
import { requireApiUser } from "@/src/auth/request-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const user = await requireApiUser(request);
  return createReviewsRouteHandlers({ ...getApplicationServices(), ownerId: user.id }).GET();
}

export async function POST(request: Request) {
  const user = await requireApiUser(request);
  return createReviewsRouteHandlers({ ...getApplicationServices(), ownerId: user.id }).POST(request);
}
