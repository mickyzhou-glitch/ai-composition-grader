import { createSavedAssignmentsRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";
import { runProtectedApi } from "@/src/api/secure-route";

export const runtime = "nodejs";

export async function DELETE(request: Request, context: RouteContext<"/api/saved-assignments/[id]">) {
  return runProtectedApi(request, (user) => createSavedAssignmentsRouteHandlers({ reviewService: getApplicationServices().reviewService, ownerId: user.id }).DELETE(request, context));
}
