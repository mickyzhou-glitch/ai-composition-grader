import { z, ZodError } from "zod";
import { NextResponse } from "next/server";

import { hashSourceIp } from "../../../../src/auth/password";
import { assertTrustedWriteOrigin, AuthRequestError, sessionCookieOptions } from "../../../../src/auth/request-auth";
import { AuthServiceError } from "../../../../src/auth/auth-service";
import { getApplicationServices } from "../../../../src/runtime/application-services";
import { MacOSKeychain } from "../../../../src/settings/keychain";

export const runtime = "nodejs";

const loginSchema = z.object({ username: z.string().min(1), password: z.string().min(1) }).strict();

function errorResponse(code: string, message: string, status: number, details?: unknown) {
  return Response.json({ ok: false, error: { code, message, ...(details === undefined ? {} : { details }) } }, { status });
}

function sourceIp(request: Request): string {
  const withIp = request as Request & { ip?: string };
  const forwarded = request.headers.get("x-forwarded-for");
  // This handler first verifies the configured origin and loopback proxy path.
  // Only then may the left-most proxy-provided address identify rate-limit scope.
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "";
  return withIp.ip ?? request.headers.get("x-real-ip") ?? "";
}

function authFailure(error: unknown) {
  if (error instanceof AuthRequestError) {
    return errorResponse(error.status === 403 ? "UNTRUSTED_ORIGIN" : "UNAUTHENTICATED", error.message, error.status);
  }
  if (error instanceof AuthServiceError) {
    if (error.code === "LOGIN_RATE_LIMITED") return errorResponse(error.code, error.message, 429);
    return errorResponse("INVALID_CREDENTIALS", "用户名或密码错误", 401);
  }
  return errorResponse("AUTHENTICATION_UNAVAILABLE", "认证服务暂时不可用", 503);
}

export async function POST(request: Request) {
  try {
    assertTrustedWriteOrigin(request);
    const secret = process.env.AUTH_IP_HMAC_SECRET
      ?? (process.env.NODE_ENV === "production"
        ? await new MacOSKeychain({ service: "ai-composition-grader-auth", account: "ip-hmac" }).get()
        : null)
      // The configured HTTPS origin is a compatibility fallback when launchd
      // cannot unlock an interactive login-Keychain. A dedicated secret always
      // takes precedence and raw IP addresses are never stored.
      ?? process.env.APP_ORIGIN;
    const ip = sourceIp(request);
    if (!secret || !ip) return errorResponse("AUTHENTICATION_UNAVAILABLE", "认证服务暂时不可用", 503);
    const parsed = loginSchema.parse(await request.json());
    const result = await getApplicationServices().authService.login({
      username: parsed.username,
      password: parsed.password,
      ipHash: hashSourceIp(ip, secret),
    });
    const options = sessionCookieOptions(request);
    if (!options) return errorResponse("AUTHENTICATION_UNAVAILABLE", "认证服务暂时不可用", 503);
    const response = NextResponse.json({ ok: true, data: result.user });
    response.cookies.set(options.name, result.rawToken, options);
    return response;
  } catch (error) {
    if (error instanceof ZodError) return errorResponse("VALIDATION_ERROR", "请求参数无效", 400, error.flatten());
    if (error instanceof SyntaxError || error instanceof TypeError) return errorResponse("VALIDATION_ERROR", "请求参数无效", 400);
    if (error instanceof Response) throw error;
    return authFailure(error);
  }
}
