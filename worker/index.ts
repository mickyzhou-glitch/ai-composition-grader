import type { WorkerEnv } from "../src/cloudflare/env";
import { D1LoginChallengeRepository } from "../src/cloudflare/d1-login-challenge-repository";
import { D1PasswordProofRepository } from "../src/cloudflare/d1-password-proof-repository";
import { D1SessionRepository } from "../src/cloudflare/d1-session-repository";
import { D1ReviewReader } from "../src/cloudflare/d1-review-reader";
import { authenticatedWorkerUser, handleWorkerAuth } from "../src/cloudflare/worker-auth-routes";

function apiError(code: string, message: string, status: number): Response {
  return Response.json({ ok: false, error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const authResponse = await handleWorkerAuth(request, {
      appOrigin: env.APP_ORIGIN,
      ipHmacSecret: env.AUTH_IP_HMAC_SECRET,
      proofs: new D1PasswordProofRepository(env.DB),
      challenges: new D1LoginChallengeRepository(env.DB),
      sessions: new D1SessionRepository(env.DB),
      proofEncryptionKey: env.AUTH_PROOF_ENCRYPTION_KEY,
    });
    if (authResponse) return authResponse;
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, data: { status: "ok" } });
    }
    const sessions = new D1SessionRepository(env.DB);
    const user = await authenticatedWorkerUser(request, sessions);
    if (url.pathname === "/api/reviews" && request.method === "GET") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      return Response.json({ ok: true, data: await new D1ReviewReader(env.DB).list(user.id) }, { headers: { "cache-control": "no-store" } });
    }
    const reviewMatch = /^\/api\/reviews\/([^/]+)$/u.exec(url.pathname);
    if (reviewMatch && request.method === "GET") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      const review = await new D1ReviewReader(env.DB).get(user.id, decodeURIComponent(reviewMatch[1]));
      return review ? Response.json({ ok: true, data: review }, { headers: { "cache-control": "no-store" } }) : apiError("REVIEW_NOT_FOUND", "批改记录不存在", 404);
    }
    const fileMatch = /^\/api\/reviews\/([^/]+)\/files$/u.exec(url.pathname);
    if (fileMatch && request.method === "GET") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      const imageId = Number(url.searchParams.get("imageId"));
      const variant = url.searchParams.get("variant");
      if (!Number.isSafeInteger(imageId) || imageId < 1 || !["original", "annotation", "ai"].includes(variant ?? "")) {
        return apiError("INVALID_FILE_PATH", "图片请求无效", 400);
      }
      const file = await new D1ReviewReader(env.DB).imageObjectKey(user.id, decodeURIComponent(fileMatch[1]), imageId, variant as "original" | "annotation" | "ai");
      if (!file) return apiError("FILE_NOT_FOUND", "图片不存在", 404);
      const object = await env.FILES.get(file.key);
      if (!object) return apiError("FILE_NOT_FOUND", "图片不存在", 404);
      return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType ?? file.contentType, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
    }
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ ok: false, error: { code: "NOT_FOUND", message: "接口不存在" } }, { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
