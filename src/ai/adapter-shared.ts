import {
  AI_MAX_RETRIES,
  AI_TIMEOUT_MS,
  describeUpstreamAiError,
  timeoutForBaseUrl,
  XAI_AI_TIMEOUT_MS,
} from "./ai-client-options";
import type { AiSettingsSource, OpenAIClientFactory, OpenAICompatibleClient } from "./openai-review-adapter";
import { AiAdapterError } from "./openai-review-adapter";
import { JSON_RETRY_INSTRUCTION, tryParseJsonResponse } from "./json-response";

export { AI_MAX_RETRIES, AI_TIMEOUT_MS, describeUpstreamAiError, timeoutForBaseUrl, XAI_AI_TIMEOUT_MS };
export { cleanJsonResponse, parseJsonResponse, tryParseJsonResponse } from "./json-response";

/** The model stopped at its output limit; the JSON is incomplete. */
export class TruncatedOutputError extends Error {
  constructor() {
    super("output_truncated");
    this.name = "TruncatedOutputError";
  }
}

export async function roleClient(
  settingsSource: AiSettingsSource,
  clientFactory: OpenAIClientFactory,
  role: "vision" | "content",
): Promise<{ client: OpenAICompatibleClient; model: string; baseUrl: string }> {
  const settings = await settingsSource.getRuntimeConfig(role);
  if (!settings) {
    throw new AiAdapterError(
      "AI_SETTINGS_INCOMPLETE",
      role === "vision" ? "请先配置拍照识图模型" : "请先配置作文内容模型",
      400,
    );
  }
  return {
    model: settings.model,
    baseUrl: settings.baseUrl,
    client: clientFactory({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
      timeout: timeoutForBaseUrl(settings.baseUrl),
      maxRetries: AI_MAX_RETRIES,
    }),
  };
}

export async function completionContent(client: OpenAICompatibleClient, request: unknown): Promise<string> {
  return (await completionWithFinish(client, request)).content;
}

/**
 * Ask the model and, when the answer cannot be parsed as JSON at all, re-ask
 * once with an explicit format reminder. A truncated answer is left to the
 * caller, which raises its own output-limit error.
 */
export async function completionJsonWithFinish(
  client: OpenAICompatibleClient,
  request: { messages: unknown[] } & Record<string, unknown>,
): Promise<{ content: string; truncated: boolean }> {
  const first = await completionWithFinish(client, request);
  if (first.truncated || tryParseJsonResponse(first.content).ok) return first;
  const retry = await completionWithFinish(client, {
    ...request,
    messages: [...request.messages, { role: "user", content: JSON_RETRY_INSTRUCTION }],
  });
  // Keep the first answer when the retry is no better, so the repair step still
  // sees the richer response and the failure keeps its json_parse category. A
  // truncated retry is no better: returning it would turn a json_parse failure
  // into a truncation retry at the same output cap.
  return !retry.truncated && tryParseJsonResponse(retry.content).ok ? retry : first;
}

export async function completionWithFinish(
  client: OpenAICompatibleClient,
  request: unknown,
): Promise<{ content: string; truncated: boolean }> {
  try {
    const response = await client.chat.completions.create(request);
    const choice = response.choices[0] as { message: { content?: string | null }; finish_reason?: string | null } | undefined;
    return { content: choice?.message.content ?? "", truncated: choice?.finish_reason === "length" };
  } catch (error) {
    if (error instanceof AiAdapterError) throw error;
    const { upstreamStatus, upstreamCode, message } = describeUpstreamAiError(error);
    throw new AiAdapterError("AI_REQUEST_FAILED", message, 502, upstreamStatus, upstreamCode);
  }
}
