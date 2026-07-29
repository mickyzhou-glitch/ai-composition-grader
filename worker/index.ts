import type { WorkerEnv } from "../src/cloudflare/env";
import { D1LoginChallengeRepository } from "../src/cloudflare/d1-login-challenge-repository";
import { D1PasswordProofRepository } from "../src/cloudflare/d1-password-proof-repository";
import { D1SessionRepository } from "../src/cloudflare/d1-session-repository";
import { handleWorkerAuth } from "../src/cloudflare/worker-auth-routes";

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
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ ok: false, error: { code: "NOT_FOUND", message: "接口不存在" } }, { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
