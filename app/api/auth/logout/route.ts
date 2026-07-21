import { assertTrustedWriteOrigin, clearSessionCookieOptions, requestSessionToken, requireApiUser } from "../../../../src/auth/request-auth";
import { getApplicationServices } from "../../../../src/runtime/application-services";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertTrustedWriteOrigin(request);
    await requireApiUser(request);
    const token = requestSessionToken(request);
    if (token) getApplicationServices().authService.logout(token);
    const options = clearSessionCookieOptions(request);
    const response = NextResponse.json({ ok: true, data: { loggedOut: true } });
    if (options) response.cookies.set(options.name, "", options);
    return response;
  } catch (error) {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 401;
    const message = status === 403 ? "请求来源不受信任" : "Authentication required";
    return Response.json({ ok: false, error: { code: status === 403 ? "UNTRUSTED_ORIGIN" : "UNAUTHENTICATED", message } }, { status });
  }
}
