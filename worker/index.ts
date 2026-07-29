import type { WorkerEnv } from "../src/cloudflare/env";
import { D1LoginChallengeRepository } from "../src/cloudflare/d1-login-challenge-repository";
import { D1PasswordProofRepository } from "../src/cloudflare/d1-password-proof-repository";
import { D1SessionRepository } from "../src/cloudflare/d1-session-repository";
import { D1ReviewReader } from "../src/cloudflare/d1-review-reader";
import { D1ReviewWriter } from "../src/cloudflare/d1-review-writer";
import { D1AnalysisJobs } from "../src/cloudflare/d1-analysis-jobs";
import { verifyAiImageUrl } from "../src/cloudflare/ai-image-url";
import { D1ImageWriter } from "../src/cloudflare/d1-image-writer";
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
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ ok: false, error: { code: "NOT_FOUND", message: "接口不存在" } }, { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
};
