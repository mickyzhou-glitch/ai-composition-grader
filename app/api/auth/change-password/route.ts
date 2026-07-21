import { z, ZodError } from "zod";
import { NextResponse } from "next/server";

import { AuthServiceError } from "../../../../src/auth/auth-service";
import { assertTrustedWriteOrigin, sessionCookieOptions, requireApiUser } from "../../../../src/auth/request-auth";
import { getApplicationServices } from "../../../../src/runtime/application-services";

export const runtime = "nodejs";

const changePasswordSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8) }).strict();

export async function POST(request: Request) {
  try {
    assertTrustedWriteOrigin(request);
    const user = await requireApiUser(request);
    const parsed = changePasswordSchema.parse(await request.json());
    const result = await getApplicationServices().authService.changePassword({
      userId: user.id,
      currentPassword: parsed.currentPassword,
      newPassword: parsed.newPassword,
    });
    const options = sessionCookieOptions(request);
    if (!options) return Response.json({ ok: false, error: { code: "AUTHENTICATION_UNAVAILABLE", message: "认证服务暂时不可用" } }, { status: 503 });
    const response = NextResponse.json({ ok: true, data: result.user });
    response.cookies.set(options.name, result.rawToken, options);
    return response;
  } catch (error) {
    if (error instanceof ZodError) return Response.json({ ok: false, error: { code: "VALIDATION_ERROR", message: "请求参数无效", details: error.flatten() } }, { status: 400 });
    if (error instanceof AuthServiceError) {
      const status = error.code === "INVALID_CREDENTIALS" ? 401 : 400;
      return Response.json({ ok: false, error: { code: error.code, message: error.message } }, { status });
    }
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 503;
    return Response.json({ ok: false, error: { code: status === 403 ? "UNTRUSTED_ORIGIN" : "AUTHENTICATION_UNAVAILABLE", message: status === 403 ? "请求来源不受信任" : "认证服务暂时不可用" } }, { status });
  }
}
