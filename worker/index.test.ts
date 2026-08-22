import { describe, expect, it, vi } from "vitest";

import worker, { savePipelineResult, saveUnreadableResult } from "./index";
import { D1Reanalysis, D1ReanalysisBatchError } from "../src/cloudflare/d1-reanalysis";

function workerEnv(assetResponse: () => Response, database?: unknown) {
  return {
    ASSETS: { fetch: async () => assetResponse() },
    ...(database ? { DB: database } : {}),
  } as never;
}

function authenticatedDatabase() {
  return {
    prepare: vi.fn((sql: string) => {
      const statement = {
        bind() { return statement; },
        first: vi.fn(async () => sql.includes("FROM sessions INNER JOIN users") ? {
          id: "teacher-1",
          username: "teacher",
          role: "teacher",
          must_change_password: 0,
          expires_at: Date.now() + 60_000,
        } : null),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => ({ meta: { changes: 0 } })),
      };
      return statement;
    }),
    batch: vi.fn(async () => []),
  };
}

function queue() {
  return {
    send: vi.fn(async () => ({})),
    sendBatch: vi.fn(async () => ({})),
  };
}

const reviewConfig = {
  title: "为自己鼓掌",
  grade: "六年级",
  writingRequirements: "叙事",
  targetCharacters: 600,
  structureRequirements: "完整",
  scoringFocus: "细节",
  templateType: "custom",
};

const teacherReviewedReport = {
  themeFit: "fits",
  themeReason: "切题",
  personalizedComment: "细节真实",
  painPoints: ["补充转折"],
  commonIssues: [],
  revisionSuggestions: [],
  grade: "B+",
  diagnostics: {
    authenticityAndRelevance: { finding: "事件真实。", action: "保留真实细节。" },
    materialAndDetails: { finding: "动作略少。", action: "补写动作。" },
    structure: { finding: "衔接清楚。", action: "强化转折。" },
    language: { finding: "语言通顺。", action: "精简长句。" },
  },
  sampleParagraphs: [{ title: "示范", text: "示范正文", suggestion: "补充动作" }],
  parentFeedbacks: [],
};

