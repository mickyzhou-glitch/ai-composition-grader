import { createAnalyzeRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  return createAnalyzeRouteHandlers(getApplicationServices()).POST(request, context);
}
