import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getApplicationServices } from "../runtime/application-services";
import type { AuthenticatedUser, SessionRecord } from "./auth-types";

export const PRODUCTION_SESSION_COOKIE = "__Host-zuowen_session";
export const LOCAL_SESSION_COOKIE = "zuowen_local_session";

const LOCAL_ORIGIN = "http://127.0.0.1:3001";

export class AuthRequestError extends Error {
  constructor(
    readonly status: 401 | 403,
    message = "Authentication required",
    readonly code: "UNAUTHENTICATED" | "PASSWORD_CHANGE_REQUIRED" | "FORBIDDEN" | "UNTRUSTED_ORIGIN" = status === 403 ? "FORBIDDEN" : "UNAUTHENTICATED",
  ) {
    super(message);
    this.name = "AuthRequestError";
  }
}

export function applicationOrigin(): string | null {
  const configured = process.env.APP_ORIGIN?.trim();
  return configured ? configured.replace(/\/$/u, "") : null;
}

function isLocalOrigin(origin: string): boolean {
  return origin === LOCAL_ORIGIN;
}

function cookieNameForOrigin(origin: string): string | null {
  const configured = applicationOrigin();
  if (isLocalOrigin(origin)) return LOCAL_SESSION_COOKIE;
  if (configured && origin === configured && configured.startsWith("https://")) {
    return PRODUCTION_SESSION_COOKIE;
  }
  return null;
}

export function sessionCookieName(request: Request): string | null {
  try {
    const configured = applicationOrigin();
    const forwardedHost = request.headers.get("x-forwarded-host");
    const forwardedProto = request.headers.get("x-forwarded-proto");
    const forwarded = forwardedHost && forwardedProto
      ? `${forwardedProto.split(",")[0].trim()}://${forwardedHost.split(",")[0].trim()}`
      : null;
    if (configured && forwarded === configured) return PRODUCTION_SESSION_COOKIE;
    return cookieNameForOrigin(new URL(request.url).origin);
  } catch {
    return null;
  }
}

export function sessionCookieOptions(request: Request) {
  const name = sessionCookieName(request);
  if (!name) return null;
  return {
    name,
    httpOnly: true,
    sameSite: "strict" as const,
    path: "/",
    ...(name === PRODUCTION_SESSION_COOKIE ? { secure: true } : {}),
    maxAge: 12 * 60 * 60,
  };
}

export function clearSessionCookieOptions(request: Request) {
  const options = sessionCookieOptions(request);
  return options ? { ...options, maxAge: 0, expires: new Date(0) } : null;
}

function tokenFromRequest(request: Request): string | null {
  const name = sessionCookieName(request);
  if (!name) return null;
  const header = request.headers.get("cookie") ?? "";
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    const key = item.slice(0, separator).trim();
    if (key === name) {
      try {
        return decodeURIComponent(item.slice(separator + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function requestSessionToken(request: Request): string | null {
  return tokenFromRequest(request);
}

function authenticate(rawToken: string | null): SessionRecord | null {
  if (!rawToken) return null;
  try {
    const service = getApplicationServices().authService;
    const session = service.authenticateSession(rawToken);
    if (!session) return null;
    const refreshed = typeof service.refreshSessionIfNeeded === "function"
      ? service.refreshSessionIfNeeded(session.id, session.lastSeenAt)
      : null;
    return refreshed ?? session;
  } catch {
    return null;
  }
}

export async function requirePageUser(): Promise<AuthenticatedUser> {
  const store = await cookies();
  const rawToken =
    store.get(PRODUCTION_SESSION_COOKIE)?.value ??
    store.get(LOCAL_SESSION_COOKIE)?.value ??
    null;
  const session = authenticate(rawToken);
  if (!session) redirect("/login");
  return session.user;
}

export interface RequireApiUserOptions {
  allowMustChangePassword?: boolean;
}

export async function requireApiUser(
  request: Request,
  options: RequireApiUserOptions = {},
): Promise<AuthenticatedUser> {
  const session = authenticate(tokenFromRequest(request));
  if (!session) throw new AuthRequestError(401);
  if (session.user.mustChangePassword && !options.allowMustChangePassword) {
    throw new AuthRequestError(403, "Password change required", "PASSWORD_CHANGE_REQUIRED");
  }
  return session.user;
}

export async function requireAdminApiUser(request: Request): Promise<AuthenticatedUser> {
  const user = await requireApiUser(request);
  if (user.role !== "admin") throw new AuthRequestError(403, "Admin access required");
  return user;
}

export function assertTrustedWriteOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const configured = applicationOrigin();
  // In production there is no safe implicit origin. Local development keeps a
  // fixed loopback default so the app remains convenient without a .env file.
  const trusted = configured ?? (process.env.NODE_ENV === "production" ? null : LOCAL_ORIGIN);
  let requestOrigin: string;
  let directUrl: URL;
  try {
    directUrl = new URL(request.url);
    requestOrigin = directUrl.origin;
  } catch {
    throw new AuthRequestError(403, "请求来源不受信任", "UNTRUSTED_ORIGIN");
  }
  // ngrok terminates HTTPS then forwards only to our loopback listener. Trust
  // forwarded origin headers solely in that explicitly configured deployment.
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedOrigin = forwardedHost && forwardedProto
    ? `${forwardedProto.split(",")[0].trim()}://${forwardedHost.split(",")[0].trim()}`
    : null;
  const loopback = directUrl.hostname === "127.0.0.1" || directUrl.hostname === "localhost";
  const proxyMatchesConfiguredOrigin = Boolean(configured && loopback && forwardedOrigin === configured);
  if (proxyMatchesConfiguredOrigin) requestOrigin = configured as string;
  if (!trusted || !origin || origin !== requestOrigin || origin !== trusted) {
    throw new AuthRequestError(403, "请求来源不受信任", "UNTRUSTED_ORIGIN");
  }
}
