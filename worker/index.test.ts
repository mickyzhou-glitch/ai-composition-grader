import * as opinionQueries from "../src/cloudflare/d1-grading-opinions";
import { readReviewGuidance } from "../src/grading-opinions/review-guidance";
import { afterEach, describe, expect, it, vi } from "vitest";

import worker, { savePipelineResult, saveUnreadableResult } from "./index";
import { D1AnalysisJobs } from "../src/cloudflare/d1-analysis-jobs";
import { D1Reanalysis, D1ReanalysisBatchError } from "../src/cloudflare/d1-reanalysis";
import { D1ReviewReader } from "../src/cloudflare/d1-review-reader";
import { OpenAIReviewAdapter } from "../src/ai/openai-review-adapter";
import { AiAdapterError } from "../src/ai/openai-review-adapter";
import { AssignmentGuidanceAdapter } from "../src/ai/assignment-guidance-adapter";

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
  sampleParagraphs: Array.from({ length: 5 }, (_, index) => ({
    title: `第 ${index + 1} 段`,
    text: "我".repeat(120),
    suggestion: "补充动作",
  })),
  parentFeedbacks: [],
};

const paragraphReport = {
  version: 2 as const,
  themeFit: "fits" as const,
  themeReason: "切题",
  personalizedComment: "细节真实",
  painPoints: [],
  commonIssues: [],
  revisionSuggestions: [],
  grade: "B+" as const,
  diagnostics: teacherReviewedReport.diagnostics,
  paragraphReviews: [{
    paragraphId: "paragraph-1",
    suggestions: [{ problem: "保留", advice: "保留真实动作", example: "我走上台。" }],
    revisedText: "我走上台。",
  }],
  parentFeedbacks: [],
};

const paragraphReviewView = {
  id: "review-1",
  status: "ready_for_review" as const,
  studentName: "小明",
  config: reviewConfig,
  report: paragraphReport,
  revision: 3,
  createdAt: new Date(1_700_000_000_000).toISOString(),
  updatedAt: new Date(1_700_000_000_000).toISOString(),
  teacherReviewedAt: null,
  images: [],
  annotations: [],
  ocr: {
    version: 2 as const,
    ocrRevision: 2,
    editedAt: null,
    pages: [{ pageIndex: 0, text: "我走上台。", readable: true, warnings: [] }],
    paragraphs: [{
      id: "paragraph-1",
      paragraphIndex: 0,
      text: "我走上台。",
      segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
    }],
  },
  reportStale: false,
  hasPdf: false,
  pdfFilename: null,
};

