import { composeReviewGuidance } from "../src/grading-opinions/review-guidance";
import { listD1EssayOpinions, listD1StandingOpinions } from "../src/cloudflare/d1-grading-opinions";
import type { WorkerEnv } from "../src/cloudflare/env";
import { D1LoginAttemptRepository } from "../src/cloudflare/d1-login-attempts";
import { D1LoginChallengeRepository } from "../src/cloudflare/d1-login-challenge-repository";
import { D1PasswordProofRepository } from "../src/cloudflare/d1-password-proof-repository";
import { D1SessionRepository } from "../src/cloudflare/d1-session-repository";
import { D1ReviewReader } from "../src/cloudflare/d1-review-reader";
import { D1ReviewWriter } from "../src/cloudflare/d1-review-writer";
import { extractReportSummaryFields } from "../src/cloudflare/review-summary-state";
import { D1AnalysisJobs, MAX_CLOUD_ANALYSIS_RUN_MS } from "../src/cloudflare/d1-analysis-jobs";
import { runCloudMaintenance } from "../src/cloudflare/d1-maintenance";
import {
  D1Reanalysis,
  D1ReanalysisBatchError,
  D1ReanalysisError,
} from "../src/cloudflare/d1-reanalysis";
import { D1GradingOpinions } from "../src/cloudflare/d1-grading-opinions";
import { D1RuleCandidates } from "../src/cloudflare/d1-rule-candidates";
import type { RuleSourceOpinion } from "../src/grading-opinions/rule-candidates";
import { opinionSourceTitle } from "../src/grading-opinions/grading-opinion-repository";
import { OPINION_CATEGORIES } from "../src/grading-opinions/standing-guidance";
import { verifyAiImageUrl } from "../src/cloudflare/ai-image-url";
import { analysisFailureCode } from "../src/cloudflare/analysis-failure";
import { ANALYSIS_JOB_METADATA_PREFIX } from "../src/jobs/analysis-job-metadata";
import { sanitizeAnalysisDetail } from "../src/jobs/public-analysis-failure";
import { loadInlineAiImageUrls } from "../src/cloudflare/ai-inline-image";
import { aiRequestHeaders } from "../src/cloudflare/ai-request-headers";
import { createWorkerOpenAIClient } from "../src/cloudflare/worker-openai-client";
import { D1ImageWriter } from "../src/cloudflare/d1-image-writer";
import { D1SecurityEvents } from "../src/cloudflare/d1-admin-accounts";
import { handleWorkerAdmin } from "../src/cloudflare/worker-admin-routes";
import { authenticatedWorkerUser, handleWorkerAuth } from "../src/cloudflare/worker-auth-routes";
import { AiAdapterError, OpenAIReviewAdapter } from "../src/ai/openai-review-adapter";
import { VisionOcrAdapter } from "../src/ai/vision-ocr-adapter";
import { CompositionReviewAdapter } from "../src/ai/composition-review-adapter";
import { AssignmentGuidanceAdapter } from "../src/ai/assignment-guidance-adapter";
import {
  assignmentConfigSchema,
  isLegacyEvaluationReport,
  isParagraphEvaluationReport,
  paragraphReviewSchema,
} from "../src/domain/contracts";
import { validateParagraphReportForIds } from "../src/domain/report-validation";
import { D1OcrCheckpointRepository, OcrCheckpointError } from "../src/cloudflare/d1-ocr-checkpoint";
import { createWorkerAiSettingsSource } from "../src/cloudflare/ai-settings";
import {
  CloudAnalysisConflictError,
  CloudAnalysisPipeline,
  type CloudAnalysisPipelineJob,
} from "../src/cloudflare/cloud-analysis-pipeline";
import { openSetting, sealSetting } from "../src/cloudflare/settings-secret";
import type { ReviewView } from "../app/lib/types";
import {
  batchReanalysisCommitInputSchema,
  batchReanalysisPreviewInputSchema,
  MAX_REVISION_FIELD_CHARS,
  REANALYSIS_SKIP_REASONS,
  rejectReviewInputSchema,
  revisionRequestInputSchema,
  type ReanalysisSkipCode,
} from "../src/reanalysis/contracts";
import { z, ZodError } from "zod";

const editOcrParagraphsSchema = z.object({
  expectedOcrRevision: z.number().int().nonnegative(),
  paragraphs: z.array(z.object({
    paragraphId: z.string().regex(/^paragraph-[1-9]\d*$/u),
    text: z.string().trim().min(1),
  }).strict()).min(1),
}).strict();

const gradingOpinionUpdateSchema = z.object({
  text: z.string().trim().min(1).max(MAX_REVISION_FIELD_CHARS),
  category: z.enum(OPINION_CATEGORIES).optional(),
}).strict();

const paragraphRewriteSchema = z.object({
  paragraphReviews: z.array(paragraphReviewSchema).min(1),
  instruction: z.string().trim().max(1_000).optional(),
  teacherGuidance: z.string().trim().max(4_000).optional(),
}).strict();

