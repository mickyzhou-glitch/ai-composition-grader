import { redactAiSecrets } from "../ai/ai-client-options";
import type { OpenAIClientFactory, OpenAICompatibleClient } from "../ai/openai-review-adapter";
import { aiRequestHeaders } from "./ai-request-headers";

function safeProviderCode(payload: unknown): string | undefined {
  const error = typeof payload === "object" && payload !== null && "error" in payload ? payload.error : payload;
  if (typeof error !== "object" || error === null) return undefined;
  const value = "code" in error && typeof error.code === "string"
    ? error.code
    : "type" in error && typeof error.type === "string"
      ? error.type
      : undefined;
  return value && /^[A-Za-z0-9._-]{1,64}$/u.test(value) ? value : undefined;
}

async function responsePayload(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return undefined; }
}

const UPSTREAM_DETAIL_LIMIT = 500;

function upstreamErrorDetail(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const body = payload as { error?: unknown; message?: unknown };
  const nested = body.error;
  const detail = typeof nested === "string"
    ? nested
    : typeof nested === "object" && nested !== null && "message" in nested && typeof nested.message === "string"
      ? nested.message
      : typeof body.message === "string"
        ? body.message
        : "";
  const compact = redactAiSecrets(detail).replace(/\s+/gu, " ").trim();
  if (!compact) return undefined;
  return compact.length > UPSTREAM_DETAIL_LIMIT ? `${compact.slice(0, UPSTREAM_DETAIL_LIMIT)}…` : compact;
}

const RETRYABLE_UPSTREAM_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 3_000;

function retryDelayMs(response: Response | null, attempt: number, timeoutMs: number): number {
  if (timeoutMs <= 20) return 0;
  const header = response?.headers.get("retry-after")?.trim();
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(MAX_RETRY_DELAY_MS, Math.round(seconds * 1_000));
    }
  }
  return Math.min(MAX_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS * (attempt + 1));
}

function isTransientFetchFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return false;
  return error instanceof TypeError;
}

/**
 * Uses the same minimal HTTP contract as the successful connection test.
 * Some OpenAI-compatible gateways reject the SDK's additional telemetry
 * headers even when they support the Chat Completions API.
 */
export const createWorkerOpenAIClient: OpenAIClientFactory = (options): OpenAICompatibleClient => ({
  chat: {
    completions: {
      async create(input: unknown) {
        const url = `${options.baseURL.replace(/\/+$/u, "")}/chat/completions`;
        const headers = aiRequestHeaders(options.baseURL, options.apiKey);
        const body = JSON.stringify(input);
        const maxRetries = Math.max(0, Math.trunc(options.maxRetries ?? 0));

        for (let attempt = 0; ; attempt += 1) {
          let response: Response;
          try {
            response = await fetch(url, {
              method: "POST",
              headers,
              body,
              signal: AbortSignal.timeout(options.timeout),
            });
          } catch (error) {
            if (attempt < maxRetries && isTransientFetchFailure(error)) {
              const delay = retryDelayMs(null, attempt, options.timeout);
              if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
              continue;
            }
            throw error;
          }

          if (!response.ok && attempt < maxRetries && RETRYABLE_UPSTREAM_STATUSES.has(response.status)) {
            await response.body?.cancel().catch(() => undefined);
            const delay = retryDelayMs(response, attempt, options.timeout);
            if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }

          const payload = await responsePayload(response);
          if (!response.ok) {
            const detail = upstreamErrorDetail(payload);
            throw Object.assign(new Error("AI upstream request failed"), {
              status: response.status,
              code: safeProviderCode(payload),
              ...(detail ? { error: { message: detail } } : {}),
            });
          }
          if (typeof payload !== "object" || payload === null || !("choices" in payload) || !Array.isArray(payload.choices)) {
            throw Object.assign(new Error("AI upstream response was invalid"), { code: "invalid_response" });
          }
          return payload as { choices: Array<{ message: { content: string | null } }> };
        }
      },
    },
  },
});
