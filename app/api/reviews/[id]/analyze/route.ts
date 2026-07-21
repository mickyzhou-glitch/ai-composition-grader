import { createAnalyzeRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";
import { requireApiUser } from "@/src/auth/request-auth";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const user = await requireApiUser(request);
  return createAnalyzeRouteHandlers({ ...getApplicationServices(), ownerId: user.id }).POST(request, context);
}
