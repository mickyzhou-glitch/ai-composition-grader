/**
 * Produces the smallest authentication header set accepted by the configured
 * OpenAI-compatible provider. MiMo documents `api-key` for Chat Completions;
 * it also accepts Bearer authentication, which we retain for compatibility
 * with the rest of the application and generic gateways.
 */
export function aiRequestHeaders(baseUrl: string, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  try {
    if (new URL(baseUrl).hostname === "api.xiaomimimo.com") {
      headers["api-key"] = apiKey;
    }
  } catch {
    // The caller validates configured URLs. Keep this utility safe for tests
    // and for any future generic OpenAI-compatible endpoint.
  }
  return headers;
}
