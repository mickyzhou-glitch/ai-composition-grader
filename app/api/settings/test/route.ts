import { createSettingsRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return createSettingsRouteHandlers(getApplicationServices()).POST_TEST(request);
}
