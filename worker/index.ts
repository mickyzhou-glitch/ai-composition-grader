import type { WorkerEnv } from "../src/cloudflare/env";
import { D1LoginChallengeRepository } from "../src/cloudflare/d1-login-challenge-repository";
import { D1PasswordProofRepository } from "../src/cloudflare/d1-password-proof-repository";
import { D1SessionRepository } from "../src/cloudflare/d1-session-repository";
import { D1ReviewReader } from "../src/cloudflare/d1-review-reader";
import { D1ReviewWriter } from "../src/cloudflare/d1-review-writer";
import { D1AnalysisJobs } from "../src/cloudflare/d1-analysis-jobs";
import { createAiImageUrl, verifyAiImageUrl } from "../src/cloudflare/ai-image-url";
import { loadInlineAiImageUrls } from "../src/cloudflare/ai-inline-image";
import { aiRequestHeaders } from "../src/cloudflare/ai-request-headers";
import { createWorkerOpenAIClient } from "../src/cloudflare/worker-openai-client";
import { D1ImageWriter } from "../src/cloudflare/d1-image-writer";
import { authenticatedWorkerUser, handleWorkerAuth } from "../src/cloudflare/worker-auth-routes";
import { AiAdapterError, OpenAIReviewAdapter } from "../src/ai/openai-review-adapter";
import { AssignmentGuidanceAdapter } from "../src/ai/assignment-guidance-adapter";
import { openSetting, sealSetting } from "../src/cloudflare/settings-secret";
import type { ReviewView } from "../app/lib/types";

