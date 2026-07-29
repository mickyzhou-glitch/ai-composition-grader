import type { WorkerEnv } from "../src/cloudflare/env";

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, data: { status: "ok" } });
    }
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ ok: false, error: { code: "NOT_FOUND", message: "接口不存在" } }, { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
