import { createSettingsRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";
import { runProtectedApi } from "@/src/api/secure-route";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return runProtectedApi(request, () => createSettingsRouteHandlers(getApplicationServices()).GET(), { admin: true });
}

export async function PUT(request: Request) {
  return runProtectedApi(request, () => createSettingsRouteHandlers(getApplicationServices()).PUT(request), { admin: true, write: true });
}
