import { createFeedbackRewriteRouteHandlers } from "@/src/api/handlers";
import { runProtectedApi } from "@/src/api/secure-route";
import { getApplicationServices } from "@/src/runtime/application-services";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; section: string }> },
) {
  return runProtectedApi(request, (user) =>
    createFeedbackRewriteRouteHandlers({
      reviewService: getApplicationServices().reviewService,
      ownerId: user.id,
    }).POST(request, context),
    { write: true },
  );
}
