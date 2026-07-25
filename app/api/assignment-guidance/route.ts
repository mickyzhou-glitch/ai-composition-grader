import { createAssignmentGuidanceRouteHandlers } from "@/src/api/handlers";
import { AssignmentGuidanceAdapter } from "@/src/ai/assignment-guidance-adapter";
import { runProtectedApi } from "@/src/api/secure-route";
import { getApplicationServices } from "@/src/runtime/application-services";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return runProtectedApi(
    request,
    () => {
      const services = getApplicationServices();
      return createAssignmentGuidanceRouteHandlers({
        generate: (input) => new AssignmentGuidanceAdapter(services.settingsService).generate(input),
      }).POST(request);
    },
    { write: true },
  );
}
