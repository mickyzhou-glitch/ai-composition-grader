import {
  AI_MAX_RETRIES,
  AI_TIMEOUT_MS,
  describeUpstreamAiError,
  timeoutForBaseUrl,
  XAI_AI_TIMEOUT_MS,
} from "./ai-client-options";
import type { AiSettingsSource, OpenAIClientFactory, OpenAICompatibleClient } from "./openai-review-adapter";
import { AiAdapterError } from "./openai-review-adapter";

export { AI_MAX_RETRIES, AI_TIMEOUT_MS, describeUpstreamAiError, timeoutForBaseUrl, XAI_AI_TIMEOUT_MS };

/** Strip markdown fences and any prose around the outermost JSON object before parsing. */
export function cleanJsonResponse(content: string): string {
  let text = content.replace(/^\uFEFF/u, "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu);
  if (fenced?.[1]?.includes("{")) text = fenced[1].trim();
  else text = text.replace(/^```(?:json)?\s*/iu, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start > 0 || (start >= 0 && end > start && end < text.length - 1)) {
    text = end > start ? text.slice(start, end + 1) : text.slice(start);
  }
  return text;
}

export function parseJsonResponse(content: string): unknown {
  return JSON.parse(cleanJsonResponse(content));
}

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

export async function completionWithFinish(
  client: OpenAICompatibleClient,
  request: unknown,
): Promise<{ content: string; truncated: boolean }> {
  try {
    const response = await client.chat.completions.create(request);
    const choice = response.choices[0] as { message: { content?: string | null }; finish_reason?: string | null } | undefined;
    return { content: choice?.message.content ?? "", truncated: choice?.finish_reason === "length" };
  } catch (error) {
    const { upstreamStatus, upstreamCode, message } = describeUpstreamAiError(error);
    throw new AiAdapterError("AI_REQUEST_FAILED", message, 502, upstreamStatus, upstreamCode);
  }
}
