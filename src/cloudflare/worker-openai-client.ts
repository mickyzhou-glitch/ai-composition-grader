import type { OpenAIClientFactory, OpenAICompatibleClient } from "../ai/openai-review-adapter";

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

/**
 * Uses the same minimal HTTP contract as the successful connection test.
 * Some OpenAI-compatible gateways reject the SDK's additional telemetry
 * headers even when they support the Chat Completions API.
 */
export const createWorkerOpenAIClient: OpenAIClientFactory = (options): OpenAICompatibleClient => ({
  chat: {
    completions: {
      async create(input: unknown) {
        const response = await fetch(`${options.baseURL.replace(/\/+$/u, "")}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        const payload = await responsePayload(response);
        if (!response.ok) {
          throw Object.assign(new Error("AI upstream request failed"), {
            status: response.status,
            code: safeProviderCode(payload),
          });
        }
        if (typeof payload !== "object" || payload === null || !("choices" in payload) || !Array.isArray(payload.choices)) {
          throw Object.assign(new Error("AI upstream response was invalid"), { code: "invalid_response" });
        }
        return payload as { choices: Array<{ message: { content: string | null } }> };
      },
    },
  },
});
