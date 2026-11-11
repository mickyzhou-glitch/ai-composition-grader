import { z } from "zod";
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
  if (start < 0) return text;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return text.slice(start);
}

export function parseJsonResponse(content: string): unknown {
  const text = cleanJsonResponse(content);
  try {
    return JSON.parse(text);
  } catch {
    // Only deterministic syntax repairs. Never invent missing fields, quotes,
    // or closing brackets: a truncated essay must not become a valid report.
    let repaired = "";
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (char.charCodeAt(0) < 32) {
          if (escaped) repaired = repaired.slice(0, -1);
          repaired += JSON.stringify(char).slice(1, -1);
          escaped = false;
          continue;
        }
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "," && /^\s*[}\]]/u.test(text.slice(index + 1))) continue;
      repaired += char;
    }
    return JSON.parse(repaired);
  }
}

/** A bounded, data-free reason that can be persisted without model text. */
export function responseValidationCode(error: unknown): string {
  if (error instanceof TruncatedOutputError) return "output_truncated";
  if (error instanceof SyntaxError) return "json_parse";
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    const path = issue?.path.map(String).join("_").replace(/[^a-zA-Z0-9_]/gu, "") || "root";
    return `schema_${path}_${issue?.code ?? "invalid"}`.slice(0, 120);
  }
  return "validation_unknown";
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
    const choice = response?.choices?.[0];
    if (!choice?.message || (choice.message.content != null && typeof choice.message.content !== "string")) {
      throw new AiAdapterError("AI_INVALID_RESPONSE", "AI 服务返回的响应信封无效", 502, undefined, "response_envelope");
    }
    return { content: choice.message.content ?? "", truncated: choice.finish_reason === "length" };
  } catch (error) {
    if (error instanceof AiAdapterError) throw error;
    const { upstreamStatus, upstreamCode, message } = describeUpstreamAiError(error);
    const name = error && typeof error === "object" && "name" in error ? error.name : "";
    const timedOut = ["TimeoutError", "AbortError", "APIConnectionTimeoutError"].includes(String(name))
      || upstreamCode === "ETIMEDOUT";
    throw new AiAdapterError("AI_REQUEST_FAILED", message, 502, upstreamStatus, timedOut ? "request_timeout" : upstreamCode);
  }
}

function unrecognizedKeyIssues(error: z.ZodError): Array<{ keys: string[]; path: PropertyKey[] }> {
  return error.issues.flatMap((issue) => {
    if (issue.code !== "unrecognized_keys" || !("keys" in issue) || !Array.isArray(issue.keys)) return [];
    return [{ keys: issue.keys.filter((key): key is string => typeof key === "string"), path: [...issue.path] }];
  });
}

function valueAt(root: unknown, path: PropertyKey[]): unknown {
  let current = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
}

/** Drop fields the model invented so a strict report schema can still parse. */
export function dropUnrecognizedKeys(value: unknown, schema: z.ZodType): unknown {
  let current = value;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const parsed = schema.safeParse(current);
    if (parsed.success) return current;
    const issues = unrecognizedKeyIssues(parsed.error);
    if (issues.length === 0) return current;
    const next = structuredClone(current);
    let removed = false;
    for (const issue of issues) {
      const target = valueAt(next, issue.path);
      if (!target || typeof target !== "object") continue;
      for (const key of issue.keys) {
        if (Object.prototype.hasOwnProperty.call(target, key)) {
          delete (target as Record<string, unknown>)[key];
          removed = true;
        }
      }
    }
    if (!removed) return current;
    current = next;
  }
  return current;
}
