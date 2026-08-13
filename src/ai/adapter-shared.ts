import type { AiSettingsSource, OpenAIClientFactory, OpenAICompatibleClient } from "./openai-review-adapter";
import { AiAdapterError } from "./openai-review-adapter";

export const AI_TIMEOUT_MS = 180_000;
export const AI_MAX_RETRIES = 1;

export function parseJsonResponse(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

export async function roleClient(
  settingsSource: AiSettingsSource,
  clientFactory: OpenAIClientFactory,
  role: "vision" | "content",
): Promise<{ client: OpenAICompatibleClient; model: string }> {
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
    client: clientFactory({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
      timeout: AI_TIMEOUT_MS,
      maxRetries: AI_MAX_RETRIES,
    }),
  };
}

export async function completionContent(client: OpenAICompatibleClient, request: unknown): Promise<string> {
  try {
    const response = await client.chat.completions.create(request);
    return response.choices[0]?.message.content ?? "";
  } catch (error) {
    const upstreamStatus = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status
      : undefined;
    throw new AiAdapterError("AI_REQUEST_FAILED", "AI 服务请求失败", 502, upstreamStatus);
  }
}
