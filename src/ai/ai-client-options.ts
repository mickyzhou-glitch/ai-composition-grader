export const AI_TIMEOUT_MS = 180_000;
/** xAI reasoning models need a slightly longer timeout than standard providers, capped at 4 minutes so a single hung connection cannot stall the 15-minute queue consumer. */
export const XAI_AI_TIMEOUT_MS = 240_000;
export const AI_MAX_RETRIES = 1;

const UPSTREAM_DETAIL_LIMIT = 160;

/** Remove provider keys before a failure string is logged or shown to a teacher. */
export function redactAiSecrets(value: string, literalSecret?: string): string {
  const trimmedSecret = literalSecret?.trim();
  const withoutLiteral = trimmedSecret ? value.split(trimmedSecret).join("[密钥]") : value;
  return withoutLiteral
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, "[密钥]")
    .replace(/xai-[A-Za-z0-9_-]{8,}/giu, "[密钥]")
    .replace(/AIza[A-Za-z0-9_-]{20,}/gu, "[密钥]")
    .replace(/([?&]key=)[^&\s]+/giu, "$1[密钥]")
    .replace(/Bearer\s+\S+/giu, "[密钥]")
    .replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*\S+/giu, "[密钥]");
}

export function isSafeProviderErrorCode(value: string | undefined, literalSecret?: string): value is string {
  if (!value || !/^[A-Za-z0-9._-]{1,64}$/u.test(value)) return false;
  return redactAiSecrets(value, literalSecret) === value;
}

export function isGeminiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "generativelanguage.googleapis.com";
  } catch {
    return false;
  }
}

export function imageUrlContentPart(url: string, baseUrl: string): {
  type: "image_url";
  image_url: { url: string; detail?: "high" };
} {
  return {
    type: "image_url",
    image_url: isGeminiBaseUrl(baseUrl) ? { url } : { url, detail: "high" },
  };
}

export function timeoutForBaseUrl(baseUrl: string): number {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === "api.x.ai" || host.endsWith(".x.ai") || isGeminiBaseUrl(baseUrl)) {
      return XAI_AI_TIMEOUT_MS;
    }
  } catch {
    // Unparseable settings fall back to the shorter default.
  }
  return AI_TIMEOUT_MS;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Best-effort upstream body for logs and analysis_jobs.message, with secrets removed. */
export function describeUpstreamAiError(error: unknown): {
  upstreamStatus?: number;
  upstreamCode?: string;
  message: string;
} {
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : null;
  const upstreamStatus = typeof record?.status === "number" ? record.status : undefined;
  const rawUpstreamCode = readString(record?.code) || readString(record?.type);
  const upstreamCode = isSafeProviderErrorCode(rawUpstreamCode) ? rawUpstreamCode : undefined;

  let detail = "";
  const nested = record?.error;
  if (typeof nested === "string") detail = nested;
  else if (typeof nested === "object" && nested !== null) {
    const nestedRecord = nested as Record<string, unknown>;
    detail = readString(nestedRecord.message) || readString(nestedRecord.code);
  }
  if (!detail) detail = readString(record?.message);
  if (!detail && typeof error === "string") detail = error;

  detail = redactAiSecrets(detail).replace(/\s+/gu, " ").trim();
  if (detail.length > UPSTREAM_DETAIL_LIMIT) detail = `${detail.slice(0, UPSTREAM_DETAIL_LIMIT)}…`;

  const base = "AI 服务请求失败";
  const message = detail && detail !== base ? `${base}：${detail}` : base;
  return { upstreamStatus, upstreamCode, message };
}
