import { createAnalyzeRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";
import { runProtectedApi } from "@/src/api/secure-route";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  return runProtectedApi(request, (user) => createAnalyzeRouteHandlers({ ...getApplicationServices(), ownerId: user.id }).POST(request, context), { write: true });
}
