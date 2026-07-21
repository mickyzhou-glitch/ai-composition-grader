import { createSettingsRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";
import { runProtectedApi } from "@/src/api/secure-route";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return runProtectedApi(request, () => createSettingsRouteHandlers(getApplicationServices()).POST_TEST(request), { admin: true, write: true });
}