describe("Cloudflare Worker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("未登录不能查看批改意见存档", async () => {
    const response = await worker.fetch(new Request("https://grader.workers.dev/api/grading-opinions"), workerEnv(() => new Response("asset"), authenticatedDatabase()));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "UNAUTHENTICATED" } });
  });

  it("老师可以查看自己的空批改意见存档", async () => {
    const response = await worker.fetch(new Request("https://grader.workers.dev/api/grading-opinions", {
      headers: { cookie: "__Host-zuowen_session=session-token" },
    }), workerEnv(() => new Response("asset"), authenticatedDatabase()));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: [] });
  });

  it("课本导入拒绝无效图片并返回 400", async () => {
    const response = await worker.fetch(new Request("https://grader.workers.dev/api/assignment-guidance", {
      method: "POST", headers: { cookie: "__Host-zuowen_session=session-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "", grade: "六年级", targetCharacters: 600, textbookImages: ["https://example.test/book.jpg"] }),
    }), workerEnv(() => new Response("asset"), authenticatedDatabase()));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("课本识别失败时保留明确的识别错误供教师补填", async () => {
    vi.spyOn(AssignmentGuidanceAdapter.prototype, "generate").mockRejectedValue(
      new AiAdapterError("AI_INVALID_RESPONSE", "未能从课本图片识别作文题目，请补填题目", 502),
    );
    const response = await worker.fetch(new Request("https://grader.workers.dev/api/assignment-guidance", {
      method: "POST", headers: { cookie: "__Host-zuowen_session=session-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "", grade: "六年级", targetCharacters: 600, textbookImages: ["data:image/png;base64,eA=="] }),
    }), workerEnv(() => new Response("asset"), authenticatedDatabase()));
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "AI_INVALID_RESPONSE", message: expect.stringContaining("补填题目") } });
  });

  it("单段重写路由只把 OCR 段落文字和当前草稿发送给内容模型", async () => {
    const get = vi.spyOn(D1ReviewReader.prototype, "get")
      .mockResolvedValue(paragraphReviewView as never);
    const rewritten = {
      ...paragraphReport.paragraphReviews[0],
      revisedText: "我听见自己的呼吸声，终于走上台。",
    };
    const rewriteParagraph = vi.spyOn(OpenAIReviewAdapter.prototype, "rewriteParagraph")
      .mockResolvedValue(rewritten);

    const response = await worker.fetch(new Request(
      "https://grader.workers.dev/api/reviews/review-1/paragraph-reviews/paragraph-1",
      {
        method: "POST",
        headers: {
          cookie: "__Host-zuowen_session=session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          paragraphReviews: paragraphReport.paragraphReviews,
          instruction: "补充听觉细节",
        }),
      },
    ), workerEnv(() => new Response("asset"), authenticatedDatabase()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: rewritten });
    expect(get).toHaveBeenCalledWith("teacher-1", "review-1");
    expect(rewriteParagraph).toHaveBeenCalledWith({
      config: reviewConfig,
      paragraphs: [{ id: "paragraph-1", text: "我走上台。" }],
      current: paragraphReport.paragraphReviews[0],
      paragraphReviews: paragraphReport.paragraphReviews,
      teacherGuidance: undefined,
      paragraphId: "paragraph-1",
      instruction: "补充听觉细节",
    });
    get.mockRestore();
    rewriteParagraph.mockRestore();
  });

  it.each([undefined, "", "本轮三段式"])("单段重写使用当前或已保存指导 %s，服务端主动加载本篇历史和同题规则", async (draft) => {
    vi.spyOn(D1ReviewReader.prototype, "get").mockResolvedValue({ ...paragraphReviewView, teacherGuidance: "保存的指导" } as never);
    vi.spyOn(opinionQueries, "listD1StandingOpinions").mockResolvedValue([{ text: "同题长期规则", createdAt: 1 }]);
    vi.spyOn(opinionQueries, "listD1EssayOpinions").mockResolvedValue([{ text: "本篇最近历史", createdAt: Date.parse("2026-11-05T10:14:01+08:00") }]);
    const rewrite = vi.spyOn(OpenAIReviewAdapter.prototype, "rewriteParagraph").mockResolvedValue(paragraphReport.paragraphReviews[0]);
    const response = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/review-1/paragraph-reviews/paragraph-1", {
      method: "POST", headers: { cookie: "__Host-zuowen_session=session-token", "content-type": "application/json" },
      body: JSON.stringify({ paragraphReviews: paragraphReport.paragraphReviews, ...(draft !== undefined ? { teacherGuidance: draft } : {}) }),
    }), workerEnv(() => new Response("asset"), authenticatedDatabase()));
    expect(response.status).toBe(200);
    const layers = readReviewGuidance(rewrite.mock.calls[0][0].teacherGuidance);
    expect(layers.current).toBe(draft ?? "保存的指导");
    expect(layers.history).toBe("[2026-11-05] 本篇最近历史");
    expect(layers.standing).toContain("同题长期规则");
    expect(opinionQueries.listD1EssayOpinions).toHaveBeenCalledWith(expect.anything(), "teacher-1", "review-1");
    expect(opinionQueries.listD1StandingOpinions).toHaveBeenCalledWith(expect.anything(), "teacher-1", reviewConfig.title);
  });

  it.each([
    ["旧报告", { ...paragraphReviewView, report: teacherReviewedReport }, "LEGACY_REPORT"],
    ["过期报告", { ...paragraphReviewView, reportStale: true }, "REPORT_STALE"],
    ["OCR v1", {
      ...paragraphReviewView,
      ocr: { version: 1, ocrRevision: 0, editedAt: null, pages: [] },
    }, "OCR_V2_REQUIRED"],
  ])("单段重写拒绝%s", async (_case, review, code) => {
    const get = vi.spyOn(D1ReviewReader.prototype, "get").mockResolvedValue(review as never);
    const rewriteParagraph = vi.spyOn(OpenAIReviewAdapter.prototype, "rewriteParagraph");

    const response = await worker.fetch(new Request(
      "https://grader.workers.dev/api/reviews/review-1/paragraph-reviews/paragraph-1",
      {
        method: "POST",
        headers: {
          cookie: "__Host-zuowen_session=session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ paragraphReviews: paragraphReport.paragraphReviews }),
      },
    ), workerEnv(() => new Response("asset"), authenticatedDatabase()));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(rewriteParagraph).not.toHaveBeenCalled();
    get.mockRestore();
    rewriteParagraph.mockRestore();
  });

  it("analyze 路由把 OCR_V2_REQUIRED 显式映射为 409", async () => {
    const enqueue = vi.spyOn(D1AnalysisJobs.prototype, "enqueue").mockRejectedValue(
      Object.assign(new Error("OCR_V2_REQUIRED"), {
        code: "OCR_V2_REQUIRED",
        status: 409,
      }),
    );
    const response = await worker.fetch(new Request(
      "https://grader.workers.dev/api/reviews/review-1/analyze",
      {
        method: "POST",
        headers: {
          cookie: "__Host-zuowen_session=session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ mode: "content_only" }),
      },
    ), Object.assign(
      workerEnv(() => new Response("asset"), authenticatedDatabase()),
      { ANALYSIS_QUEUE: queue() },
    ) as never);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "OCR_V2_REQUIRED", message: "当前识别原文需要重新识别" },
    });
    enqueue.mockRestore();
  });

  it("analyze 路由把未知异常收敛为固定 VALIDATION_ERROR", async () => {
    const enqueue = vi.spyOn(D1AnalysisJobs.prototype, "enqueue")
      .mockRejectedValue(new Error("SECRET_INTERNAL_DATABASE_MESSAGE"));
    const response = await worker.fetch(new Request(
      "https://grader.workers.dev/api/reviews/review-1/analyze",
      {
        method: "POST",
        headers: {
          cookie: "__Host-zuowen_session=session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
    ), Object.assign(
      workerEnv(() => new Response("asset"), authenticatedDatabase()),
      { ANALYSIS_QUEUE: queue() },
    ) as never);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("VALIDATION_ERROR");
    expect(body).not.toContain("SECRET_INTERNAL_DATABASE_MESSAGE");
    enqueue.mockRestore();
  });

  it("作文分析中的教师 PATCH 返回 409 且不覆盖 Worker 所有权", async () => {
    const run = vi.fn();
    const batch = vi.fn();
    const database = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(
            sql.includes("FROM sessions INNER JOIN users")
              ? {
                  id: "teacher-1",
                  username: "teacher",
                  role: "teacher",
                  must_change_password: 0,
                  expires_at: Date.now() + 60_000,
                }
              : sql.startsWith("SELECT student_name")
                ? {
                    student_name: "小明",
                    config: JSON.stringify(reviewConfig),
                    report: null,
                    status: "analyzing",
                    revision: 4,
                    analysis_run_id: "job-running",
                  }
                : null,
          ),
          run,
        })),
      })),
      batch,
    };

    const response = await worker.fetch(new Request(
      "https://grader.workers.dev/api/reviews/review-1",
      {
        method: "PATCH",
        headers: {
          cookie: "__Host-zuowen_session=session-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ expectedRevision: 4, studentName: "小红" }),
      },
    ), workerEnv(() => new Response("asset"), database));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "REVISION_CONFLICT" },
    });
    expect(run).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

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

  it("Gemini 连接测试使用低思考档位与充足 max_completion_tokens，遇 400 回退不带 reasoning_effort，并在失败时返回脱敏上游原因", async () => {
    const database = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(sql.includes("FROM sessions INNER JOIN users") ? {
            id: "admin-1",
            username: "admin",
            role: "admin",
            must_change_password: 0,
            expires_at: Date.now() + 60_000,
          } : sql.includes("FROM settings") ? {
            base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
            encrypted_api_key: null,
          } : null),
        })),
      })),
    };
    const upstream = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "OK" } }],
      }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        error: { code: 400, message: "reasoning_effort unsupported", status: "INVALID_ARGUMENT" },
      }]), { status: 400, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "OK" } }],
      }), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{
        error: {
          code: 429,
          message: "Quota exceeded for gemini-4-carbon with key AIzaSyD1234567890abcdefghijklmno_pqrstuv",
          status: "RESOURCE_EXHAUSTED",
        },
      }]), { status: 429, headers: { "content-type": "application/json" } }));

    const env = {
      ASSETS: { fetch: async () => new Response("asset") },
      DB: database,
      CONTENT_AI_API_KEY: "gemini-secret",
      VISION_AI_API_KEY: "gemini-vision-secret",
    } as never;

    const first = await worker.fetch(new Request("https://grader.workers.dev/api/settings/content/test", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        model: "gemini-4-carbon",
      }),
    }), env);
    expect(first.status).toBe(200);
    const firstBody = JSON.parse((upstream.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(firstBody.reasoning_effort).toBe("low");
    expect(firstBody.max_completion_tokens).toBeGreaterThanOrEqual(512);
    expect(firstBody).not.toHaveProperty("max_tokens");

    const fallback = await worker.fetch(new Request("https://grader.workers.dev/api/settings/vision/test", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        model: "gemini-2.0-flash",
      }),
    }), env);
    expect(fallback.status).toBe(200);
    const retryBody = JSON.parse((upstream.mock.calls[2]?.[1] as RequestInit).body as string);
    expect(retryBody).not.toHaveProperty("reasoning_effort");
    expect(retryBody.max_completion_tokens).toBeGreaterThanOrEqual(512);

    const failed = await worker.fetch(new Request("https://grader.workers.dev/api/settings/content/test", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        model: "gemini-4-carbon",
      }),
    }), env);
    expect(failed.status).toBe(502);
    const failedJson = await failed.json() as { error: { code: string; message: string } };
    expect(failedJson.error.code).toBe("AI_CONNECTION_FAILED");
    expect(failedJson.error.message).toContain("HTTP 429");
    expect(failedJson.error.message).toContain("[密钥]");
    expect(failedJson.error.message).not.toContain("AIzaSyD1234567890abcdefghijklmno_pqrstuv");
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
      version: 2,
      sourceRevision: 2,
      ocrRevision: 3,
      editedAt: null,
      pages: [{ pageIndex: 0, text: "作文原文", readable: true, warnings: [], blocks: [] }],
      paragraphs: [{
        id: "paragraph-1",
        paragraphIndex: 0,
        text: "作文原文",
        segments: [{ pageIndex: 0, text: "作文原文", x: 0.1, y: 0.2, width: 0.5, height: 0.08 }],
      }],
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
        paragraphs: [{ paragraphId: "paragraph-1", text: "修正后原文" }],
      }),
    }), workerEnv(() => new Response("asset"), database));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: { code: "OCR_REVISION_CONFLICT", message: "识别原文已被更新" },
    });
  });

  it("OCR PATCH 拒绝旧逐页请求和 v1 检查点", async () => {
    const checkpoint = JSON.stringify({
      version: 1,
      sourceRevision: 2,
      ocrRevision: 0,
      editedAt: null,
      pages: [{ pageIndex: 0, text: "旧作文原文", readable: true, warnings: [], blocks: [] }],
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
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        })),
      })),
    };
    const env = workerEnv(() => new Response("asset"), database);
    const headers = {
      cookie: "__Host-zuowen_session=session-token",
      "content-type": "application/json",
    };

    const legacy = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/review-1/ocr", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        expectedOcrRevision: 0,
        pages: [{ pageIndex: 0, text: "伪装的逐页编辑" }],
      }),
    }), env);
    expect(legacy.status).toBe(400);

    const v1 = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/review-1/ocr", {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        expectedOcrRevision: 0,
        paragraphs: [{ paragraphId: "paragraph-1", text: "修正" }],
      }),
    }), env);
    expect(v1.status).toBe(409);
    await expect(v1.json()).resolves.toMatchObject({
      error: { code: "OCR_V2_REQUIRED" },
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

  it("并发失去 analysis ownership 时拒绝把旧任务结果落库", async () => {
    const prepared: Array<{ sql: string }> = [];
    const database = {
      prepare: vi.fn((sql: string) => {
        const statement = { sql, bind() { return statement; } };
        prepared.push(statement);
        return statement;
      }),
      batch: vi.fn(async (statements: unknown[]) =>
        (statements as unknown[]).map(() => ({ meta: { changes: 0 } }))),
    } as unknown as D1Database;

    await expect(savePipelineResult(database, {
      id: "job-1", reviewId: "review-1", ownerId: "owner-1", mode: "full",
      imageRevision: 4, config: {} as never,
    }, { report: {}, annotations: [], ocrRevision: 2 }))
      .rejects.toMatchObject({ code: "ANALYSIS_CONFLICT" });
    expect(prepared[0]?.sql).toContain("analysis_run_id = ?");
    expect(prepared[0]?.sql).toContain("image_revision = ?");
    expect(prepared[0]?.sql).toContain("ocrRevision");
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
    expect(prepared[0].sql).toContain("analysis_run_id = ?");
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
      className: "",
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
          } : sql.includes("SELECT config, status, revision, image_revision, ocr_checkpoint, report_ocr_revision FROM reviews") ? {
            config: JSON.stringify(reviewConfig), revision: 3,
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

  it("完全不能用返回审核不通过且不投递分析队列", async () => {
    const database = authenticatedDatabase();
    const jobs = queue();
    const rejectReview = vi.spyOn(D1Reanalysis.prototype, "rejectReview").mockResolvedValue({
      id: "review-1",
      status: "rejected",
      revision: 4,
      rejectionReason: null,
      rejectionChangeRequest: null,
    });
    const response = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/review-1/reject", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ expectedRevision: 3 }),
    }), Object.assign(workerEnv(() => new Response("asset"), database), { ANALYSIS_QUEUE: jobs }) as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      data: { status: "rejected", revision: 4 },
    });
    expect(jobs.send).not.toHaveBeenCalled();
    expect(jobs.sendBatch).not.toHaveBeenCalled();
    expect(rejectReview).toHaveBeenCalledWith("teacher-1", "review-1", {
      expectedRevision: 3,
      reason: "",
      changeRequest: "",
    });
    rejectReview.mockRestore();
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
      body: JSON.stringify({ expectedRevision: 3, commonIssue: "原因", contentSuggestion: "要求" }),
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
      body: JSON.stringify({ expectedRevision: 3, commonIssue: "原因", contentSuggestion: "要求" }),
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

  it("单篇 analyze 投递 Queue 失败时补偿释放任务并返回 503", async () => {
    const database = authenticatedDatabase();
    const jobs = { send: vi.fn().mockRejectedValue(new Error("queue down")), sendBatch: vi.fn() };
    const enqueue = vi.spyOn(D1AnalysisJobs.prototype, "enqueue").mockResolvedValue({
      job: { id: "job-single-1", reviewId: "review-1", status: "queued" },
      newlyQueued: true,
    });
    const markDispatchFailed = vi.spyOn(D1Reanalysis.prototype, "markDispatchFailed").mockResolvedValue();
    const response = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/review-1/analyze", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    }), Object.assign(workerEnv(() => new Response("asset"), database), { ANALYSIS_QUEUE: jobs }) as never);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "QUEUE_DISPATCH_FAILED" },
    });
    expect(markDispatchFailed).toHaveBeenCalledWith("teacher-1", ["job-single-1"]);
    enqueue.mockRestore();
    markDispatchFailed.mockRestore();
  });

  it("替换上传图片成功后清理 R2 中的旧图且不影响返回结构", async () => {
    const database = authenticatedDatabase();
    const files = { put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) };
    const { D1ImageWriter } = await import("../src/cloudflare/d1-image-writer");
    const replace = vi.spyOn(D1ImageWriter.prototype, "replace").mockResolvedValue({
      images: [{ id: 10, position: 0 }],
      revision: 3,
      replacedPaths: ["images/old-1.jpg", "images/old-2.jpg"],
    });
    const form = new FormData();
    form.set("expectedRevision", "2");
    form.set("privacyConfirmed", "true");
    form.set("privacyNoticeVersion", "2026-07-22");
    form.set("imageMeta", JSON.stringify([{ width: 800, height: 1000 }]));
    form.append("images", new File([new Uint8Array([0xff, 0xd8, 0xff])], "page1.jpg", { type: "image/jpeg" }));

    const request = new Request("https://grader.workers.dev/api/reviews/review-1/images", {
      method: "POST",
      headers: { cookie: "__Host-zuowen_session=session-token" },
    });
    vi.spyOn(request, "formData").mockResolvedValue(form);

    const response = await worker.fetch(request, Object.assign(workerEnv(() => new Response("asset"), database), { FILES: files }) as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: { images: [{ id: 10, position: 0 }], revision: 3 },
    });
    expect(files.delete).toHaveBeenCalledWith([
      "users/teacher-1/reviews/review-1/images/old-1.jpg",
      "users/teacher-1/reviews/review-1/images/old-2.jpg",
    ]);
    replace.mockRestore();
  });

  it("跨站 Origin 或 Sec-Fetch-Site=cross-site 的业务写请求被 403 拦截，且所有 API 响应统一带 nosniff 与 no-store", async () => {
    const database = authenticatedDatabase();
    const env = workerEnv(() => new Response("asset"), database);

    const badOrigin = await worker.fetch(new Request("https://grader.workers.dev/api/reviews", {
      method: "POST",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    }), env as never);
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.headers.get("x-content-type-options")).toBe("nosniff");
    expect(badOrigin.headers.get("cache-control")).toBe("no-store");
    await expect(badOrigin.json()).resolves.toMatchObject({ ok: false, error: { code: "UNTRUSTED_ORIGIN" } });

    const badFetchSite = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/r1", {
      method: "DELETE",
      headers: {
        cookie: "__Host-zuowen_session=session-token",
        "sec-fetch-site": "cross-site",
      },
    }), env as never);
    expect(badFetchSite.status).toBe(403);

    const health = await worker.fetch(new Request("https://grader.workers.dev/api/health"), env as never);
    expect(health.status).toBe(200);
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(health.headers.get("cache-control")).toBe("no-store");
  });

  it("强制改密账号（must_change_password=1）访问业务 API 返回 403 PASSWORD_CHANGE_REQUIRED，访问首页 302 跳到改密页", async () => {
    const database = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(sql.includes("FROM sessions INNER JOIN users") ? {
            id: "teacher-must-change",
            username: "teacher",
            role: "teacher",
            must_change_password: 1,
            expires_at: Date.now() + 60_000,
          } : null),
        })),
      })),
    };
    const env = workerEnv(() => new Response("asset"), database);

    const apiResponse = await worker.fetch(new Request("https://grader.workers.dev/api/reviews", {
      headers: { cookie: "__Host-zuowen_session=session-token" },
    }), env as never);
    expect(apiResponse.status).toBe(403);
    await expect(apiResponse.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "PASSWORD_CHANGE_REQUIRED" },
    });

    const htmlResponse = await worker.fetch(new Request("https://grader.workers.dev/", {
      headers: { cookie: "__Host-zuowen_session=session-token", accept: "text/html" },
    }), env as never);
    expect(htmlResponse.status).toBe(302);
    expect(htmlResponse.headers.get("location")).toBe("https://grader.workers.dev/change-password");
  });

  it("设置接口更换 baseUrl 域名而未重填密钥时拒绝复用旧密钥，且拦截生产环境非 HTTPS 或内网地址", async () => {
    const database = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(sql.includes("FROM sessions INNER JOIN users") ? {
            id: "admin-1",
            username: "admin",
            role: "admin",
            must_change_password: 0,
            expires_at: Date.now() + 60_000,
          } : sql.includes("FROM settings") ? {
            base_url: "https://api.deepseek.com",
            encrypted_api_key: "sealed-existing",
          } : null),
        })),
      })),
    };
    const upstream = vi.spyOn(globalThis, "fetch");
    const env = Object.assign(workerEnv(() => new Response("asset"), database), {
      CONTENT_AI_API_KEY: "env-secret",
    });

    const exfilAttempt = await worker.fetch(new Request("https://grader.workers.dev/api/settings/content/test", {
      method: "POST",
      headers: { cookie: "__Host-zuowen_session=session-token", "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://attacker.example/v1", model: "probe" }),
    }), env as never);
    expect(exfilAttempt.status).toBe(400);
    await expect(exfilAttempt.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "AI_SETTINGS_INCOMPLETE" },
    });
    expect(upstream).not.toHaveBeenCalled();

    const ssrfAttempt = await worker.fetch(new Request("https://grader.workers.dev/api/settings/content/test", {
      method: "POST",
      headers: { cookie: "__Host-zuowen_session=session-token", "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://127.0.0.1:8080/v1", model: "probe", apiKey: "sk-new" }),
    }), env as never);
    expect(ssrfAttempt.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("畸形百分号编码路径返回 400 VALIDATION_ERROR，不抛出未捕获 URIError", async () => {
    const database = authenticatedDatabase();
    const response = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/%E0%A4%A", {
      headers: { cookie: "__Host-zuowen_session=session-token" },
    }), workerEnv(() => new Response("asset"), database) as never);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("图片上传拦截伪造文件头与超过 12MB 的整篇总体积，不在 R2 残留对象", async () => {
    const database = authenticatedDatabase();
    const files = { put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) };
    const env = Object.assign(workerEnv(() => new Response("asset"), database), { FILES: files });

    const fakeJpgForm = new FormData();
    fakeJpgForm.set("expectedRevision", "1");
    fakeJpgForm.set("privacyConfirmed", "true");
    fakeJpgForm.set("privacyNoticeVersion", "2026-07-22");
    fakeJpgForm.set("imageMeta", JSON.stringify([{ width: 800, height: 1000 }]));
    fakeJpgForm.append("images", new File(["not-a-real-jpeg"], "fake.jpg", { type: "image/jpeg" }));
    const fakeReq = new Request("https://grader.workers.dev/api/reviews/review-1/images", {
      method: "POST",
      headers: { cookie: "__Host-zuowen_session=session-token" },
    });
    vi.spyOn(fakeReq, "formData").mockResolvedValue(fakeJpgForm);

    const fakeRes = await worker.fetch(fakeReq, env as never);
    expect(fakeRes.status).toBe(422);
    expect(files.put).not.toHaveBeenCalled();

    const oversizedChunk = new Uint8Array(7 * 1024 * 1024);
    oversizedChunk[0] = 0xff;
    oversizedChunk[1] = 0xd8;
    oversizedChunk[2] = 0xff;
    const bigForm = new FormData();
    bigForm.set("expectedRevision", "1");
    bigForm.set("privacyConfirmed", "true");
    bigForm.set("privacyNoticeVersion", "2026-07-22");
    bigForm.set("imageMeta", JSON.stringify([{ width: 800, height: 1000 }, { width: 800, height: 1000 }]));
    bigForm.append("images", new File([oversizedChunk], "p1.jpg", { type: "image/jpeg" }));
    bigForm.append("images", new File([oversizedChunk], "p2.jpg", { type: "image/jpeg" }));
    const bigReq = new Request("https://grader.workers.dev/api/reviews/review-1/images", {
      method: "POST",
      headers: { cookie: "__Host-zuowen_session=session-token" },
    });
    vi.spyOn(bigReq, "formData").mockResolvedValue(bigForm);

    const bigRes = await worker.fetch(bigReq, env as never);
    expect(bigRes.status).toBe(422);
    await expect(bigRes.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "AI_INLINE_IMAGE_TOO_LARGE" },
    });
    expect(files.put).not.toHaveBeenCalled();
  });

  it("scheduled 定时任务每分钟执行超时回收，但仅在 15 分钟整点执行全表维护清理", async () => {
    const recoverSpy = vi.spyOn(D1AnalysisJobs.prototype, "recoverExpired").mockResolvedValue(0);
    const maintenanceModule = await import("../src/cloudflare/d1-maintenance");
    const maintenanceSpy = vi.spyOn(maintenanceModule, "runCloudMaintenance").mockResolvedValue({
      emptyDraftsDeleted: 0,
      loginChallengesDeleted: 0,
      sessionsDeleted: 0,
      loginAttemptsDeleted: 0,
    });
    const database = authenticatedDatabase();

    // Minute 7: recover runs, maintenance skipped
    await worker.scheduled({ scheduledTime: 7 * 60_000 } as ScheduledController, { DB: database } as never);
    expect(recoverSpy).toHaveBeenCalledTimes(1);
    expect(maintenanceSpy).not.toHaveBeenCalled();

    // Minute 15: both recover and maintenance run
    await worker.scheduled({ scheduledTime: 15 * 60_000 } as ScheduledController, { DB: database } as never);
    expect(recoverSpy).toHaveBeenCalledTimes(2);
    expect(maintenanceSpy).toHaveBeenCalledTimes(1);

    recoverSpy.mockRestore();
    maintenanceSpy.mockRestore();
  });

  it("授权图片接口返回私有 immutable 缓存与 ETag，命中 If-None-Match 时返回 304 且免读 R2", async () => {
    const database = authenticatedDatabase();
    const imageKey = vi.spyOn(D1ReviewReader.prototype, "imageObjectKey").mockResolvedValue({
      key: "users/teacher-1/reviews/review-1/images/page-uuid-1.jpg",
      contentType: "image/jpeg",
    });
    const filesGet = vi.fn().mockResolvedValue({
      body: "jpeg-bytes",
      httpMetadata: { contentType: "image/jpeg" },
    });
    const env = Object.assign(workerEnv(() => new Response("asset"), database), { FILES: { get: filesGet } });

    const first = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/review-1/files?imageId=1&variant=original", {
      headers: { cookie: "__Host-zuowen_session=session-token" },
    }), env as never);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, max-age=3600, immutable");
    expect(first.headers.get("vary")).toBe("Cookie");
    const etag = first.headers.get("etag");
    expect(etag).toBe("\"page-uuid-1.jpg\"");
    expect(filesGet).toHaveBeenCalledTimes(1);

    const cached = await worker.fetch(new Request("https://grader.workers.dev/api/reviews/review-1/files?imageId=1&variant=original", {
      headers: { cookie: "__Host-zuowen_session=session-token", "if-none-match": etag! },
    }), env as never);
    expect(cached.status).toBe(304);
    expect(cached.headers.get("cache-control")).toBe("private, max-age=3600, immutable");
    expect(filesGet).toHaveBeenCalledTimes(1);
    imageKey.mockRestore();
  });

  it("GET /api/reviews?ids=... 支持按指定 ID 点查并拒绝非法参数，POST /exported 免除冗余详情重查，且会话活跃更新走 waitUntil", async () => {
    const waitUntil = vi.fn();
    const touchRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const database = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          bind() { return statement; },
          first: vi.fn(async () => sql.includes("FROM sessions INNER JOIN users") ? {
            id: "teacher-1",
            username: "teacher",
            role: "teacher",
            must_change_password: 0,
            session_id: "sess-1",
            last_seen_at: Date.now() - 120_000,
            expires_at: Date.now() + 60_000,
          } : null),
          all: vi.fn(async () => ({ results: [] })),
          run: touchRun,
        };
        return statement;
      }),
      batch: vi.fn(async () => []),
    };
    const env = workerEnv(() => new Response("asset"), database);
    const listSpy = vi.spyOn(D1ReviewReader.prototype, "list").mockResolvedValue([{ id: "review-a" }]);

    const filtered = await worker.fetch(
      new Request("https://grader.workers.dev/api/reviews?ids=review-a,review-b,review-a", {
        headers: { cookie: "__Host-zuowen_session=session-token" },
      }),
      env as never,
      { waitUntil, passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    );
    expect(filtered.status).toBe(200);
    expect(listSpy).toHaveBeenCalledWith("teacher-1", { ids: ["review-a", "review-b"] });
    expect(waitUntil).toHaveBeenCalledTimes(1);

    const invalidIds = await worker.fetch(
      new Request("https://grader.workers.dev/api/reviews?ids=../bad", {
        headers: { cookie: "__Host-zuowen_session=session-token" },
      }),
      env as never,
    );
    expect(invalidIds.status).toBe(400);

    const { D1ReviewWriter } = await import("../src/cloudflare/d1-review-writer");
    const markSpy = vi.spyOn(D1ReviewWriter.prototype, "markExported").mockResolvedValue(true);
    const getSpy = vi.spyOn(D1ReviewReader.prototype, "get");
    const exportedRes = await worker.fetch(
      new Request("https://grader.workers.dev/api/reviews/review-a/exported", {
        method: "POST",
        headers: { cookie: "__Host-zuowen_session=session-token" },
      }),
      env as never,
    );
    expect(exportedRes.status).toBe(200);
    await expect(exportedRes.json()).resolves.toEqual({
      ok: true,
      data: { id: "review-a", status: "exported" },
    });
    expect(getSpy).not.toHaveBeenCalled();

    listSpy.mockRestore();
    markSpy.mockRestore();
    getSpy.mockRestore();
  });
});
