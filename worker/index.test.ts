import { describe, expect, it, vi } from "vitest";

import worker, { savePipelineResult, saveUnreadableResult } from "./index";

function workerEnv(assetResponse: () => Response, database?: unknown) {
  return {
    ASSETS: { fetch: async () => assetResponse() },
    ...(database ? { DB: database } : {}),
  } as never;
}

describe("Cloudflare Worker", () => {
  it("报告保存先校验版本，最后才把任务标记成功", async () => {
    const prepared: Array<{ sql: string; bindings: unknown[] }> = [];
    const database = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          sql,
          bindings: [] as unknown[],
          bind(...bindings: unknown[]) {
            this.bindings = bindings;
            return this;
          },
        };
        prepared.push(statement);
        return statement;
      }),
      batch: vi.fn(async (statements: unknown[]) =>
        (statements as unknown[]).map(() => ({ meta: { changes: 1 } }))),
    } as unknown as D1Database;

    await savePipelineResult(database, {
      id: "job-1",
      reviewId: "review-1",
      ownerId: "owner-1",
      mode: "full",
      imageRevision: 4,
      config: {} as never,
    }, {
      report: { themeFit: "fits" },
      annotations: [],
      ocrRevision: 2,
    });

    expect(prepared[0].sql).toContain("UPDATE reviews SET report");
    expect(prepared.at(-1)?.sql).toContain("UPDATE analysis_jobs SET status = 'succeeded'");
    expect(prepared[0].bindings).toEqual(expect.arrayContaining(["job-1", 4, 2]));
  });

  it("报告版本条件未命中时拒绝把旧任务结果落库", async () => {
    const database = {
      prepare: vi.fn((sql: string) => ({ sql, bind() { return this; } })),
      batch: vi.fn(async (statements: unknown[]) =>
        (statements as unknown[]).map(() => ({ meta: { changes: 0 } }))),
    } as unknown as D1Database;

    await expect(savePipelineResult(database, {
      id: "job-1", reviewId: "review-1", ownerId: "owner-1", mode: "full",
      imageRevision: 4, config: {} as never,
    }, { report: {}, annotations: [], ocrRevision: 2 }))
      .rejects.toMatchObject({ code: "ANALYSIS_CONFLICT" });
  });

  it("不可读结果先保存重拍状态，最后才结束任务", async () => {
    const prepared: Array<{ sql: string }> = [];
    const database = {
      prepare: vi.fn((sql: string) => {
        const statement = { sql, bind() { return this; } };
        prepared.push(statement);
        return statement;
      }),
      batch: vi.fn(async (statements: unknown[]) =>
        (statements as unknown[]).map(() => ({ meta: { changes: 1 } }))),
    } as unknown as D1Database;

    await saveUnreadableResult(database, {
      id: "job-1", reviewId: "review-1", ownerId: "owner-1", mode: "full",
      imageRevision: 4, config: {} as never,
    }, 2);

    expect(prepared[0].sql).toContain("status = 'needs_better_images'");
    expect(prepared[1].sql).toContain("status = 'succeeded'");
  });

  it("returns the invalid review field path for an authenticated PATCH", async () => {
    const database = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(sql.includes("FROM sessions INNER JOIN users") ? {
            id: "teacher-1",
            username: "teacher",
            role: "teacher",
            must_change_password: 0,
            expires_at: Date.now() + 60_000,
          } : null),
        })),
      })),
    };
    const response = await worker.fetch(
      new Request("https://grader.workers.dev/api/reviews/review-1", {
        method: "PATCH",
        headers: {
          cookie: "__Host-zuowen_session=session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expectedRevision: 1,
          report: {
            themeFit: "fits",
            themeReason: "",
            personalizedComment: "观察细致",
            painPoints: [],
            commonIssues: [],
            revisionSuggestions: [],
            sampleParagraphs: [{ title: "开头", text: "示范正文", suggestion: "修改建议" }],
            parentFeedbacks: [],
            grade: "A",
            diagnostics: {
              authenticityAndRelevance: { finding: "切题", action: "补充细节" },
              materialAndDetails: { finding: "细节不足", action: "补充动作" },
              structure: { finding: "结构完整", action: "衔接自然" },
              language: { finding: "表达通顺", action: "精简句子" },
            },
          },
        }),
      }),
      workerEnv(() => new Response("asset"), database),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "请求参数无效",
        details: { path: ["report", "themeReason"] },
      },
    });
  });

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