function apiError(code: string, message: string, status: number): Response {
  return Response.json({ ok: false, error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

function secureResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.set("content-security-policy", "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; object-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function normalizeSettingsCandidate(value: { baseUrl?: unknown; model?: unknown; apiKey?: unknown }): { baseUrl: string; model: string; apiKey?: string } {
  if (typeof value.baseUrl !== "string" || !/^https?:\/\//u.test(value.baseUrl) || typeof value.model !== "string" || !value.model.trim()) throw new Error("INVALID_SETTINGS");
  if (value.apiKey !== undefined && (typeof value.apiKey !== "string" || !value.apiKey.trim())) throw new Error("INVALID_SETTINGS");
  return { baseUrl: value.baseUrl.replace(/\/+$/u, ""), model: value.model.trim(), ...(typeof value.apiKey === "string" ? { apiKey: value.apiKey.trim() } : {}) };
}

async function configuredApiKey(env: WorkerEnv, encryptedApiKey: string | null): Promise<string | null> {
  if (encryptedApiKey) return openSetting(encryptedApiKey, env.AUTH_PROOF_ENCRYPTION_KEY);
  return env.AI_API_KEY || null;
}

async function testAiConnection(input: { baseUrl: string; model: string; apiKey: string }): Promise<void> {
  const response = await fetch(`${input.baseUrl}/chat/completions`, {
    method: "POST",
    headers: aiRequestHeaders(input.baseUrl, input.apiKey),
    body: JSON.stringify({ model: input.model, messages: [{ role: "user", content: "只回复 OK" }], max_tokens: 8 }),
  });
  if (!response.ok) throw new Error("AI_CONNECTION_FAILED");
  const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  if (typeof payload.choices?.[0]?.message?.content !== "string" || !payload.choices[0].message.content.trim()) throw new Error("AI_CONNECTION_FAILED");
}

function workerAiSettings(env: WorkerEnv) {
  return {
    async getRuntimeConfig() {
      const settings = await env.DB.prepare("SELECT base_url, model, encrypted_api_key FROM settings WHERE id = 1").first<{ base_url: string; model: string; encrypted_api_key: string | null }>();
      if (!settings) return null;
      const apiKey = await configuredApiKey(env, settings.encrypted_api_key);
      return apiKey ? { baseUrl: settings.base_url, model: settings.model, apiKey } : null;
    },
  };
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const authResponse = await handleWorkerAuth(request, {
      appOrigin: url.origin,
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
    const aiImageMatch = /^\/api\/ai-images\/([^/]+)\/(\d+)$/u.exec(url.pathname);
    if (aiImageMatch && request.method === "GET") {
      const reviewId = decodeURIComponent(aiImageMatch[1]);
      const imageId = Number(aiImageMatch[2]);
      const variant = await verifyAiImageUrl({ secret: env.AI_FILE_URL_SECRET, reviewId, imageId, variant: url.searchParams.get("variant"), expires: url.searchParams.get("expires"), signature: url.searchParams.get("signature") });
      if (!variant) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      const file = await new D1ReviewReader(env.DB).imageObjectKeyForAi(reviewId, imageId, variant);
      if (!file) return apiError("FILE_NOT_FOUND", "图片不存在", 404);
      const object = await env.FILES.get(file.key);
      if (!object) return apiError("FILE_NOT_FOUND", "图片不存在", 404);
      return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType ?? file.contentType, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
    }
    const sessions = new D1SessionRepository(env.DB);
    const user = await authenticatedWorkerUser(request, sessions);
    if (url.pathname === "/api/settings" && request.method === "GET") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      const settings = await env.DB.prepare("SELECT base_url, model, encrypted_api_key FROM settings WHERE id = 1").first<{ base_url: string; model: string; encrypted_api_key: string | null }>();
      return Response.json({ ok: true, data: settings ? { baseUrl: settings.base_url, model: settings.model, keyConfigured: settings.encrypted_api_key !== null || Boolean(env.AI_API_KEY) } : null });
    }
    if (url.pathname === "/api/settings" && request.method === "PUT") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      try {
        const candidate = normalizeSettingsCandidate(await request.json() as { baseUrl?: unknown; model?: unknown; apiKey?: unknown });
        const encrypted = candidate.apiKey ? await sealSetting(candidate.apiKey, env.AUTH_PROOF_ENCRYPTION_KEY) : null;
        const previous = await env.DB.prepare("SELECT encrypted_api_key FROM settings WHERE id = 1").first<{ encrypted_api_key: string | null }>();
        await env.DB.prepare("INSERT INTO settings (id, base_url, model, updated_at, encrypted_api_key) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET base_url = excluded.base_url, model = excluded.model, updated_at = excluded.updated_at, encrypted_api_key = COALESCE(excluded.encrypted_api_key, settings.encrypted_api_key)").bind(candidate.baseUrl, candidate.model, Date.now(), encrypted).run();
        return Response.json({ ok: true, data: { baseUrl: candidate.baseUrl, model: candidate.model, keyConfigured: encrypted !== null || previous?.encrypted_api_key !== null || Boolean(env.AI_API_KEY) } });
      } catch { return apiError("VALIDATION_ERROR", "请求参数无效", 400); }
    }
    if (url.pathname === "/api/settings/test" && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      try {
        const candidate = normalizeSettingsCandidate(await request.json() as { baseUrl?: unknown; model?: unknown; apiKey?: unknown });
        const stored = await env.DB.prepare("SELECT encrypted_api_key FROM settings WHERE id = 1").first<{ encrypted_api_key: string | null }>();
        const apiKey = candidate.apiKey ?? await configuredApiKey(env, stored?.encrypted_api_key ?? null);
        if (!apiKey) return apiError("AI_SETTINGS_INCOMPLETE", "请先填写 API Key", 400);
        await testAiConnection({ ...candidate, apiKey });
        return Response.json({ ok: true, data: { connected: true } });
      } catch (error) {
        if (error instanceof Error && error.message === "AI_SETTINGS_INCOMPLETE") return apiError("AI_SETTINGS_INCOMPLETE", "请先填写 API Key", 400);
        return apiError("AI_CONNECTION_FAILED", "AI 服务连接失败，请检查地址、模型和密钥", 502);
      }
    }
    if (url.pathname === "/api/assignment-guidance" && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      try {
        return Response.json({ ok: true, data: await new AssignmentGuidanceAdapter(workerAiSettings(env), { clientFactory: createWorkerOpenAIClient }).generate(await request.json()) });
      } catch {
        return apiError("AI_REQUEST_FAILED", "AI 服务请求失败，请检查设置后重试", 502);
      }
    }
    if (url.pathname === "/api/reviews" && request.method === "GET") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      return Response.json({ ok: true, data: await new D1ReviewReader(env.DB).list(user.id) }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/reviews" && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      try {
        const review = await new D1ReviewWriter(env.DB).create(user.id, await request.json());
        return Response.json({ ok: true, data: review }, { status: 201, headers: { "cache-control": "no-store" } });
      } catch {
        return apiError("VALIDATION_ERROR", "请求参数无效", 400);
      }
    }
    if (url.pathname === "/api/saved-assignments" && request.method === "GET") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      return Response.json({ ok: true, data: await new D1ReviewReader(env.DB).savedAssignments(user.id) }, { headers: { "cache-control": "no-store" } });
    }
    const savedAssignmentMatch = /^\/api\/saved-assignments\/([^/]+)$/u.exec(url.pathname);
    if (savedAssignmentMatch && request.method === "DELETE") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      const deleted = await new D1ReviewWriter(env.DB).deleteSavedAssignment(user.id, decodeURIComponent(savedAssignmentMatch[1]));
      return deleted ? Response.json({ ok: true, data: { deleted: true } }) : apiError("NOT_FOUND", "常用题目不存在", 404);
    }
    const reviewMatch = /^\/api\/reviews\/([^/]+)$/u.exec(url.pathname);
    if (reviewMatch && request.method === "GET") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      const review = await new D1ReviewReader(env.DB).get(user.id, decodeURIComponent(reviewMatch[1]));
      return review ? Response.json({ ok: true, data: review }, { headers: { "cache-control": "no-store" } }) : apiError("REVIEW_NOT_FOUND", "批改记录不存在", 404);
    }
    if (reviewMatch && request.method === "PATCH") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      try {
        const reviewId = decodeURIComponent(reviewMatch[1]);
        const updated = await new D1ReviewWriter(env.DB).update(user.id, reviewId, await request.json());
        if (!updated) return apiError("REVIEW_NOT_FOUND", "批改记录不存在", 404);
        const review = await new D1ReviewReader(env.DB).get(user.id, reviewId);
        return Response.json({ ok: true, data: review }, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return apiError(error instanceof Error && error.name === "RevisionConflictError" ? "REVISION_CONFLICT" : "VALIDATION_ERROR", error instanceof Error && error.name === "RevisionConflictError" ? "批改记录已更新，请刷新后重试" : "请求参数无效", error instanceof Error && error.name === "RevisionConflictError" ? 409 : 400);
      }
    }
    if (reviewMatch && request.method === "DELETE") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      const reviewId = decodeURIComponent(reviewMatch[1]);
      const paths = await new D1ReviewWriter(env.DB).deleteReview(user.id, reviewId);
      if (!paths) return apiError("REVIEW_NOT_FOUND", "批改记录不存在", 404);
      const keys = paths.filter((path) => /^images\/[^/\\\0]+$/u.test(path)).map((path) => `users/${user.id}/reviews/${reviewId}/${path}`);
      if (keys.length > 0) await env.FILES.delete(keys);
      return Response.json({ ok: true, data: { deleted: true } });
    }
    const fileMatch = /^\/api\/reviews\/([^/]+)\/files$/u.exec(url.pathname);
    const imagesMatch = /^\/api\/reviews\/([^/]+)\/images$/u.exec(url.pathname);
    if (imagesMatch && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      try {
        const reviewId = decodeURIComponent(imagesMatch[1]);
        const form = await request.formData();
        const expectedRevision = Number(form.get("expectedRevision"));
        const files = form.getAll("images");
        const metadata = JSON.parse(String(form.get("imageMeta") ?? "[]")) as Array<{ width: number; height: number }>;
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || files.length !== metadata.length || files.length < 1 || files.length > 4) return apiError("VALIDATION_ERROR", "图片上传参数无效", 400);
        const prepared = await Promise.all(files.map(async (entry, position) => {
          if (!(entry instanceof File) || entry.size > 20 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(entry.type)) throw new Error("INVALID_IMAGE");
          const meta = metadata[position];
          if (!Number.isInteger(meta?.width) || !Number.isInteger(meta?.height) || meta.width < 1 || meta.height < 1) throw new Error("INVALID_IMAGE");
          const extension = entry.type === "image/png" ? "png" : entry.type === "image/webp" ? "webp" : "jpg";
          const path = `images/${crypto.randomUUID()}.${extension}`;
          return { originalName: entry.name.slice(0, 255), mimeType: entry.type as "image/jpeg" | "image/png" | "image/webp", width: meta.width, height: meta.height, path, data: await entry.arrayBuffer() };
        }));
        const keys = prepared.map((image) => `users/${user.id}/reviews/${reviewId}/${image.path}`);
        await Promise.all(prepared.map((image, index) => env.FILES.put(keys[index], image.data, { httpMetadata: { contentType: image.mimeType } })));
        try {
          const saved = await new D1ImageWriter(env.DB).replace(user.id, reviewId, expectedRevision, prepared, form.get("privacyConfirmed") === "true" && form.get("privacyNoticeVersion") === "2026-07-22");
          return Response.json({ ok: true, data: saved }, { headers: { "cache-control": "no-store" } });
        } catch (error) {
          await env.FILES.delete(keys);
          const code = error instanceof Error ? error.message : "VALIDATION_ERROR";
          return apiError(code, code === "PRIVACY_CONFIRMATION_REQUIRED" ? "请先确认真实作文上传说明" : "图片上传失败", code === "REVISION_CONFLICT" ? 409 : 400);
        }
      } catch {
        return apiError("INVALID_IMAGE", "仅支持 JPG、PNG、WebP，且单张不超过 20MB", 422);
      }
    }
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
    const analyzeMatch = /^\/api\/reviews\/([^/]+)\/analyze$/u.exec(url.pathname);
    if (analyzeMatch && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      try {
        const reviewId = decodeURIComponent(analyzeMatch[1]);
        const result = await new D1AnalysisJobs(env.DB).enqueue(user.id, reviewId, request.headers.get("content-type")?.includes("application/json") ? (await request.json() as { teacherGuidance?: unknown }).teacherGuidance : undefined);
        if (!result.job) return apiError("REVIEW_NOT_FOUND", "批改记录不存在", 404);
        if (result.newlyQueued) await env.ANALYSIS_QUEUE.send({ jobId: (result.job as { id: string }).id });
        return Response.json({ ok: true, data: result.job }, { status: 202, headers: { "cache-control": "no-store" } });
      } catch (error) {
        const code = error instanceof Error ? error.message : "VALIDATION_ERROR";
        return apiError(code, code === "IMAGES_REQUIRED" ? "请先上传 1 至 4 张作文图片" : "请求参数无效", code === "IMAGES_REQUIRED" ? 422 : 400);
      }
    }
    const analyzeStatusMatch = /^\/api\/reviews\/([^/]+)\/analyze\/status$/u.exec(url.pathname);
    if (analyzeStatusMatch && request.method === "GET") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      const job = await new D1AnalysisJobs(env.DB).latest(user.id, decodeURIComponent(analyzeStatusMatch[1]));
      return Response.json({ ok: true, data: { job } }, { headers: { "cache-control": "no-store" } });
    }
    const sampleRewriteMatch = /^\/api\/reviews\/([^/]+)\/sample-paragraphs\/(\d+)$/u.exec(url.pathname);
    const feedbackRewriteMatch = /^\/api\/reviews\/([^/]+)\/feedback\/(strengths|improvements)$/u.exec(url.pathname);
    const samplesRewriteMatch = /^\/api\/reviews\/([^/]+)\/sample-paragraphs\/regenerate$/u.exec(url.pathname);
    if (sampleRewriteMatch && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      try {
        const review = await new D1ReviewReader(env.DB).get(user.id, decodeURIComponent(sampleRewriteMatch[1])) as ReviewView | null;
        const index = Number(sampleRewriteMatch[2]);
        if (!review?.report) return apiError("IMAGES_REQUIRED", "请先完成作文分析", 422);
        const body = await request.json() as { instruction?: unknown };
        const instruction = typeof body.instruction === "string" && body.instruction.trim() ? body.instruction.trim().slice(0, 1000) : undefined;
        return Response.json({ ok: true, data: await new OpenAIReviewAdapter(workerAiSettings(env), { clientFactory: createWorkerOpenAIClient }).rewriteSample({ config: review.config, sampleParagraphs: review.report.sampleParagraphs, index, instruction }) });
      } catch { return apiError("AI_REQUEST_FAILED", "示范段落重写失败", 502); }
    }
    if (feedbackRewriteMatch && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      try {
        const review = await new D1ReviewReader(env.DB).get(user.id, decodeURIComponent(feedbackRewriteMatch[1])) as ReviewView | null;
        if (!review?.report) return apiError("IMAGES_REQUIRED", "请先完成作文分析", 422);
        return Response.json({ ok: true, data: await new OpenAIReviewAdapter(workerAiSettings(env), { clientFactory: createWorkerOpenAIClient }).rewriteFeedback({ config: review.config, report: review.report, section: feedbackRewriteMatch[2] as "strengths" | "improvements" }) });
      } catch { return apiError("AI_REQUEST_FAILED", "评语重新生成失败", 502); }
    }
    if (samplesRewriteMatch && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      try {
        const review = await new D1ReviewReader(env.DB).get(user.id, decodeURIComponent(samplesRewriteMatch[1])) as ReviewView | null;
        if (!review?.report) return apiError("IMAGES_REQUIRED", "请先完成作文分析", 422);
        const body = await request.json() as { instruction?: unknown };
        const instruction = typeof body.instruction === "string" && body.instruction.trim() ? body.instruction.trim().slice(0, 1000) : undefined;
        return Response.json({ ok: true, data: await new OpenAIReviewAdapter(workerAiSettings(env), { clientFactory: createWorkerOpenAIClient }).rewriteAllSamples({ config: review.config, sampleParagraphs: review.report.sampleParagraphs, instruction }) });
      } catch { return apiError("AI_REQUEST_FAILED", "整篇示范文重写失败", 502); }
    }
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ ok: false, error: { code: "NOT_FOUND", message: "接口不存在" } }, { status: 404 });
    }
    return secureResponse(await env.ASSETS.fetch(request));
  },
  async queue(batch: MessageBatch<{ jobId: string }>, env: WorkerEnv): Promise<void> {
    for (const message of batch.messages) {
      const job = await env.DB.prepare("SELECT analysis_jobs.id, analysis_jobs.review_id, analysis_jobs.owner_id, analysis_jobs.teacher_guidance, reviews.config FROM analysis_jobs INNER JOIN reviews ON reviews.id = analysis_jobs.review_id WHERE analysis_jobs.id = ? AND analysis_jobs.status = 'queued'").bind(message.body.jobId).first<{ id: string; review_id: string; owner_id: string; teacher_guidance: string | null; config: string }>();
      if (!job) { message.ack(); continue; }
      try {
        await env.DB.prepare("UPDATE analysis_jobs SET status = 'running', progress_stage = 'reading_images', started_at = ? WHERE id = ?").bind(Date.now(), job.id).run();
        const { results = [] } = await env.DB.prepare("SELECT id FROM review_images WHERE review_id = ? ORDER BY position").bind(job.review_id).all<{ id: number }>();
        const settings = await env.DB.prepare("SELECT base_url, model, encrypted_api_key FROM settings WHERE id = 1").first<{ base_url: string; model: string; encrypted_api_key: string | null }>();
        if (!settings) throw new Error("AI_SETTINGS_INCOMPLETE");
        const apiKey = await configuredApiKey(env, settings.encrypted_api_key);
        if (!apiKey) throw new Error("AI_SETTINGS_INCOMPLETE");
        const urls = await Promise.all(results.map(({ id }) => createAiImageUrl({ origin: env.APP_ORIGIN, secret: env.AI_FILE_URL_SECRET, reviewId: job.review_id, imageId: id, variant: "ai", expiresAt: Date.now() + 600000 })));
        const adapter = new OpenAIReviewAdapter(
          { getRuntimeConfig: async () => ({ baseUrl: settings.base_url, model: settings.model, apiKey }) },
          { clientFactory: createWorkerOpenAIClient },
        );
        const analysisInput = { config: JSON.parse(job.config), teacherGuidance: job.teacher_guidance ?? undefined };
        let result;
        try {
          result = await adapter.analyzeImageUrls({ ...analysisInput, imageUrls: urls });
        } catch (error) {
          if (!(error instanceof AiAdapterError) || error.upstreamStatus !== 403) throw error;
          // The configured model supports vision. Retry once without asking the
          // upstream gateway to fetch our signed private Workers URLs itself.
          const reader = new D1ReviewReader(env.DB);
          const images = await Promise.all(results.map(async ({ id }) => {
            const file = await reader.imageObjectKeyForAi(job.review_id, id, "ai");
            if (!file) throw new Error("AI_IMAGE_UNAVAILABLE");
            return { key: file.key, mimeType: file.contentType };
          }));
          const inlineImageUrls = await loadInlineAiImageUrls(env.FILES, images);
          result = await adapter.analyzeImageUrls({ ...analysisInput, imageUrls: inlineImageUrls });
        }
        const now = Date.now();
        await env.DB.batch([env.DB.prepare("UPDATE reviews SET report = ?, status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND owner_id = ?").bind(result.readable ? JSON.stringify(result.report) : null, result.readable ? "ready_for_review" : "needs_better_images", now, job.review_id, job.owner_id), env.DB.prepare("DELETE FROM annotations WHERE review_id = ?").bind(job.review_id), ...result.annotations.map((annotation, position) => env.DB.prepare("INSERT INTO annotations (review_id, position, page_index, x, y, category, anchor_text, comment, is_highlight) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(job.review_id, position, annotation.pageIndex, annotation.x, annotation.y, annotation.category, annotation.anchorText, annotation.comment, annotation.isHighlight ? 1 : 0)), env.DB.prepare("UPDATE analysis_jobs SET status = 'succeeded', progress_stage = 'saving_result', finished_at = ? WHERE id = ?").bind(now, job.id)]);
      } catch (error) {
        const code = error instanceof AiAdapterError && error.upstreamStatus
          ? `AI_UPSTREAM_HTTP_${error.upstreamStatus}${error.upstreamCode ? `_${error.upstreamCode}` : ""}`
          : error instanceof Error && error.message === "AI_SETTINGS_INCOMPLETE" ? error.message : "AI_REQUEST_FAILED";
        await env.DB.prepare("UPDATE analysis_jobs SET status = 'failed', error_code = ?, finished_at = ? WHERE id = ?").bind(code, Date.now(), job.id).run();
      }
      message.ack();
    }
  },
};
