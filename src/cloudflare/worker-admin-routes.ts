import type { AuthenticatedUser, UserRole } from "../auth/auth-types";
import { fromBase64Url } from "../auth/password-proof";
import { sealPasswordVerifier } from "../auth/password-proof-worker";
import { AdminAccountError, D1AdminAccounts } from "./d1-admin-accounts";
import { sessionTokenHashFromRequest } from "./worker-auth-routes";

function jsonError(code: string, message: string, status: number): Response {
  return Response.json(
    { ok: false, error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function parseVerifierPayload(body: { salt?: unknown; verifier?: unknown }): { salt: string; verifier: Uint8Array } {
  if (typeof body.salt !== "string" || typeof body.verifier !== "string") {
    throw new AdminAccountError("VALIDATION_ERROR", "密码安全凭证无效", 400);
  }
  let saltBytes: Uint8Array;
  let verifier: Uint8Array;
  try {
    saltBytes = fromBase64Url(body.salt);
    verifier = fromBase64Url(body.verifier);
  } catch {
    throw new AdminAccountError("VALIDATION_ERROR", "密码安全凭证编码无效", 400);
  }
  if (saltBytes.length < 16 || verifier.length !== 32) {
    throw new AdminAccountError("VALIDATION_ERROR", "密码安全凭证长度无效", 400);
  }
  return { salt: body.salt, verifier };
}

export async function handleWorkerAdmin(
  request: Request,
  input: {
    user: AuthenticatedUser | null;
    database: D1Database;
    proofEncryptionKey: string;
  },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/admin/")) return null;

  if (!input.user) {
    return jsonError("UNAUTHENTICATED", "Authentication required", 401);
  }
  if (input.user.role !== "admin") {
    return jsonError("FORBIDDEN", "Administrator access required", 403);
  }

  const accounts = new D1AdminAccounts(input.database);

  try {
    if (url.pathname === "/api/admin/accounts" && request.method === "GET") {
      return Response.json(
        { ok: true, data: await accounts.overview(input.user.id) },
        { headers: { "cache-control": "no-store" } },
      );
    }

    if (url.pathname === "/api/admin/accounts" && request.method === "POST") {
      const body = await request.json() as {
        username?: unknown;
        role?: unknown;
        mustChangePassword?: unknown;
        salt?: unknown;
        verifier?: unknown;
      };
      const { salt, verifier } = parseVerifierPayload(body);
      const role: UserRole = body.role === "admin" ? "admin" : body.role === "teacher" ? "teacher" : (() => {
        throw new AdminAccountError("VALIDATION_ERROR", "请选择有效的账号角色", 400);
      })();
      const mustChangePassword = body.mustChangePassword !== false;
      const sealed = await sealPasswordVerifier(verifier, fromBase64Url(input.proofEncryptionKey));
      const created = await accounts.createAccount({
        actor: input.user,
        username: typeof body.username === "string" ? body.username : "",
        role,
        mustChangePassword,
        salt,
        sealed,
      });
      return Response.json({ ok: true, data: created }, { status: 201, headers: { "cache-control": "no-store" } });
    }

    const patchMatch = /^\/api\/admin\/accounts\/([^/]+)$/u.exec(url.pathname);
    if (patchMatch && request.method === "PATCH") {
      const targetUserId = decodeURIComponent(patchMatch[1]);
      const body = await request.json() as { role?: unknown; disabled?: unknown };
      if (body.role === undefined && body.disabled === undefined) {
        return jsonError("VALIDATION_ERROR", "未提供需要更新的字段", 400);
      }
      if (body.role !== undefined && body.role !== "admin" && body.role !== "teacher") {
        return jsonError("VALIDATION_ERROR", "账号角色无效", 400);
      }
      if (body.disabled !== undefined && typeof body.disabled !== "boolean") {
        return jsonError("VALIDATION_ERROR", "停用状态参数无效", 400);
      }
      await accounts.updateAccount({
        actor: input.user,
        targetUserId,
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.disabled !== undefined ? { disabled: body.disabled } : {}),
      });
      return Response.json({ ok: true, data: { updated: true } }, { headers: { "cache-control": "no-store" } });
    }

    const resetMatch = /^\/api\/admin\/accounts\/([^/]+)\/reset-password$/u.exec(url.pathname);
    if (resetMatch && request.method === "POST") {
      const targetUserId = decodeURIComponent(resetMatch[1]);
      const body = await request.json() as {
        salt?: unknown;
        verifier?: unknown;
        mustChangePassword?: unknown;
        revokeSessions?: unknown;
      };
      const { salt, verifier } = parseVerifierPayload(body);
      const sealed = await sealPasswordVerifier(verifier, fromBase64Url(input.proofEncryptionKey));
      const keepTokenHash = await sessionTokenHashFromRequest(request);
      await accounts.resetPassword({
        actor: input.user,
        targetUserId,
        salt,
        sealed,
        mustChangePassword: body.mustChangePassword !== false,
        revokeSessions: body.revokeSessions !== false,
        keepTokenHash,
      });
      return Response.json({ ok: true, data: { reset: true } }, { headers: { "cache-control": "no-store" } });
    }

    const revokeMatch = /^\/api\/admin\/accounts\/([^/]+)\/revoke-sessions$/u.exec(url.pathname);
    if (revokeMatch && request.method === "POST") {
      const targetUserId = decodeURIComponent(revokeMatch[1]);
      const keepTokenHash = await sessionTokenHashFromRequest(request);
      const result = await accounts.revokeSessions({
        actor: input.user,
        targetUserId,
        keepTokenHash,
      });
      return Response.json({ ok: true, data: result }, { headers: { "cache-control": "no-store" } });
    }

    const unlockMatch = /^\/api\/admin\/accounts\/([^/]+)\/unlock-login$/u.exec(url.pathname);
    if (unlockMatch && request.method === "POST") {
      const targetUserId = decodeURIComponent(unlockMatch[1]);
      const result = await accounts.unlockLoginRateLimit({
        actor: input.user,
        targetUserId,
      });
      return Response.json({ ok: true, data: result }, { headers: { "cache-control": "no-store" } });
    }

    return jsonError("NOT_FOUND", "接口不存在", 404);
  } catch (error) {
    if (error instanceof AdminAccountError) {
      return jsonError(error.code, error.message, error.status);
    }
    if (error instanceof SyntaxError || error instanceof URIError) {
      return jsonError("VALIDATION_ERROR", "请求参数无效", 400);
    }
    throw error;
  }
}
