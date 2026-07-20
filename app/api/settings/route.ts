import { createSettingsRouteHandlers } from "@/src/api/handlers";
import { getApplicationServices } from "@/src/runtime/application-services";

export const runtime = "nodejs";

export async function GET() {
  return createSettingsRouteHandlers(getApplicationServices()).GET();
}

export async function PUT(request: Request) {
  return createSettingsRouteHandlers(getApplicationServices()).PUT(request);
}
