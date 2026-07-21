import { requireApiUser } from "../../../../src/auth/request-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    return Response.json(
      { ok: true, data: await requireApiUser(request, { allowMustChangePassword: true }) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json({ ok: false, error: { code: "UNAUTHENTICATED", message: "Authentication required" } }, { status: 401 });
  }
}
