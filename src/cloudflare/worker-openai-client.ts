import type { OpenAIClientFactory, OpenAICompatibleClient } from "../ai/openai-review-adapter";
import { aiRequestHeaders } from "./ai-request-headers";
import { fetchAiUpstream } from "./ai-upstream-fetch";

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

function retryDelay(response: Response, attempt: number): number | null {
  if (response.status !== 429 && response.status < 500) return null;
  const header = response.headers.get("retry-after");
  if (header?.trim()) {
    const seconds = Number(header);
    const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    // Do not retry earlier than the provider permits, or hold a Worker open indefinitely.
    if (Number.isFinite(delay) && delay >= 0) return delay <= 60_000 ? delay : null;
  }
  return Math.min(60_000, (response.status === 429 ? 30_000 : 1000) * 2 ** attempt);
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
        const request = {
          method: "POST",
          headers: aiRequestHeaders(options.baseURL, options.apiKey),
          body: JSON.stringify(input),
        };
        for (let attempt = 0; ; attempt += 1) {
          const response = await fetchAiUpstream(url, { ...request, signal: AbortSignal.timeout(options.timeout) });
          const payload = await responsePayload(response);
          if (!response.ok) {
            const delay = retryDelay(response, attempt);
            if (attempt < options.maxRetries && delay !== null) {
              await new Promise<void>((resolve) => setTimeout(resolve, delay));
              continue;
            }
            throw Object.assign(new Error("AI upstream request failed"), {
              status: response.status,
              code: safeProviderCode(payload),
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