describe("Cloudflare Worker", () => {
  it.each([
    ["GET", "/api/settings"],
    ["PUT", "/api/settings/content"],
    ["POST", "/api/settings/content/test"],
  ])("普通教师不能访问模型设置：%s %s", async (method, pathname) => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
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
          run,
        })),
      })),
    };
    const upstream = vi.spyOn(globalThis, "fetch");

    const response = await worker.fetch(new Request(`https://grader.workers.dev${pathname}`, {
      method,
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        ...(method === "GET" ? {} : { "content-type": "application/json" }),
      },
      ...(method === "GET" ? {} : {
        body: JSON.stringify({ baseUrl: "https://attacker.example/v1", model: "capture" }),
      }),
    }), workerEnv(() => new Response("asset"), database));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "FORBIDDEN", message: "Administrator access required" },
    });
    expect(run).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("内容模型连接测试只发送纯文本请求", async () => {
    const database = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(sql.includes("FROM sessions INNER JOIN users") ? {
            id: "teacher-1",
            username: "teacher",
            role: "admin",
            must_change_password: 0,
            expires_at: Date.now() + 60_000,
          } : sql.includes("FROM settings") ? { encrypted_api_key: null } : null),
        })),
      })),
    };
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "OK" } }],
    }), { headers: { "content-type": "application/json" } }));

    const response = await worker.fetch(new Request("https://grader.workers.dev/api/settings/content/test", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ baseUrl: "https://content.example/v1", model: "writer" }),
    }), {
      ASSETS: { fetch: async () => new Response("asset") },
      DB: database,
      CONTENT_AI_API_KEY: "content-secret",
    } as never);

    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledOnce();
    const body = JSON.parse((upstream.mock.calls.at(-1)?.[1] as RequestInit).body as string);
    expect(body.messages).toEqual([{ role: "user", content: "请只回复 OK" }]);
    expect(JSON.stringify(body)).not.toContain("image_url");
  });

  it("MiMo 视觉连接测试为推理和可见回复预留足够 token", async () => {
    const database = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(sql.includes("FROM sessions INNER JOIN users") ? {
            id: "admin-1",
            username: "admin",
            role: "admin",
            must_change_password: 0,
            expires_at: Date.now() + 60_000,
          } : sql.includes("FROM settings") ? { encrypted_api_key: null } : null),
        })),
      })),
    };
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "OK" } }],
    }), { headers: { "content-type": "application/json" } }));

    const response = await worker.fetch(new Request("https://grader.workers.dev/api/settings/vision/test", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5" }),
    }), {
      ASSETS: { fetch: async () => new Response("asset") },
      DB: database,
      VISION_AI_API_KEY: "vision-secret",
    } as never);

    expect(response.status).toBe(200);
    const body = JSON.parse((upstream.mock.calls.at(-1)?.[1] as RequestInit).body as string);
    expect(JSON.stringify(body.messages)).toContain("image_url");
    expect(body.max_completion_tokens).toBeGreaterThanOrEqual(256);
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("DeepSeek 内容模型连接测试关闭默认思考模式", async () => {
    const database = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(sql.includes("FROM sessions INNER JOIN users") ? {
            id: "admin-1",
            username: "admin",
            role: "admin",
            must_change_password: 0,
            expires_at: Date.now() + 60_000,
          } : sql.includes("FROM settings") ? { encrypted_api_key: null } : null),
        })),
      })),
    };
    const upstream = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "OK" } }],
    }), { headers: { "content-type": "application/json" } }));

    const response = await worker.fetch(new Request("https://grader.workers.dev/api/settings/content/test", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash" }),
    }), {
      ASSETS: { fetch: async () => new Response("asset") },
      DB: database,
      CONTENT_AI_API_KEY: "content-secret",
    } as never);

    expect(response.status).toBe(200);
    const body = JSON.parse((upstream.mock.calls.at(-1)?.[1] as RequestInit).body as string);
    expect(body.thinking).toEqual({ type: "disabled" });
  });

  it("保存作文内容模型时只更新 content 角色", async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
    const database = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          sql,
          bindings: [] as unknown[],
          bind(...bindings: unknown[]) {
            this.bindings = bindings;
            return this;
          },
          async first() {
            if (sql.includes("FROM sessions INNER JOIN users")) return {
              id: "admin-1", username: "admin", role: "admin",
              must_change_password: 0, expires_at: Date.now() + 60_000,
            };
            if (sql.includes("FROM settings")) return { encrypted_api_key: "sealed-existing" };
            return null;
          },
          async run() { return { meta: { changes: 1 } }; },
        };
        statements.push(statement);
        return statement;
      }),
    };

    const response = await worker.fetch(new Request("https://grader.workers.dev/api/settings/content", {
      method: "PUT",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ baseUrl: "https://content.example/v1", model: "writer" }),
    }), workerEnv(() => new Response("asset"), database));

    expect(response.status).toBe(200);
    const insert = statements.find(({ sql }) => sql.includes("INSERT INTO settings"));
    expect(insert?.bindings[0]).toBe("content");
    expect(insert?.bindings).not.toContain("vision");
  });

  it("OCR 版本冲突时返回 409 且不暴露内部检查点", async () => {
    const checkpoint = JSON.stringify({
      version: 1,
      sourceRevision: 2,
      ocrRevision: 3,
      editedAt: null,
      pages: [{ pageIndex: 0, text: "作文原文", readable: true, warnings: [], blocks: [] }],
    });
    const database = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(sql.includes("FROM sessions INNER JOIN users") ? {
            id: "teacher-1", username: "teacher", role: "teacher",
            must_change_password: 0, expires_at: Date.now() + 60_000,
          } : sql.includes("SELECT image_revision, ocr_checkpoint") ? {
            image_revision: 2, ocr_checkpoint: checkpoint,
          } : null),
          run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
        })),
      })),
    };

    const response = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/review-1/ocr", {
      method: "PATCH",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expectedOcrRevision: 3,
        pages: [{ pageIndex: 0, text: "修正后原文" }],
      }),
    }), workerEnv(() => new Response("asset"), database));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "OCR_REVISION_CONFLICT", message: "识别原文已被更新" },
    });
  });

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

  it("serves the authenticated teacher review queue without full review payloads", async () => {
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(sql.includes("FROM sessions INNER JOIN users") ? {
          id: "teacher-1", username: "teacher", role: "teacher", must_change_password: 0,
          expires_at: Date.now() + 60_000,
        } : null),
        all: vi.fn().mockResolvedValue(sql.includes("teacher_reviewed_at IS NULL") ? { results: [{
          id: "review-1", student_name: "张小明", config: JSON.stringify(reviewConfig),
          status: "ready_for_review", revision: 3, created_at: 1_700_000_000_000,
        }] } : { results: [] }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      })),
    }));

    const response = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/review-queue", {
      headers: { cookie: "__Host-zuowen_session=session-token" },
    }), workerEnv(() => new Response("asset"), { prepare }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: [{
      id: "review-1",
      studentName: "张小明",
      title: "为自己鼓掌",
      status: "ready_for_review",
      revision: 3,
      createdAt: new Date(1_700_000_000_000).toISOString(),
    }] });
  });

  it("atomically completes teacher review and returns the current hydrated review", async () => {
    const prepared: Array<{ sql: string }> = [];
    const prepare = vi.fn((sql: string) => {
      prepared.push({ sql });
      const statement = {
        bind: vi.fn(() => statement),
        first: vi.fn().mockResolvedValue(
          sql.includes("FROM sessions INNER JOIN users") ? {
            id: "teacher-1", username: "teacher", role: "teacher", must_change_password: 0,
            expires_at: Date.now() + 60_000,
          } : sql.includes("FROM reviews WHERE id") ? {
            id: "review-1", status: "ready_for_review", student_name: "张小明",
            config: JSON.stringify(reviewConfig), report: JSON.stringify(teacherReviewedReport),
            revision: 4, image_revision: 1, ocr_checkpoint: null, report_ocr_revision: null,
            pdf_filename: null, pdf_path: null, pdf_revision: null, exported_at: null,
            teacher_reviewed_at: 1_700_000_100_000, expires_at: null,
            created_at: 1_700_000_000_000, updated_at: 1_700_000_100_000,
          } : null,
        ),
        all: vi.fn().mockResolvedValue({ results: [] }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      };
      return statement;
    });
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 1 } }]);

    const response = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/review-1/teacher-review", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expectedRevision: 3,
        studentName: "张小明",
        report: teacherReviewedReport,
        annotations: [],
      }),
    }), workerEnv(() => new Response("asset"), { prepare, batch }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      ok: true,
      data: expect.objectContaining({
        id: "review-1",
        revision: 4,
        teacherReviewedAt: new Date(1_700_000_100_000).toISOString(),
      }),
    }));
    expect(prepared.some(({ sql }) => sql.includes("teacher_reviewed_at = ?"))).toBe(true);
  });

  it("rejects the entire export check when any requested review is not eligible", async () => {
    const prepare = vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(sql.includes("FROM sessions INNER JOIN users") ? {
          id: "teacher-1", username: "teacher", role: "teacher", must_change_password: 0,
          expires_at: Date.now() + 60_000,
        } : null),
        all: vi.fn().mockResolvedValue({ results: [{ id: "review-1", revision: 3 }] }),
        run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
      })),
    }));

    const response = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/export-check", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ reviews: [
        { id: "review-1", revision: 3 },
        { id: "review-2", revision: 2 },
      ] }),
    }), workerEnv(() => new Response("asset"), { prepare }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "EXPORT_NOT_AVAILABLE" },
    });
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

  it("认证失败时不会读取重分析 JSON、写 D1 或投递 Queue", async () => {
    const database = authenticatedDatabase();
    const jobs = queue();
    const response = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/review-1/revision-request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad json",
    }), Object.assign(workerEnv(() => new Response("asset"), database), { ANALYSIS_QUEUE: jobs }) as never);

    expect(response.status).toBe(401);
    expect(database.batch).not.toHaveBeenCalled();
    expect(jobs.send).not.toHaveBeenCalled();
    expect(jobs.sendBatch).not.toHaveBeenCalled();
  });

  it("重分析 schema 错误返回 400 且不调用服务或 Queue", async () => {
    const database = authenticatedDatabase();
    const jobs = queue();
    const requestRevision = vi.spyOn(D1Reanalysis.prototype, "requestRevision");
    const response = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/review-1/revision-request", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ expectedRevision: "3" }),
    }), Object.assign(workerEnv(() => new Response("asset"), database), { ANALYSIS_QUEUE: jobs }) as never);

    expect(response.status).toBe(400);
    expect(requestRevision).not.toHaveBeenCalled();
    expect(database.batch).not.toHaveBeenCalled();
    expect(jobs.send).not.toHaveBeenCalled();
    requestRevision.mockRestore();
  });

  it("revision request 成功后发送单条 Queue 并返回 202 no-store", async () => {
    const database = authenticatedDatabase();
    const jobs = queue();
    const requestRevision = vi.spyOn(D1Reanalysis.prototype, "requestRevision").mockResolvedValue({
      newlyQueued: true,
      job: {
        id: "job-1", reviewId: "review-1", mode: "content_only", status: "queued",
        progressStage: "queued", message: null, createdAt: new Date(1_700_000_000_000).toISOString(), finishedAt: null,
      },
    });
    const response = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/review-1/revision-request", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ expectedRevision: 3, reason: "原因", changeRequest: "要求" }),
    }), Object.assign(workerEnv(() => new Response("asset"), database), { ANALYSIS_QUEUE: jobs }) as never);

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(jobs.send).toHaveBeenCalledWith({ jobId: "job-1" });
    expect(jobs.sendBatch).not.toHaveBeenCalled();
    requestRevision.mockRestore();
  });

  it("preview 成功不发送 Queue，D1/内部错误返回安全 500", async () => {
    const database = authenticatedDatabase();
    const jobs = queue();
    const preview = vi.spyOn(D1Reanalysis.prototype, "preview").mockRejectedValue(new Error("SQLITE secret details"));
    const response = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/batch-reanalysis/preview", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ reviewIds: ["review-1"] }),
    }), Object.assign(workerEnv(() => new Response("asset"), database), { ANALYSIS_QUEUE: jobs }) as never);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).not.toContain("SQLITE secret details");
    expect(jobs.send).not.toHaveBeenCalled();
    expect(jobs.sendBatch).not.toHaveBeenCalled();
    preview.mockRestore();
  });

  it("batch 只对 submitted 做一次 sendBatch", async () => {
    const database = authenticatedDatabase();
    const jobs = queue();
    const commitBatch = vi.spyOn(D1Reanalysis.prototype, "commitBatch").mockResolvedValue({
      submitted: [{ reviewId: "review-1", jobId: "job-1", revision: 4 }],
      skipped: [{ reviewId: "review-2", code: "FRAMEWORK_CHANGED", reason: "题目框架已更新，请重新预览" }],
    });
    const response = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/batch-reanalysis", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ items: [{ reviewId: "review-1", expectedRevision: 3, assignmentId: "assignment-1", expectedAssignmentUpdatedAt: new Date(1_700_000_000_000).toISOString() }] }),
    }), Object.assign(workerEnv(() => new Response("asset"), database), { ANALYSIS_QUEUE: jobs }) as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(jobs.send).not.toHaveBeenCalled();
    expect(jobs.sendBatch).toHaveBeenCalledOnce();
    expect(jobs.sendBatch).toHaveBeenCalledWith([{ body: { jobId: "job-1" } }]);
    commitBatch.mockRestore();
  });

  it("Queue send 失败执行补偿并返回 503，不泄露 Queue 错误", async () => {
    const database = authenticatedDatabase();
    const jobs = queue();
    jobs.send.mockRejectedValue(new Error("queue internals"));
    const requestRevision = vi.spyOn(D1Reanalysis.prototype, "requestRevision").mockResolvedValue({
      newlyQueued: true,
      job: {
        id: "job-1", reviewId: "review-1", mode: "content_only", status: "queued",
        progressStage: "queued", message: null, createdAt: new Date(1_700_000_000_000).toISOString(), finishedAt: null,
      },
    });
    const markDispatchFailed = vi.spyOn(D1Reanalysis.prototype, "markDispatchFailed").mockResolvedValue();
    const response = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/review-1/revision-request", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ expectedRevision: 3, reason: "原因", changeRequest: "要求" }),
    }), Object.assign(workerEnv(() => new Response("asset"), database), { ANALYSIS_QUEUE: jobs }) as never);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).not.toContain("queue internals");
    expect(markDispatchFailed).toHaveBeenCalledWith("teacher-1", ["job-1"]);
    requestRevision.mockRestore();
    markDispatchFailed.mockRestore();
  });

  it("Queue sendBatch 失败补偿整批 submitted job 并返回 503", async () => {
    const database = authenticatedDatabase();
    const jobs = queue();
    jobs.sendBatch.mockRejectedValue(new Error("batch queue internals"));
    const commitBatch = vi.spyOn(D1Reanalysis.prototype, "commitBatch").mockResolvedValue({
      submitted: [
        { reviewId: "review-1", jobId: "job-1", revision: 4 },
        { reviewId: "review-3", jobId: "job-3", revision: 5 },
      ],
      skipped: [],
    });
    const markDispatchFailed = vi.spyOn(D1Reanalysis.prototype, "markDispatchFailed").mockResolvedValue();
    const response = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/batch-reanalysis", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ items: [{
        reviewId: "review-1", expectedRevision: 3, assignmentId: "assignment-1",
        expectedAssignmentUpdatedAt: new Date(1_700_000_000_000).toISOString(),
      }] }),
    }), Object.assign(workerEnv(() => new Response("asset"), database), { ANALYSIS_QUEUE: jobs }) as never);

    expect(response.status).toBe(503);
    expect(markDispatchFailed).toHaveBeenCalledWith("teacher-1", ["job-1", "job-3"]);
    expect(jobs.sendBatch).toHaveBeenCalledWith([
      { body: { jobId: "job-1" } },
      { body: { jobId: "job-3" } },
    ]);
    commitBatch.mockRestore();
    markDispatchFailed.mockRestore();
  });

  it("批量未知错误补偿此前已提交 job，返回 500 no-store 且不投递 Queue", async () => {
    const database = authenticatedDatabase();
    const jobs = queue();
    const commitBatch = vi.spyOn(D1Reanalysis.prototype, "commitBatch").mockRejectedValue(
      new D1ReanalysisBatchError([{ reviewId: "review-1", jobId: "job-1", revision: 4 }]),
    );
    const markDispatchFailed = vi.spyOn(D1Reanalysis.prototype, "markDispatchFailed").mockResolvedValue();
    const response = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/batch-reanalysis", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ items: [
        { reviewId: "review-1", expectedRevision: 3, assignmentId: "assignment-1", expectedAssignmentUpdatedAt: new Date(1_700_000_000_000).toISOString() },
        { reviewId: "review-2", expectedRevision: 3, assignmentId: "assignment-2", expectedAssignmentUpdatedAt: new Date(1_700_000_000_000).toISOString() },
      ] }),
    }), Object.assign(workerEnv(() => new Response("asset"), database), { ANALYSIS_QUEUE: jobs }) as never);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).not.toContain("D1 raw internal details");
    expect(markDispatchFailed).toHaveBeenCalledWith("teacher-1", ["job-1"]);
    expect(jobs.sendBatch).not.toHaveBeenCalled();
    commitBatch.mockRestore();
    markDispatchFailed.mockRestore();
  });

  it("批量未知错误的补偿失败仍返回安全 500", async () => {
    const database = authenticatedDatabase();
    const jobs = queue();
    const commitBatch = vi.spyOn(D1Reanalysis.prototype, "commitBatch").mockRejectedValue(
      new D1ReanalysisBatchError([{ reviewId: "review-1", jobId: "job-1", revision: 4 }]),
    );
    const markDispatchFailed = vi.spyOn(D1Reanalysis.prototype, "markDispatchFailed").mockRejectedValue(
      new Error("compensation D1 raw details"),
    );
    const response = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/batch-reanalysis", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ items: [
        { reviewId: "review-1", expectedRevision: 3, assignmentId: "assignment-1", expectedAssignmentUpdatedAt: new Date(1_700_000_000_000).toISOString() },
      ] }),
    }), Object.assign(workerEnv(() => new Response("asset"), database), { ANALYSIS_QUEUE: jobs }) as never);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).not.toContain("compensation D1 raw details");
    expect(markDispatchFailed).toHaveBeenCalledWith("teacher-1", ["job-1"]);
    expect(jobs.sendBatch).not.toHaveBeenCalled();
    commitBatch.mockRestore();
    markDispatchFailed.mockRestore();
  });
});
