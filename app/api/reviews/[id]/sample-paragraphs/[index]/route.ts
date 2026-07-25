import { createSampleRewriteRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";
import { runProtectedApi } from "@/src/api/secure-route";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: RouteContext<"/api/reviews/[id]/sample-paragraphs/[index]">,
) {
  return runProtectedApi(request, (user) =>
    createSampleRewriteRouteHandlers({
      reviewService: getApplicationServices().reviewService,
      ownerId: user.id,
    }).POST(request, context),
    { write: true },
  );
}
