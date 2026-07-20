import { createReviewsRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";

export const runtime = "nodejs";

export async function GET() {
  return createReviewsRouteHandlers(getApplicationServices()).GET();
}

export async function POST(request: Request) {
  return createReviewsRouteHandlers(getApplicationServices()).POST(request);
}