function apiError(code: string, message: string, status: number, details?: unknown): Response {
  return Response.json({
    ok: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
  }, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}

const reanalysisRouteIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const reanalysisBusinessCodes = new Set<ReanalysisSkipCode>([
  "REVIEW_NOT_FOUND",
  "REVISION_CONFLICT",
  "OCR_NOT_CURRENT",
  "IMAGES_MISSING",
  "ANALYSIS_ACTIVE",
  "REVIEW_UNAVAILABLE",
]);

function reanalysisCode(error: unknown): ReanalysisSkipCode | null {
  const candidate = error instanceof D1ReanalysisError
    ? error.code
    : typeof error === "object" && error !== null && "code" in error
      && reanalysisBusinessCodes.has(String(error.code) as ReanalysisSkipCode)
      ? String(error.code) as ReanalysisSkipCode
      : error instanceof Error && reanalysisBusinessCodes.has(error.message as ReanalysisSkipCode)
        ? error.message as ReanalysisSkipCode
        : null;
  return candidate && reanalysisBusinessCodes.has(candidate) ? candidate : null;
}

function reanalysisFailure(error: unknown): Response {
  const code = reanalysisCode(error);
  if (!code) return apiError("INTERNAL_ERROR", "服务暂时不可用，请稍后重试", 500);
  return apiError(
    code,
    code === "REVIEW_NOT_FOUND" ? "批改记录不存在" : REANALYSIS_SKIP_REASONS[code],
    code === "REVIEW_NOT_FOUND" ? 404 : 409,
  );
}

function queueDispatchFailure(): Response {
  return apiError("QUEUE_DISPATCH_FAILED", "任务提交失败，请稍后重试", 503);
}

async function compensateQueueDispatch(
  reanalysis: D1Reanalysis,
  ownerId: string,
  jobIds: string[],
): Promise<Response> {
  try {
    await reanalysis.markDispatchFailed(ownerId, jobIds);
    return queueDispatchFailure();
  } catch {
    return apiError("INTERNAL_ERROR", "服务暂时不可用，请稍后重试", 500);
  }
}

async function failBatchCommit(
  reanalysis: D1Reanalysis,
  ownerId: string,
  error: D1ReanalysisBatchError,
): Promise<Response> {
  if (error.jobIds.length > 0) {
    try {
      await reanalysis.markDispatchFailed(ownerId, error.jobIds);
    } catch {
      // The response remains deliberately generic whether compensation succeeds or fails.
    }
  }
  return apiError("INTERNAL_ERROR", "服务暂时不可用，请稍后重试", 500);
}

type ValidationIssue = {
  path?: PropertyKey[];
  errors?: ValidationIssue[][];
};

function validationErrorDetails(error: unknown): { path: PropertyKey[] } | undefined {
  if (!(error instanceof ZodError)) return undefined;

  function leafPath(issue: ValidationIssue, prefix: PropertyKey[] = []): PropertyKey[] {
    const path = [...prefix, ...(issue.path ?? [])];
    if (!issue.errors?.length) return path;
    const closestBranch = [...issue.errors].sort((left, right) => left.length - right.length)[0];
    return closestBranch?.[0] ? leafPath(closestBranch[0], path) : path;
  }

  const path = error.issues[0] ? leafPath(error.issues[0] as ValidationIssue) : [];
  return { path };
}

function secureResponse(response: Response, pathname: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("x-robots-tag", "noindex, nofollow");
  const normalizedPath = pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
  const legacyWasmFallback = ["/login", "/change-password", "/settings/accounts"].includes(normalizedPath)
    && (response.status === 304 || (response.status === 200 && headers.get("content-type")?.toLowerCase().includes("text/html")));
  headers.set("content-security-policy", `default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; object-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${legacyWasmFallback ? " 'unsafe-eval'" : ""}; connect-src 'self'`);
  if ([200, 304].includes(response.status) && pathname.startsWith("/_next/static/")) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function isBlockedSettingsHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (
    lower === "localhost"
    || lower === "0.0.0.0"
    || lower === "::1"
    || lower.endsWith(".localhost")
    || lower.endsWith(".local")
    || lower.endsWith(".internal")
    || /^fe[89ab][0-9a-f]:/iu.test(lower)
    || /^f[cd][0-9a-f]{2}:/iu.test(lower)
  ) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(lower);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((part) => part > 255)) return true;
  const [a, b] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function sameSettingsOrigin(left?: string | null, right?: string | null): boolean {
  if (!left || !right) return false;
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function normalizeSettingsCandidate(
  value: { baseUrl?: unknown; model?: unknown; apiKey?: unknown },
  appOrigin?: string,
): { baseUrl: string; model: string; apiKey?: string } {
  if (typeof value.baseUrl !== "string" || typeof value.model !== "string" || !value.model.trim()) {
    throw new Error("INVALID_SETTINGS");
  }
  const trimmedUrl = value.baseUrl.trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmedUrl);
  } catch {
    throw new Error("INVALID_SETTINGS");
  }
  if ((parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    throw new Error("INVALID_SETTINGS");
  }
  const prodHttps = appOrigin?.startsWith("https://") ?? false;
  if (prodHttps && (parsedUrl.protocol !== "https:" || isBlockedSettingsHost(parsedUrl.hostname))) {
    throw new Error("INVALID_SETTINGS");
  }
  if (value.apiKey !== undefined && (typeof value.apiKey !== "string" || !value.apiKey.trim())) throw new Error("INVALID_SETTINGS");
  return { baseUrl: trimmedUrl.replace(/\/+$/u, ""), model: value.model.trim(), ...(typeof value.apiKey === "string" ? { apiKey: value.apiKey.trim() } : {}) };
}

async function configuredApiKey(env: WorkerEnv, encryptedApiKey: string | null, role: "vision" | "content" = "content"): Promise<string | null> {
  if (encryptedApiKey) return openSetting(encryptedApiKey, env.AUTH_PROOF_ENCRYPTION_KEY);
  return (role === "vision" ? env.VISION_AI_API_KEY : env.CONTENT_AI_API_KEY) || env.AI_API_KEY || null;
}

const AI_CONNECTION_TEST_TIMEOUT_MS = 30_000;

async function testAiConnection(input: { baseUrl: string; model: string; apiKey: string; role: "vision" | "content" }): Promise<void> {
  // A 1×1 PNG verifies that the configured model accepts the same multimodal
  // request shape used by essay analysis, rather than only proving text chat.
  const visionProbe = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const hostname = new URL(input.baseUrl).hostname;
  const isMiMo = hostname === "api.xiaomimimo.com";
  const isDeepSeek = hostname === "api.deepseek.com";
  const response = await fetch(`${input.baseUrl}/chat/completions`, {
    method: "POST",
    headers: aiRequestHeaders(input.baseUrl, input.apiKey),
    body: JSON.stringify({
      model: input.model,
      messages: input.role === "vision" ? [{ role: "user", content: [
          { type: "image_url", image_url: { url: visionProbe } },
          { type: "text", text: "请确认你能读取图片，只回复 OK" },
        ] }] : [{ role: "user", content: "请只回复 OK" }],
      ...(isDeepSeek ? { thinking: { type: "disabled" } } : {}),
      ...(isMiMo ? { max_completion_tokens: 256 } : { max_tokens: 16 }),
    }),
    signal: AbortSignal.timeout(AI_CONNECTION_TEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("AI_CONNECTION_FAILED");
  const payload = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  if (typeof payload.choices?.[0]?.message?.content !== "string" || !payload.choices[0].message.content.trim()) throw new Error("AI_CONNECTION_FAILED");
}

function workerAiSettings(env: WorkerEnv) {
  return createWorkerAiSettingsSource(env);
}

/** 把老师刚提交的原话存为候选长期规则；失败只记日志，不影响主流程。 */
async function ingestRuleCandidates(
  env: WorkerEnv,
  ownerId: string,
  reviewId: string,
  opinions: RuleSourceOpinion[],
): Promise<void> {
  if (opinions.length === 0) return;
  try {
    const row = await env.DB.prepare("SELECT config, student_name FROM reviews WHERE id = ? AND owner_id = ?")
      .bind(reviewId, ownerId).first<{ config: string; student_name: string | null }>();
    if (!row) return;
    const title = opinionSourceTitle(JSON.parse(row.config) as unknown);
    const withStudent = opinions.map((item) => ({ ...item, reviewId, studentName: row.student_name ?? "" }));
    await new D1RuleCandidates(env.DB).ingest(ownerId, title, withStudent);
  } catch (error) {
    console.error(JSON.stringify({ event: "rule_candidate_ingest_failed", reviewId, error: error instanceof Error ? error.message : String(error) }));
  }
}

function runInBackground(ctx: ExecutionContext | undefined, task: Promise<void>): Promise<void> {
  if (ctx) {
    ctx.waitUntil(task);
    return Promise.resolve();
  }
  return task;
}

function secureApiResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "no-store");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function isCrossSiteMutation(request: Request, url: URL): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return false;
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) return true;
  return request.headers.get("sec-fetch-site") === "cross-site";
}

function matchesIfNoneMatch(header: string | null, etag: string): boolean {
  if (!header) return false;
  const normalizedTarget = etag.replace(/^W\//u, "");
  return header.split(",").some((part) => {
    const candidate = part.trim();
    if (candidate === "*") return true;
    return candidate.replace(/^W\//u, "") === normalizedTarget;
  });
}

async function handleFetch(request: Request, env: WorkerEnv, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/_next/static/")) {
      return secureResponse(await env.ASSETS.fetch(request), url.pathname);
    }
    const scheduleBackground = ctx ? (task: Promise<unknown>) => { ctx.waitUntil(task); } : undefined;
    const sessions = new D1SessionRepository(env.DB, scheduleBackground);
    const authResponse = await handleWorkerAuth(request, {
      appOrigin: url.origin,
      ipHmacSecret: env.AUTH_IP_HMAC_SECRET,
      proofs: new D1PasswordProofRepository(env.DB),
      challenges: new D1LoginChallengeRepository(env.DB),
      sessions,
      attempts: new D1LoginAttemptRepository(env.DB),
      securityEvents: new D1SecurityEvents(env.DB),
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
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/") {
      return secureResponse(await env.ASSETS.fetch(request), url.pathname);
    }
    if (url.pathname.startsWith("/api/") && isCrossSiteMutation(request, url)) {
      return apiError("UNTRUSTED_ORIGIN", "请求来源不受信任", 403);
    }
    const user = await authenticatedWorkerUser(request, sessions);
    if (request.method === "GET" && url.pathname === "/" && request.headers.get("accept")?.includes("text/html")) {
      if (!user) {
        return new Response(null, {
          status: 302,
          headers: { "cache-control": "no-store", location: new URL("/login", url).toString() },
        });
      }
      if (user.mustChangePassword) {
        return new Response(null, {
          status: 302,
          headers: { "cache-control": "no-store", location: new URL("/change-password", url).toString() },
        });
      }
    }
    if (url.pathname.startsWith("/api/") && user?.mustChangePassword) {
      return apiError("PASSWORD_CHANGE_REQUIRED", "请先修改初始密码", 403);
    }
    const adminResponse = await handleWorkerAdmin(request, {
      user,
      database: env.DB,
      proofEncryptionKey: env.AUTH_PROOF_ENCRYPTION_KEY,
    });
    if (adminResponse) return adminResponse;
    const settingsEndpoint = url.pathname === "/api/settings"
      || /^\/api\/settings\/(?:vision|content)(?:\/test)?$/u.test(url.pathname);
    if (settingsEndpoint && user && user.role !== "admin") {
      return apiError("FORBIDDEN", "Administrator access required", 403);
    }
    if (url.pathname === "/api/settings" && request.method === "GET") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      const { results = [] } = await env.DB.prepare(
        "SELECT role, base_url, model, encrypted_api_key FROM settings WHERE role IN ('vision', 'content')",
      ).all<{ role: "vision" | "content"; base_url: string; model: string; encrypted_api_key: string | null }>();
      const data = Object.fromEntries(results.map((setting) => [setting.role, {
        baseUrl: setting.base_url,
        model: setting.model,
        keyConfigured: setting.encrypted_api_key !== null || Boolean(
          setting.role === "vision" ? env.VISION_AI_API_KEY || env.AI_API_KEY : env.CONTENT_AI_API_KEY || env.AI_API_KEY,
        ),
      }]));
      return Response.json({ ok: true, data });
    }
    const settingMatch = /^\/api\/settings\/(vision|content)$/u.exec(url.pathname);
    if (settingMatch && request.method === "PUT") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      try {
        const role = settingMatch[1] as "vision" | "content";
        const candidate = normalizeSettingsCandidate(await request.json() as { baseUrl?: unknown; model?: unknown; apiKey?: unknown }, url.origin);
        const encrypted = candidate.apiKey ? await sealSetting(candidate.apiKey, env.AUTH_PROOF_ENCRYPTION_KEY) : null;
        const previous = await env.DB.prepare("SELECT base_url, encrypted_api_key FROM settings WHERE role = ?").bind(role).first<{ base_url?: string | null; encrypted_api_key: string | null }>();
        const originChanged = Boolean(previous?.base_url) && !sameSettingsOrigin(previous?.base_url, candidate.baseUrl);
        const keepPreviousKey = encrypted === null && !originChanged;
        await env.DB.prepare("INSERT INTO settings (role, base_url, model, updated_at, encrypted_api_key) VALUES (?, ?, ?, ?, ?) ON CONFLICT(role) DO UPDATE SET base_url = excluded.base_url, model = excluded.model, updated_at = excluded.updated_at, encrypted_api_key = CASE WHEN ? THEN settings.encrypted_api_key ELSE excluded.encrypted_api_key END")
          .bind(role, candidate.baseUrl, candidate.model, Date.now(), encrypted, keepPreviousKey ? 1 : 0).run();
        const envKey = role === "vision" ? env.VISION_AI_API_KEY : env.CONTENT_AI_API_KEY;
        const retainedStoredKey = keepPreviousKey && previous?.encrypted_api_key !== null && previous?.encrypted_api_key !== undefined;
        return Response.json({ ok: true, data: { baseUrl: candidate.baseUrl, model: candidate.model, keyConfigured: encrypted !== null || retainedStoredKey || Boolean(!originChanged && (envKey || env.AI_API_KEY)) } });
      } catch { return apiError("VALIDATION_ERROR", "请求参数无效", 400); }
    }
    const settingTestMatch = /^\/api\/settings\/(vision|content)\/test$/u.exec(url.pathname);
    if (settingTestMatch && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      let candidate: { baseUrl: string; model: string; apiKey?: string };
      const role = settingTestMatch[1] as "vision" | "content";
      try {
        candidate = normalizeSettingsCandidate(await request.json() as { baseUrl?: unknown; model?: unknown; apiKey?: unknown }, url.origin);
      } catch {
        return apiError("VALIDATION_ERROR", "请求参数无效", 400);
      }
      try {
        const stored = await env.DB.prepare("SELECT base_url, encrypted_api_key FROM settings WHERE role = ?").bind(role).first<{ base_url?: string | null; encrypted_api_key: string | null }>();
        if (!candidate.apiKey && stored?.base_url && !sameSettingsOrigin(stored.base_url, candidate.baseUrl)) {
          return apiError("AI_SETTINGS_INCOMPLETE", "更换服务地址时请重新填写 API Key", 400);
        }
        const apiKey = candidate.apiKey ?? await configuredApiKey(env, stored?.encrypted_api_key ?? null, role);
        if (!apiKey) return apiError("AI_SETTINGS_INCOMPLETE", "请先填写 API Key", 400);
        await testAiConnection({ ...candidate, apiKey, role });
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
      } catch (error) {
        if (error instanceof ZodError || error instanceof SyntaxError) return apiError("VALIDATION_ERROR", "请检查题目、年级、字数和课本图片（最多 4 张 JPG、PNG 或 WebP）", 400);
        if (error instanceof AiAdapterError) return apiError(error.code, error.message, error.status);
        return apiError("AI_REQUEST_FAILED", "AI 服务请求失败，请检查设置后重试", 502);
      }
    }
    if (url.pathname === "/api/classes" && request.method === "GET") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      return Response.json({ ok: true, data: await new D1ReviewReader(env.DB).classes(user.id) }, { headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/api/rule-candidates" && request.method === "GET") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      const candidates = new D1RuleCandidates(env.DB);
      const data = url.searchParams.get("count") === "1"
        ? { pending: await candidates.countPending(user.id) }
        : await candidates.listPending(user.id);
      return Response.json({ ok: true, data }, { headers: { "cache-control": "no-store" } });
    }
    const ruleCandidateMatch = /^\/api\/rule-candidates\/([^/]+)\/(approve|reject)$/u.exec(url.pathname);
    if (ruleCandidateMatch && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      const candidateId = decodeURIComponent(ruleCandidateMatch[1]!);
      if (!reanalysisRouteIdPattern.test(candidateId)) return apiError("VALIDATION_ERROR", "请求参数无效", 400);
      const candidates = new D1RuleCandidates(env.DB);
      const done = ruleCandidateMatch[2] === "approve"
        ? await candidates.approve(user.id, candidateId)
        : await candidates.reject(user.id, candidateId);
      return done
        ? Response.json({ ok: true, data: { id: candidateId, status: ruleCandidateMatch[2] === "approve" ? "approved" : "rejected" } }, { headers: { "cache-control": "no-store" } })
        : apiError("NOT_FOUND", "候选规则不存在或已处理", 404);
    }
    if (url.pathname === "/api/grading-opinions" && request.method === "GET") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      const data = await new D1GradingOpinions(env.DB).list(user.id);
      return Response.json({ ok: true, data }, { headers: { "cache-control": "no-store" } });
    }
    const gradingOpinionMatch = /^\/api\/grading-opinions\/([^/]+)$/u.exec(url.pathname);
    if (gradingOpinionMatch && (request.method === "PATCH" || request.method === "DELETE")) {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      const opinionId = decodeURIComponent(gradingOpinionMatch[1]);
      if (!reanalysisRouteIdPattern.test(opinionId)) {
        return apiError("VALIDATION_ERROR", "请求参数无效", 400);
      }
      const opinions = new D1GradingOpinions(env.DB);
      if (request.method === "DELETE") {
        const deleted = await opinions.delete(user.id, opinionId);
        return deleted
          ? Response.json({ ok: true, data: { deleted: true } }, { headers: { "cache-control": "no-store" } })
          : apiError("NOT_FOUND", "批改意见不存在", 404);
      }
      try {
        const input = gradingOpinionUpdateSchema.parse(await request.json());
        const updated = await opinions.update(user.id, opinionId, input);
        return updated
          ? Response.json({ ok: true, data: updated }, { headers: { "cache-control": "no-store" } })
          : apiError("NOT_FOUND", "批改意见不存在", 404);
      } catch (error) {
        if (error instanceof ZodError || error instanceof SyntaxError || error instanceof TypeError) {
          return apiError("VALIDATION_ERROR", "请求参数无效", 400);
        }
        throw error;
      }
    }
    if (url.pathname === "/api/reviews" && request.method === "GET") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      const rawIds = url.searchParams.get("ids");
      if (rawIds !== null) {
        const ids = [...new Set(rawIds.split(",").map((id) => id.trim()).filter(Boolean))];
        if (ids.length === 0 || ids.length > 50 || ids.some((id) => !reanalysisRouteIdPattern.test(id))) {
          return apiError("VALIDATION_ERROR", "请求参数无效", 400);
        }
        if (url.searchParams.get("summary") === "1") {
          return Response.json(
            { ok: true, data: await new D1ReviewReader(env.DB).summaryByIds(user.id, ids) },
            { headers: { "cache-control": "no-store" } },
          );
        }
        return Response.json(
          { ok: true, data: await new D1ReviewReader(env.DB).list(user.id, { ids }) },
          { headers: { "cache-control": "no-store" } },
        );
      }
      const scope = url.searchParams.get("scope");
      if (scope !== null) {
        if (scope !== "pending-export") {
          return apiError("VALIDATION_ERROR", "请求参数无效", 400);
        }
        if (url.searchParams.get("summary") === "1") {
          return Response.json(
            { ok: true, data: await new D1ReviewReader(env.DB).pendingExportSummaries(user.id) },
            { headers: { "cache-control": "no-store" } },
          );
        }
        return Response.json(
          { ok: true, data: await new D1ReviewReader(env.DB).list(user.id, { scope: "pending_export" }) },
          { headers: { "cache-control": "no-store" } },
        );
      }
      if (url.searchParams.get("summary") === "1") {
        const rawPage = url.searchParams.get("page") ?? "1";
        const rawPageSize = url.searchParams.get("pageSize") ?? "20";
        const page = Number(rawPage);
        const pageSize = Number(rawPageSize);
        const statusParam = url.searchParams.get("status") ?? "";
        const validStatuses = new Set(["", "draft", "review", "failed", "reviewed", "exported", "rejected"]);
        const studentSearch = url.searchParams.get("q") ?? "";
        const classFilter = url.searchParams.has("class") ? url.searchParams.get("class") : null;
        if (
          !Number.isInteger(page) || page < 1
          || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100
          || !validStatuses.has(statusParam)
          || studentSearch.length > 100
          || (classFilter !== null && classFilter.length > 100)
        ) {
          return apiError("VALIDATION_ERROR", "请求参数无效", 400);
        }
        const data = await new D1ReviewReader(env.DB).summaryPage(user.id, {
          page,
          pageSize,
          classFilter,
          statusFilter: statusParam as "" | "draft" | "review" | "failed" | "reviewed" | "exported" | "rejected",
          studentSearch,
        });
        return Response.json({ ok: true, data }, { headers: { "cache-control": "no-store" } });
      }
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
    if (url.pathname === "/api/reviews/review-queue" && request.method === "GET") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      return Response.json(
        { ok: true, data: await new D1ReviewReader(env.DB).queue(user.id) },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (url.pathname === "/api/reviews/export-check" && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      try {
        const exportEntrySchema = z.object({
          id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u),
          revision: z.number().int().nonnegative(),
        }).strict();
        const input = z.object({
          reviews: z.array(exportEntrySchema).min(1).max(20),
        }).strict().superRefine(({ reviews }, context) => {
          if (new Set(reviews.map(({ id }) => id)).size !== reviews.length) {
            context.addIssue({ code: "custom", path: ["reviews"], message: "duplicate review id" });
          }
        }).parse(await request.json());
        const exportable = await new D1ReviewReader(env.DB).checkExportable(user.id, input.reviews);
        return exportable
          ? Response.json({ ok: true, data: { exportable: true } }, { headers: { "cache-control": "no-store" } })
          : apiError("EXPORT_NOT_AVAILABLE", "仅已审核且未变更的作文可以导出", 422);
      } catch (error) {
        return apiError("VALIDATION_ERROR", "请求参数无效", 400, validationErrorDetails(error));
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
    const reviewExportMatch = /^\/api\/reviews\/([^/]+)\/exported$/u.exec(url.pathname);
    if (reviewExportMatch && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      const reviewId = decodeURIComponent(reviewExportMatch[1]);
      const exported = await new D1ReviewWriter(env.DB).markExported(user.id, reviewId);
      if (!exported) return apiError("EXPORT_NOT_AVAILABLE", "仅已完成且未变更的批改记录可以标记为已导出", 422);
      return Response.json({ ok: true, data: { id: reviewId, status: "exported" } }, { headers: { "cache-control": "no-store" } });
    }
    const teacherReviewMatch = /^\/api\/reviews\/([^/]+)\/teacher-review$/u.exec(url.pathname);
    if (teacherReviewMatch && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      try {
        const reviewId = decodeURIComponent(teacherReviewMatch[1]);
        const updated = await new D1ReviewWriter(env.DB).completeTeacherReview(user.id, reviewId, await request.json());
        if (!updated) return apiError("REVIEW_NOT_FOUND", "批改记录不存在", 404);
        const review = await new D1ReviewReader(env.DB).get(user.id, reviewId);
        return review
          ? Response.json({ ok: true, data: review }, { headers: { "cache-control": "no-store" } })
          : apiError("REVIEW_NOT_FOUND", "批改记录不存在", 404);
      } catch (error) {
        const revisionConflict = error instanceof Error && error.name === "RevisionConflictError";
        const rejected = error instanceof Error && error.name === "ReviewRejectedError";
        return apiError(
          rejected ? "REVIEW_REJECTED" : revisionConflict ? "REVISION_CONFLICT" : "VALIDATION_ERROR",
          rejected ? error.message : revisionConflict ? "批改记录已更新，请刷新后重试" : "请求参数无效",
          rejected || revisionConflict ? 409 : 400,
          rejected || revisionConflict ? undefined : validationErrorDetails(error),
        );
      }
    }
    const rejectReviewMatch = /^\/api\/reviews\/([^/]+)\/reject$/u.exec(url.pathname);
    if (rejectReviewMatch && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      let reviewId: string;
      let input: ReturnType<typeof rejectReviewInputSchema.parse>;
      try {
        reviewId = decodeURIComponent(rejectReviewMatch[1]);
        if (!reanalysisRouteIdPattern.test(reviewId)) throw new Error("INVALID_REANALYSIS_ID");
        input = rejectReviewInputSchema.parse(await request.json());
      } catch (error) {
        return apiError("VALIDATION_ERROR", "请求参数无效", 400, validationErrorDetails(error));
      }
      try {
        const rejected = await new D1Reanalysis(env.DB).rejectReview(user.id, reviewId, input);
        const opinions: RuleSourceOpinion[] = input.reason.trim()
          ? [{ text: input.reason, kind: "rejection" }]
          : [];
        await runInBackground(ctx, ingestRuleCandidates(env, user.id, reviewId, opinions));
        return Response.json({ ok: true, data: rejected }, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return reanalysisFailure(error);
      }
    }
    const revisionRequestMatch = /^\/api\/reviews\/([^/]+)\/revision-request$/u.exec(url.pathname);
    if (revisionRequestMatch && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      let reviewId: string;
      let input: unknown;
      try {
        reviewId = decodeURIComponent(revisionRequestMatch[1]);
        if (!reanalysisRouteIdPattern.test(reviewId)) throw new Error("INVALID_REANALYSIS_ID");
        input = revisionRequestInputSchema.parse(await request.json());
      } catch (error) {
        return apiError("VALIDATION_ERROR", "请求参数无效", 400, validationErrorDetails(error));
      }
      const reanalysis = new D1Reanalysis(env.DB);
      let result: Awaited<ReturnType<D1Reanalysis["requestRevision"]>>;
      try {
        result = await reanalysis.requestRevision(user.id, reviewId!, input as Parameters<D1Reanalysis["requestRevision"]>[2]);
      } catch (error) {
        return reanalysisFailure(error);
      }
      try {
        await env.ANALYSIS_QUEUE.send({ jobId: result.job.id });
      } catch {
        return compensateQueueDispatch(reanalysis, user.id, [result.job.id]);
      }
      {
        const revision = input as { commonIssue: string };
        const opinions: RuleSourceOpinion[] = revision.commonIssue.trim()
          ? [{ text: revision.commonIssue, kind: "revision" }]
          : [];
        await runInBackground(ctx, ingestRuleCandidates(env, user.id, reviewId!, opinions));
      }
      return Response.json({ ok: true, data: result }, {
        status: 202,
        headers: { "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/api/reviews/batch-reanalysis/preview" && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      let reviewIds: string[];
      try {
        reviewIds = batchReanalysisPreviewInputSchema.parse(await request.json()).reviewIds;
      } catch (error) {
        return apiError("VALIDATION_ERROR", "请求参数无效", 400, validationErrorDetails(error));
      }
      try {
        const data = await new D1Reanalysis(env.DB).preview(user.id, reviewIds);
        return Response.json({ ok: true, data }, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        return reanalysisFailure(error);
      }
    }
    if (url.pathname === "/api/reviews/batch-reanalysis" && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      let items: Parameters<D1Reanalysis["commitBatch"]>[1];
      let applyCurrentFramework = false;
      try {
        ({ items, applyCurrentFramework } = batchReanalysisCommitInputSchema.parse(await request.json()));
      } catch (error) {
        return apiError("VALIDATION_ERROR", "请求参数无效", 400, validationErrorDetails(error));
      }
      const reanalysis = new D1Reanalysis(env.DB);
      let data: Awaited<ReturnType<D1Reanalysis["commitBatch"]>>;
      try {
        data = await reanalysis.commitBatch(user.id, items, { applyCurrentFramework });
      } catch (error) {
        if (error instanceof D1ReanalysisBatchError) {
          return failBatchCommit(reanalysis, user.id, error);
        }
        return reanalysisFailure(error);
      }
      if (data.submitted.length > 0) {
        try {
          await env.ANALYSIS_QUEUE.sendBatch(data.submitted.map(({ jobId }) => ({ body: { jobId } })));
        } catch {
          return compensateQueueDispatch(reanalysis, user.id, data.submitted.map(({ jobId }) => jobId));
        }
      }
      return Response.json({ ok: true, data }, { headers: { "cache-control": "no-store" } });
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
        const revisionConflict = error instanceof Error && error.name === "RevisionConflictError";
        return apiError(
          revisionConflict ? "REVISION_CONFLICT" : "VALIDATION_ERROR",
          revisionConflict ? "批改记录已更新，请刷新后重试" : "请求参数无效",
          revisionConflict ? 409 : 400,
          revisionConflict ? undefined : validationErrorDetails(error),
        );
      }
    }
    if (reviewMatch && request.method === "DELETE") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      const reviewId = decodeURIComponent(reviewMatch[1]);
      const paths = await new D1ReviewWriter(env.DB).deleteReview(user.id, reviewId);
      if (!paths) return apiError("REVIEW_NOT_FOUND", "批改记录不存在", 404);
      const keys = [...new Set(paths.filter((path) => /^images\/[^/\\\0]+$/u.test(path)).map((path) => `users/${user.id}/reviews/${reviewId}/${path}`))];
      if (keys.length > 0) await env.FILES.delete(keys);
      return Response.json({ ok: true, data: { deleted: true } });
    }
    const fileMatch = /^\/api\/reviews\/([^/]+)\/files$/u.exec(url.pathname);
    const imagesMatch = /^\/api\/reviews\/([^/]+)\/images$/u.exec(url.pathname);
    if (imagesMatch && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      try {
        const reviewId = decodeURIComponent(imagesMatch[1]);
        if (!reanalysisRouteIdPattern.test(reviewId)) return apiError("VALIDATION_ERROR", "图片上传参数无效", 400);
        const form = await request.formData();
        const expectedRevision = Number(form.get("expectedRevision"));
        const files = form.getAll("images");
        const metadata = JSON.parse(String(form.get("imageMeta") ?? "[]")) as Array<{ width: number; height: number }>;
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || files.length !== metadata.length || files.length < 1 || files.length > 4) return apiError("VALIDATION_ERROR", "图片上传参数无效", 400);
        const privacyConfirmed = form.get("privacyConfirmed") === "true" && form.get("privacyNoticeVersion") === "2026-07-22";
        if (!privacyConfirmed) return apiError("PRIVACY_CONFIRMATION_REQUIRED", "请先确认真实作文上传说明", 400);
        let totalUploadBytes = 0;
        for (let position = 0; position < files.length; position += 1) {
          const entry = files[position];
          const meta = metadata[position];
          if (!(entry instanceof File) || entry.size < 1 || entry.size > 20 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(entry.type)) {
            throw new Error("INVALID_IMAGE");
          }
          if (!Number.isInteger(meta?.width) || !Number.isInteger(meta?.height) || meta.width < 1 || meta.height < 1 || meta.width > 20_000 || meta.height > 20_000) {
            throw new Error("INVALID_IMAGE");
          }
          totalUploadBytes += entry.size;
        }
        if (totalUploadBytes > 12 * 1024 * 1024) {
          return apiError("AI_INLINE_IMAGE_TOO_LARGE", "整篇作文图片总大小不能超过 12MB，请压缩或重拍后重试", 422);
        }
        const prepared = await Promise.all(files.map(async (entry, position) => {
          const file = entry as File;
          const meta = metadata[position]!;
          const data = await file.arrayBuffer();
          const bytes = new Uint8Array(data);
          const validMagic = file.type === "image/jpeg"
            ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
            : file.type === "image/png"
              ? bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
              : bytes.length >= 12
                && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
                && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
          if (!validMagic) throw new Error("INVALID_IMAGE");
          const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
          const path = `images/${crypto.randomUUID()}.${extension}`;
          return { originalName: file.name.slice(0, 255), mimeType: file.type as "image/jpeg" | "image/png" | "image/webp", width: meta.width, height: meta.height, path, data };
        }));
        const keys = prepared.map((image) => `users/${user.id}/reviews/${reviewId}/${image.path}`);
        try {
          await Promise.all(prepared.map((image, index) => env.FILES.put(keys[index], image.data, { httpMetadata: { contentType: image.mimeType } })));
          const saved = await new D1ImageWriter(env.DB).replace(user.id, reviewId, expectedRevision, prepared, privacyConfirmed);
          const newKeySet = new Set(keys);
          const obsoleteKeys = [...new Set(saved.replacedPaths
            .filter((path) => /^images\/[^/\\\0]+$/u.test(path))
            .map((path) => `users/${user.id}/reviews/${reviewId}/${path}`)
            .filter((key) => !newKeySet.has(key)))];
          if (obsoleteKeys.length > 0) {
            await runInBackground(ctx, Promise.resolve(env.FILES.delete(obsoleteKeys)).then(
              () => undefined,
              (cleanupError) => {
                console.warn(JSON.stringify({
                  event: "replaced_images_cleanup_failed",
                  reviewId,
                  count: obsoleteKeys.length,
                  error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
                }));
              },
            ));
          }
          return Response.json(
            { ok: true, data: { images: saved.images, revision: saved.revision } },
            { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
          );
        } catch (error) {
          await Promise.resolve(env.FILES.delete(keys)).catch(() => undefined);
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
      const etag = `"${file.key.split("/").pop() ?? `${imageId}-${variant}`}"`;
      const cacheHeaders = {
        "cache-control": "private, max-age=3600, immutable",
        etag,
        vary: "Cookie",
        "x-content-type-options": "nosniff",
      };
      if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag)) {
        return new Response(null, { status: 304, headers: cacheHeaders });
      }
      const object = await env.FILES.get(file.key);
      if (!object) return apiError("FILE_NOT_FOUND", "图片不存在", 404);
      return new Response(object.body, {
        headers: {
          "content-type": object.httpMetadata?.contentType ?? file.contentType,
          ...cacheHeaders,
        },
      });
    }
    const ocrMatch = /^\/api\/reviews\/([^/]+)\/ocr$/u.exec(url.pathname);
    if (ocrMatch && request.method === "PATCH") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      const reviewId = decodeURIComponent(ocrMatch[1]);
      try {
        const body = editOcrParagraphsSchema.parse(await request.json());
        await new D1OcrCheckpointRepository(env.DB).editParagraphTexts(
          user.id,
          reviewId,
          body.expectedOcrRevision,
          body.paragraphs,
        );
        const review = await new D1ReviewReader(env.DB).get(user.id, reviewId);
        if (!review) return apiError("REVIEW_NOT_FOUND", "批改记录不存在", 404);
        return Response.json({ ok: true, data: review }, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        if (error instanceof OcrCheckpointError) {
          const messages = {
            OCR_NOT_FOUND: "识别原文不存在",
            OCR_REVISION_CONFLICT: "识别原文已被更新",
            IMAGE_REVISION_CONFLICT: "作文图片已被更新",
            OCR_V2_REQUIRED: "当前识别原文需要重新识别",
          };
          return apiError(error.code, messages[error.code], error.status);
        }
        return apiError("VALIDATION_ERROR", "请求参数无效", 400);
      }
    }
    const analyzeMatch = /^\/api\/reviews\/([^/]+)\/analyze$/u.exec(url.pathname);
    if (analyzeMatch && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      try {
        const reviewId = decodeURIComponent(analyzeMatch[1]);
        const input = request.headers.get("content-type")?.includes("application/json")
          ? await request.json() as { teacherGuidance?: unknown; mode?: unknown }
          : undefined;
        const result = await new D1AnalysisJobs(env.DB).enqueue(user.id, reviewId, input);
        if (!result.job) return apiError("REVIEW_NOT_FOUND", "批改记录不存在", 404);
        if (result.newlyQueued) {
          const jobId = (result.job as { id: string }).id;
          try {
            await env.ANALYSIS_QUEUE.send({ jobId });
          } catch {
            return compensateQueueDispatch(new D1Reanalysis(env.DB), user.id, [jobId]);
          }
        }
        return Response.json({ ok: true, data: result.job }, { status: 202, headers: { "cache-control": "no-store" } });
      } catch (error) {
        const errorCode = typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : null;
        const messageCode = error instanceof Error ? error.message : null;
        const code = errorCode ?? messageCode;
        if (code === "IMAGES_REQUIRED") return apiError(code, "请先上传 1 至 4 张作文图片", 422);
        if (code === "OCR_NOT_FOUND") return apiError(code, "识别原文不存在或已失效", 409);
        if (code === "OCR_V2_REQUIRED") return apiError(code, "当前识别原文需要重新识别", 409);
        if (code === "ANALYSIS_CONFLICT") return apiError(code, "作文状态已更新，请重试", 409);
        return apiError("VALIDATION_ERROR", "请求参数无效", 400);
      }
    }
    const analyzeStatusMatch = /^\/api\/reviews\/([^/]+)\/analyze\/status$/u.exec(url.pathname);
    if (analyzeStatusMatch && request.method === "GET") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      const job = await new D1AnalysisJobs(env.DB).latest(user.id, decodeURIComponent(analyzeStatusMatch[1]));
      return Response.json({ ok: true, data: { job } }, { headers: { "cache-control": "no-store" } });
    }
    const sampleRewriteMatch = /^\/api\/reviews\/([^/]+)\/sample-paragraphs\/(\d+)$/u.exec(url.pathname);
    const paragraphRewriteMatch = /^\/api\/reviews\/([^/]+)\/paragraph-reviews\/([^/]+)$/u.exec(url.pathname);
    const feedbackRewriteMatch = /^\/api\/reviews\/([^/]+)\/feedback\/(strengths|improvements)$/u.exec(url.pathname);
    const samplesRewriteMatch = /^\/api\/reviews\/([^/]+)\/sample-paragraphs\/regenerate$/u.exec(url.pathname);
    if (paragraphRewriteMatch && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      try {
        const reviewId = decodeURIComponent(paragraphRewriteMatch[1]);
        const paragraphId = decodeURIComponent(paragraphRewriteMatch[2]);
        const body = paragraphRewriteSchema.parse(await request.json());
        const review = await new D1ReviewReader(env.DB).get(user.id, reviewId) as ReviewView | null;
        if (!review) return apiError("REVIEW_NOT_FOUND", "批改记录不存在", 404);
        if (!review.report) return apiError("IMAGES_REQUIRED", "请先完成作文分析", 422);
        if (!isParagraphEvaluationReport(review.report)) {
          return apiError("LEGACY_REPORT", "旧版示范段落报告需要完整重新分析", 409);
        }
        if (!review.ocr || review.ocr.version !== 2) {
          return apiError("OCR_V2_REQUIRED", "当前识别原文需要重新识别", 409);
        }
        if (review.reportStale) {
          return apiError("REPORT_STALE", "批改报告基于旧版识别原文，请重新生成批改", 409);
        }
        const current = body.paragraphReviews.find(({ paragraphId: id }) => id === paragraphId);
        const paragraph = review.ocr.paragraphs.find(({ id }) => id === paragraphId);
        if (!paragraph && !current?.noSourceParagraph) return apiError("PARAGRAPH_NOT_FOUND", "自然段不存在", 404);
        try {
          validateParagraphReportForIds(
            { ...review.report, paragraphReviews: body.paragraphReviews },
            review.ocr.paragraphs.map(({ id }) => id),
          );
        } catch {
          return apiError(
            "PARAGRAPH_COVERAGE_MISMATCH",
            "逐段批改没有完整覆盖当前识别自然段",
            400,
          );
        }
        if (!current) return apiError("PARAGRAPH_NOT_FOUND", "自然段批改不存在", 404);
        const [standingOpinions, essayOpinions] = await Promise.all([
          listD1StandingOpinions(env.DB, user.id, review.config.title),
          listD1EssayOpinions(env.DB, user.id, review.id),
        ]);
        const rewritten = await new OpenAIReviewAdapter(
          workerAiSettings(env),
          { clientFactory: createWorkerOpenAIClient },
        ).rewriteParagraph({
          config: review.config,
          paragraphs: review.ocr.paragraphs.map(({ id, text }) => ({ id, text })),
          current,
          paragraphId,
          instruction: body.instruction,
          paragraphReviews: body.paragraphReviews,
          teacherGuidance: composeReviewGuidance(
            body.teacherGuidance ?? review.teacherGuidance,
            standingOpinions,
            essayOpinions,
          ) ?? undefined,
        });
        return Response.json(
          { ok: true, data: rewritten },
          { headers: { "cache-control": "no-store" } },
        );
      } catch (error) {
        if (error instanceof ZodError || error instanceof SyntaxError) {
          return apiError("VALIDATION_ERROR", "请求参数无效", 400);
        }
        if (error instanceof AiAdapterError) {
          return apiError(error.code, error.message, error.status);
        }
        return apiError("AI_REQUEST_FAILED", "单段批改重写失败", 502);
      }
    }
    if (sampleRewriteMatch && request.method === "POST") {
      if (!user) return apiError("UNAUTHENTICATED", "Authentication required", 401);
      try {
        const review = await new D1ReviewReader(env.DB).get(user.id, decodeURIComponent(sampleRewriteMatch[1])) as ReviewView | null;
        const index = Number(sampleRewriteMatch[2]);
        if (!review?.report) return apiError("IMAGES_REQUIRED", "请先完成作文分析", 422);
        if (!isLegacyEvaluationReport(review.report)) return apiError("UNSUPPORTED_REPORT_VERSION", "逐段批改报告不支持示范段落重写", 409);
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
        if (!isLegacyEvaluationReport(review.report)) return apiError("UNSUPPORTED_REPORT_VERSION", "逐段批改报告不支持示范段落重写", 409);
        const body = await request.json() as { instruction?: unknown };
        const instruction = typeof body.instruction === "string" && body.instruction.trim() ? body.instruction.trim().slice(0, 1000) : undefined;
        return Response.json({ ok: true, data: await new OpenAIReviewAdapter(workerAiSettings(env), { clientFactory: createWorkerOpenAIClient }).rewriteAllSamples({ config: review.config, sampleParagraphs: review.report.sampleParagraphs, instruction }) });
      } catch { return apiError("AI_REQUEST_FAILED", "整篇示范文重写失败", 502); }
    }
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ ok: false, error: { code: "NOT_FOUND", message: "接口不存在" } }, { status: 404 });
    }
    return secureResponse(await env.ASSETS.fetch(request), url.pathname);
}

const worker = {
  async fetch(request: Request, env: WorkerEnv, ctx?: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    let response: Response;
    try {
      response = await handleFetch(request, env, ctx);
    } catch (error) {
      if (error instanceof URIError) {
        return apiError("VALIDATION_ERROR", "请求路径无效", 400);
      }
      throw error;
    }
    if (pathname.startsWith("/api/")) {
      return secureApiResponse(response);
    }
    return response;
  },
  async scheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
    const recovered = await new D1AnalysisJobs(env.DB).recoverExpired();
    if (recovered > 0) {
      console.info(JSON.stringify({
        event: "analysis_timeout_recovery",
        recovered,
        reason: `运行超过 ${MAX_CLOUD_ANALYSIS_RUN_MS / 60_000} 分钟仍未结束或长时间滞留队列，已标记为超时`,
      }));
    }
    const scheduledTime = typeof controller?.scheduledTime === "number" ? controller.scheduledTime : 0;
    const shouldRunMaintenance = scheduledTime === 0 || Math.floor(scheduledTime / 60_000) % 15 === 0;
    if (!shouldRunMaintenance) return;
    try {
      const cleaned = await runCloudMaintenance(env.DB);
      if (
        cleaned.emptyDraftsDeleted > 0
        || cleaned.loginChallengesDeleted > 0
        || cleaned.sessionsDeleted > 0
        || cleaned.loginAttemptsDeleted > 0
      ) {
        console.info(JSON.stringify({ event: "cloud_maintenance_cleanup", ...cleaned }));
      }
    } catch (error) {
      console.warn(JSON.stringify({
        event: "cloud_maintenance_cleanup_failed",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  },
  async queue(batch: MessageBatch<{ jobId: string }>, env: WorkerEnv): Promise<void> {
    for (const message of batch.messages) {
      const job = await env.DB.prepare(`
        SELECT analysis_jobs.id, analysis_jobs.review_id, analysis_jobs.owner_id,
          analysis_jobs.mode, analysis_jobs.teacher_guidance, analysis_jobs.status,
          analysis_jobs.created_at, analysis_jobs.started_at, reviews.config,
          reviews.student_name, reviews.image_revision, reviews.report
        FROM analysis_jobs INNER JOIN reviews ON reviews.id = analysis_jobs.review_id
        WHERE analysis_jobs.id = ? AND analysis_jobs.status IN ('queued', 'running')
      `).bind(message.body.jobId).first<{
        id: string;
        review_id: string;
        owner_id: string;
        mode: "full" | "content_only";
        status: "queued" | "running";
        created_at: number;
        started_at: number | null;
        teacher_guidance: string | null;
        config: string;
        student_name: string;
        image_revision: number;
        report?: string | null;
      }>();
      if (!job) { message.ack(); continue; }
      if (job.status === "running") {
        if ((job.started_at ?? job.created_at) <= Date.now() - MAX_CLOUD_ANALYSIS_RUN_MS) {
          await new D1AnalysisJobs(env.DB).recoverExpired(Date.now(), { ownerId: job.owner_id, reviewId: job.review_id });
          message.ack();
        } else {
          // An interrupted consumer may be redelivered before its deadline.
          // Keep the message available without executing the same job twice.
          message.retry({ delaySeconds: 60 });
        }
        continue;
      }
      const startedAt = Date.now();
      try {
        const claim = await env.DB.prepare(`
          UPDATE analysis_jobs SET status = 'running', started_at = ?
          WHERE id = ? AND status = 'queued'
        `).bind(Date.now(), job.id).run();
        if (claim.meta.changes !== 1) { message.retry({ delaySeconds: 60 }); continue; }
        console.info(JSON.stringify({ event: "analysis_started", jobId: job.id }));
        const settings = createWorkerAiSettingsSource(env);
        const vision = new VisionOcrAdapter(settings, { clientFactory: createWorkerOpenAIClient });
        const content = new CompositionReviewAdapter(settings, { clientFactory: createWorkerOpenAIClient });
        const ocr = new D1OcrCheckpointRepository(env.DB);
        let previousReport = null;
        if (job.report) {
          try {
            const parsed = JSON.parse(job.report);
            if (isParagraphEvaluationReport(parsed)) {
              previousReport = parsed;
            }
          } catch {
            // Ignore malformed previous report
          }
        }
        const pipelineJob: CloudAnalysisPipelineJob = {
          id: job.id,
          reviewId: job.review_id,
          ownerId: job.owner_id,
          mode: job.mode,
          imageRevision: job.image_revision,
          config: assignmentConfigSchema.parse(JSON.parse(job.config)),
          teacherGuidance: job.teacher_guidance ?? undefined,
          studentName: job.student_name || undefined,
          ...(previousReport ? { previousReport } : {}),
        };
        const logStep = async <T>(step: string, action: () => Promise<T>): Promise<T> => {
          const stepStarted = Date.now();
          try {
            const value = await action();
            console.info(JSON.stringify({
              event: "analysis_step",
              jobId: job.id,
              step,
              durationMs: Date.now() - stepStarted,
              elapsedMs: Date.now() - startedAt,
              ok: true,
            }));
            return value;
          } catch (error) {
            console.warn(JSON.stringify({
              event: "analysis_step",
              jobId: job.id,
              step,
              durationMs: Date.now() - stepStarted,
              elapsedMs: Date.now() - startedAt,
              ok: false,
              reason: error instanceof Error ? error.message.slice(0, 180) : "unknown",
            }));
            throw error;
          }
        };
        const pipeline = new CloudAnalysisPipeline({
          readCheckpoint: (ownerId, reviewId) => ocr.readInternal(ownerId, reviewId),
          loadImageUrls: (currentJob) => logStep("load_images", async () => {
            const images = await new D1ReviewReader(env.DB).aiImageObjectsForReview(
              currentJob.ownerId,
              currentJob.reviewId,
            );
            if (images.length === 0) throw new Error("AI_IMAGE_UNAVAILABLE");
            return loadInlineAiImageUrls(env.FILES, images);
          }),
          recognize: (imageUrls) => logStep("recognize", () => vision.recognize({ imageUrls })),
          saveRecognized: (ownerId, reviewId, sourceRevision, result) =>
            logStep("save_ocr", () => ocr.saveRecognized(ownerId, reviewId, sourceRevision, result, job.id)),
          analyzeText: (input) => logStep("generate_review", () => content.analyzeText(input)),
          updateStage: async (jobId, stage) => {
            const result = await env.DB.prepare(
              "UPDATE analysis_jobs SET progress_stage = ? WHERE id = ? AND status = 'running'",
            ).bind(stage, jobId).run();
            if (result.meta.changes !== 1) throw new CloudAnalysisConflictError("ANALYSIS_CONFLICT");
            console.info(JSON.stringify({ event: "analysis_stage", jobId, stage, elapsedMs: Date.now() - startedAt }));
          },
          saveResult: (currentJob, result) => logStep("save_result", () => savePipelineResult(env.DB, currentJob, result)),
          saveUnreadable: (currentJob, checkpoint) =>
            logStep("save_unreadable", () => saveUnreadableResult(env.DB, currentJob, checkpoint.ocrRevision)),
        });
        await pipeline.run(pipelineJob);
        console.info(JSON.stringify({ event: "analysis_completed", jobId: job.id, elapsedMs: Date.now() - startedAt }));
      } catch (error) {
        const code = analysisFailureCode(error);
        const now = Date.now();
        const detail = sanitizeAnalysisDetail(error instanceof Error ? error.message : "");
        await env.DB.batch([
          env.DB.prepare("UPDATE reviews SET status = 'failed', analysis_run_id = NULL, updated_at = ?, summary_state_key = CASE WHEN summary_state_key IS NULL THEN NULL ELSE (CAST(revision AS TEXT) || ':' || CAST(image_revision AS TEXT) || ':' || CAST(COALESCE(ocr_revision_cached, -1) AS TEXT) || ':' || CAST(COALESCE(report_ocr_revision, -1) AS TEXT) || ':failed:' || CAST(COALESCE(teacher_reviewed_at, -1) AS TEXT)) END WHERE id = ? AND owner_id = ? AND analysis_run_id = ? AND status = 'analyzing'").bind(now, job.review_id, job.owner_id, job.id),
          env.DB.prepare("UPDATE analysis_jobs SET status = 'failed', error_code = ?, finished_at = ?, message = CASE WHEN instr(COALESCE(message, ''), ?) = 1 THEN message ELSE ? END WHERE id = ? AND status = 'running'").bind(code, now, ANALYSIS_JOB_METADATA_PREFIX, detail, job.id),
        ]);
        console.warn(JSON.stringify({ event: "analysis_failed", jobId: job.id, code, elapsedMs: Date.now() - startedAt }));
      }
      message.ack();
    }
  },
};

export default worker;

export async function savePipelineResult(
  database: D1Database,
  job: CloudAnalysisPipelineJob,
  result: { report: unknown; annotations: Array<{ pageIndex: number; x: number; y: number; category: string; anchorText: string; comment: string; isHighlight: boolean }>; ocrRevision: number },
): Promise<void> {
  const now = Date.now();
  const summaryFields = extractReportSummaryFields(result.report);
  const blockedReason = summaryFields.isLegacy
    ? "旧版示范段落报告需要完整重新分析后才能导出新格式"
    : "尚未经过老师审核";
  const savedGuard = `EXISTS (
    SELECT 1 FROM reviews INNER JOIN analysis_jobs ON analysis_jobs.id = ?
    WHERE reviews.id = ? AND reviews.owner_id = ? AND reviews.analysis_run_id IS NULL
      AND reviews.image_revision = ? AND reviews.report_ocr_revision = ?
      AND analysis_jobs.review_id = reviews.id AND analysis_jobs.status = 'running'
  )`;
  const savedGuardBindings = [job.id, job.reviewId, job.ownerId, job.imageRevision, result.ocrRevision];
  const statements = [
    database.prepare(`
      UPDATE reviews SET report = ?, report_ocr_revision = ?, status = 'ready_for_review',
        has_report = 1, summary_grade = ?, summary_is_legacy = ?, summary_diagnostics = ?,
        ocr_revision_cached = ?, export_ready_version = NULL, export_blocked_reason = ?,
        summary_state_key = CASE WHEN summary_title IS NULL THEN NULL ELSE (CAST(revision + 1 AS TEXT) || ':' || CAST(image_revision AS TEXT) || ':' || CAST(CAST(? AS INTEGER) AS TEXT) || ':' || CAST(CAST(? AS INTEGER) AS TEXT) || ':ready_for_review:' || CAST(COALESCE(teacher_reviewed_at, -1) AS TEXT)) END,
        revision = revision + 1, analysis_run_id = NULL, updated_at = ?
      WHERE id = ? AND owner_id = ? AND analysis_run_id = ? AND image_revision = ?
        AND json_extract(ocr_checkpoint, '$.ocrRevision') = ?
        AND EXISTS (SELECT 1 FROM analysis_jobs WHERE id = ? AND status = 'running')
    `).bind(
      JSON.stringify(result.report), result.ocrRevision,
      summaryFields.grade, summaryFields.isLegacy, summaryFields.diagnosticsJson,
      result.ocrRevision, blockedReason,
      result.ocrRevision, result.ocrRevision,
      now,
      job.reviewId, job.ownerId, job.id, job.imageRevision, result.ocrRevision, job.id,
    ),
    database.prepare(`DELETE FROM annotations WHERE review_id = ? AND ${savedGuard}`)
      .bind(job.reviewId, ...savedGuardBindings),
    ...result.annotations.map((annotation, position) => database.prepare(`
      INSERT INTO annotations (
        review_id, position, page_index, x, y, category, anchor_text, comment, is_highlight
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${savedGuard}
    `).bind(
      job.reviewId, position, annotation.pageIndex, annotation.x, annotation.y,
      annotation.category, annotation.anchorText, annotation.comment, annotation.isHighlight ? 1 : 0,
      ...savedGuardBindings,
    )),
    database.prepare(`UPDATE analysis_jobs SET status = 'succeeded', finished_at = ?
      WHERE id = ? AND status = 'running' AND ${savedGuard}`)
      .bind(now, job.id, ...savedGuardBindings),
  ];
  const outcomes = await database.batch(statements);
  if (outcomes.at(-1)?.meta.changes !== 1) throw new CloudAnalysisConflictError("ANALYSIS_CONFLICT");
}

export async function saveUnreadableResult(
  database: D1Database,
  job: CloudAnalysisPipelineJob,
  ocrRevision: number,
): Promise<void> {
  const now = Date.now();
  const outcomes = await database.batch([
    database.prepare(`
      UPDATE reviews SET status = 'needs_better_images', report = NULL, report_ocr_revision = NULL,
        has_report = 0, summary_grade = NULL, summary_is_legacy = 0, summary_diagnostics = NULL,
        ocr_revision_cached = ?, export_ready_version = NULL,
        export_blocked_reason = '批改报告尚未完成',
        summary_state_key = CASE WHEN summary_title IS NULL THEN NULL ELSE (CAST(revision AS TEXT) || ':' || CAST(image_revision AS TEXT) || ':' || CAST(CAST(? AS INTEGER) AS TEXT) || ':-1:needs_better_images:' || CAST(COALESCE(teacher_reviewed_at, -1) AS TEXT)) END,
        analysis_run_id = NULL, updated_at = ?
      WHERE id = ? AND owner_id = ? AND analysis_run_id = ? AND image_revision = ?
        AND json_extract(ocr_checkpoint, '$.ocrRevision') = ?
        AND EXISTS (SELECT 1 FROM analysis_jobs WHERE id = ? AND status = 'running')
    `).bind(ocrRevision, ocrRevision, now, job.reviewId, job.ownerId, job.id, job.imageRevision, ocrRevision, job.id),
    database.prepare(`
      UPDATE analysis_jobs SET status = 'succeeded', progress_stage = 'saving_result', finished_at = ?
      WHERE id = ? AND status = 'running' AND EXISTS (
        SELECT 1 FROM reviews WHERE id = ? AND owner_id = ? AND analysis_run_id IS NULL
          AND image_revision = ? AND status = 'needs_better_images'
      )
    `).bind(now, job.id, job.reviewId, job.ownerId, job.imageRevision),
  ]);
  if (outcomes.at(-1)?.meta.changes !== 1) throw new CloudAnalysisConflictError("ANALYSIS_CONFLICT");
}
