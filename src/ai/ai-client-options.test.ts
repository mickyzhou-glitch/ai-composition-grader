import { describe, expect, it } from "vitest";

import {
  AI_TIMEOUT_MS,
  describeUpstreamAiError,
  timeoutForBaseUrl,
  XAI_AI_TIMEOUT_MS,
} from "./ai-client-options";

describe("timeoutForBaseUrl", () => {
  it("uses a longer timeout for api.x.ai and other x.ai hosts", () => {
    expect(timeoutForBaseUrl("https://api.x.ai/v1")).toBe(XAI_AI_TIMEOUT_MS);
    expect(timeoutForBaseUrl("https://api.x.ai/v1/")).toBe(XAI_AI_TIMEOUT_MS);
    expect(timeoutForBaseUrl("https://API.X.AI/v1")).toBe(XAI_AI_TIMEOUT_MS);
    expect(timeoutForBaseUrl("https://gateway.x.ai/v1")).toBe(XAI_AI_TIMEOUT_MS);
  });

  it("keeps the default timeout for other providers", () => {
    expect(timeoutForBaseUrl("https://api.deepseek.com")).toBe(AI_TIMEOUT_MS);
    expect(timeoutForBaseUrl("https://api.openai.com/v1")).toBe(AI_TIMEOUT_MS);
    expect(timeoutForBaseUrl("https://api.x.ai.evil.example/v1")).toBe(AI_TIMEOUT_MS);
    expect(timeoutForBaseUrl("https://notx.ai/v1")).toBe(AI_TIMEOUT_MS);
    expect(timeoutForBaseUrl("not-a-url")).toBe(AI_TIMEOUT_MS);
  });
});

describe("describeUpstreamAiError", () => {
  it("keeps nested upstream message, status, and code", () => {
    const described = describeUpstreamAiError({
      status: 400,
      code: "invalid_request_error",
      error: { message: "Model does not exist" },
    });
    expect(described.upstreamStatus).toBe(400);
    expect(described.upstreamCode).toBe("invalid_request_error");
    expect(described.message).toBe("AI 服务请求失败：Model does not exist");
  });

  it("redacts sk-, Bearer, and xai- secrets", () => {
    const described = describeUpstreamAiError({
      message: "Unauthorized Bearer sk-abcdefghijklmnop and xai-SecretKey123456",
    });
    expect(described.message).toContain("[密钥]");
    expect(described.message).not.toContain("sk-abcdefghijklmnop");
    expect(described.message).not.toContain("xai-SecretKey123456");
    expect(described.message).not.toMatch(/Bearer\s+\S/u);
  });

  it("drops unsafe upstream codes and keeps a generic message when there is no detail", () => {
    expect(describeUpstreamAiError({ status: 500, code: "has spaces", message: "AI 服务请求失败" })).toEqual({
      upstreamStatus: 500,
      upstreamCode: undefined,
      message: "AI 服务请求失败",
    });
    expect(describeUpstreamAiError({})).toEqual({
      upstreamStatus: undefined,
      upstreamCode: undefined,
      message: "AI 服务请求失败",
    });
  });
});
