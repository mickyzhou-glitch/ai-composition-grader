import { describe, expect, it, vi } from "vitest";

import worker from "./index";

function workerEnv(assetResponse: () => Response, database?: unknown) {
  return {
    ASSETS: { fetch: async () => assetResponse() },
    ...(database ? { DB: database } : {}),
  } as never;
}

describe("Cloudflare Worker", () => {
  it("队列分析失败时原子结束任务并释放作文的分析中状态", async () => {
    const prepared: Array<{ sql: string; bindings: unknown[] }> = [];
    const prepare = vi.fn((sql: string) => {
      const statement = {
        sql,
        bindings: [] as unknown[],
        bind(...bindings: unknown[]) {
          this.bindings = bindings;
          return this;
        },
        async first() {
          if (sql.includes("INNER JOIN reviews")) {
            return {
              id: "job-1",
              review_id: "review-1",
              owner_id: "owner-1",
              teacher_guidance: null,
              config: "{}",
              student_name: "",
            };
          }
          if (sql.includes("FROM settings")) return null;
          throw new Error(`Unexpected first query: ${sql}`);
        },
        async all() {
          if (sql.includes("FROM review_images")) return { results: [{ id: 1 }] };
          throw new Error(`Unexpected all query: ${sql}`);
        },
        async run() {
          return { success: true };
        },
      };
      prepared.push(statement);
      return statement;
    });
    const batch = vi.fn(async (statements: unknown[]) => statements);
    const ack = vi.fn();

    await worker.queue({
      messages: [{ body: { jobId: "job-1" }, ack }],
    } as never, {
      DB: { prepare, batch },
    } as never);

    expect(batch).toHaveBeenCalledOnce();
    const batched = batch.mock.calls[0][0] as Array<{ sql: string; bindings: unknown[] }>;
    expect(batched).toHaveLength(2);
    expect(batched[0].sql).toContain("UPDATE reviews SET status = 'failed', analysis_run_id = NULL");
    expect(batched[0].sql).toContain("analysis_run_id = ?");
    expect(batched[0].bindings).toEqual(expect.arrayContaining(["review-1", "owner-1", "job-1"]));
    expect(batched[1].sql).toContain("UPDATE analysis_jobs SET status = 'failed'");
    expect(ack).toHaveBeenCalledOnce();
  });

  it("answers the unauthenticated health endpoint without requiring secrets", async () => {
    const response = await worker.fetch(
      new Request("https://grader.workers.dev/api/health"),
      workerEnv(() => new Response("asset")),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { status: "ok" } });
  });

  it("redirects an unauthenticated HTML root request to the same-origin login page without caching", async () => {
    const response = await worker.fetch(
      new Request("https://grader.workers.dev/", { headers: { accept: "text/html" } }),
      workerEnv(() => new Response("dashboard", { headers: { "content-type": "text/html" } })),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://grader.workers.dev/login");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("serves hashed Next.js static assets with an immutable one-year browser cache", async () => {
    const response = await worker.fetch(
      new Request("https://grader.workers.dev/_next/static/chunks/app-a1b2c3.js"),
      workerEnv(() => new Response("chunk", {
        headers: {
          "cache-control": "public, max-age=0, must-revalidate",
          "content-type": "text/javascript",
        },
      })),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("keeps immutable caching on a conditional static-asset response", async () => {
    const response = await worker.fetch(
      new Request("https://grader.workers.dev/_next/static/chunks/app-a1b2c3.js", {
        headers: { "if-none-match": "asset-etag" },
      }),
      workerEnv(() => new Response(null, {
        status: 304,
        headers: {
          "cache-control": "public, max-age=0, must-revalidate",
          etag: "asset-etag",
        },
      })),
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("serves authenticated users' static assets without querying D1", async () => {
    const first = vi.fn().mockResolvedValue(null);
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const response = await worker.fetch(
      new Request("https://grader.workers.dev/_next/static/chunks/app-a1b2c3.js", {
        headers: { cookie: "__Host-zuowen_session=session-token" },
      }),
      workerEnv(() => new Response("chunk", { headers: { "content-type": "text/javascript" } }), { prepare }),
    );

    expect(response.status).toBe(200);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("serves authenticated users' exported page documents without a duplicate D1 session query", async () => {
    const first = vi.fn().mockResolvedValue(null);
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const response = await worker.fetch(
      new Request("https://grader.workers.dev/change-password", {
        headers: { cookie: "__Host-zuowen_session=session-token" },
      }),
      workerEnv(() => new Response("page", { headers: { "content-type": "text/html" } }), { prepare }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("'unsafe-eval'");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("does not make a missing Next.js static asset immutable", async () => {
    const response = await worker.fetch(
      new Request("https://grader.workers.dev/_next/static/chunks/missing.js"),
      workerEnv(() => new Response("missing", {
        status: 404,
        headers: { "cache-control": "no-store", "content-type": "text/plain" },
      })),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("does not overwrite partial static-asset cache semantics", async () => {
    const response = await worker.fetch(
      new Request("https://grader.workers.dev/_next/static/chunks/app-a1b2c3.js"),
      workerEnv(() => new Response("partial", {
        status: 206,
        headers: { "cache-control": "private, no-store", "content-range": "bytes 0-6/10" },
      })),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("allows the legacy WebAssembly CSP fallback only on password-proof HTML documents", async () => {
    const env = workerEnv(() => new Response("page", {
      headers: {
        "cache-control": "public, max-age=0, must-revalidate",
        "content-type": "text/html",
      },
    }));

    const loginResponse = await worker.fetch(new Request("https://grader.workers.dev/login"), env);
    const changePasswordResponse = await worker.fetch(new Request("https://grader.workers.dev/change-password"), env);
    const settingsResponse = await worker.fetch(new Request("https://grader.workers.dev/settings"), env);
    const loginCsp = loginResponse.headers.get("content-security-policy");
    const changePasswordCsp = changePasswordResponse.headers.get("content-security-policy");
    const settingsCsp = settingsResponse.headers.get("content-security-policy");

    expect(loginCsp).toContain("'wasm-unsafe-eval'");
    expect(loginCsp).toContain("'unsafe-eval'");
    expect(changePasswordCsp).toContain("'unsafe-eval'");
    expect(settingsCsp).toContain("'wasm-unsafe-eval'");
    expect(settingsCsp).not.toContain("'unsafe-eval'");
    expect(loginResponse.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
  });

  it("preserves the password-proof CSP fallback on a contentless 304 document response", async () => {
    const response = await worker.fetch(
      new Request("https://grader.workers.dev/login", { headers: { "if-none-match": "login-etag" } }),
      workerEnv(() => new Response(null, { status: 304, headers: { etag: "login-etag" } })),
    );

    expect(response.status).toBe(304);
    expect(response.headers.get("content-security-policy")).toContain("'unsafe-eval'");
  });

  it("keeps a missing password-proof document on the strict CSP", async () => {
    const response = await worker.fetch(
      new Request("https://grader.workers.dev/login"),
      workerEnv(() => new Response("missing", { status: 404, headers: { "content-type": "text/html" } })),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-security-policy")).not.toContain("'unsafe-eval'");
  });
});
