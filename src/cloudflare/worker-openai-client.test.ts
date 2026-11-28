import { describe, expect, it, vi } from "vitest";

import { createWorkerOpenAIClient } from "./worker-openai-client";

describe("createWorkerOpenAIClient", () => {
  it("只发送 OpenAI 兼容网关所需的认证与 JSON 请求头", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "{}" } }],
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createWorkerOpenAIClient({ apiKey: "server-key", baseURL: "http://gateway.test/v1", timeout: 1, maxRetries: 1 });
    await expect(client.chat.completions.create({ model: "vision-model", messages: [] })).resolves.toEqual({
      choices: [{ message: { content: "{}" } }],
    });

    expect(fetchMock).toHaveBeenCalledWith("http://gateway.test/v1/chat/completions", expect.objectContaining({
      method: "POST",
      headers: { authorization: "Bearer server-key", "content-type": "application/json" },
    }));
    vi.unstubAllGlobals();
  });

  it("为 MiMo Chat Completions 同时带上官方 api-key 认证头", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "{}" } }],
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createWorkerOpenAIClient({ apiKey: "mimo-key", baseURL: "https://api.xiaomimimo.com/v1", timeout: 1, maxRetries: 1 });
    await client.chat.completions.create({ model: "mimo-v2.5", messages: [] });

    expect(fetchMock).toHaveBeenCalledWith("https://api.xiaomimimo.com/v1/chat/completions", expect.objectContaining({
      headers: {
        authorization: "Bearer mimo-key",
        "content-type": "application/json",
        "api-key": "mimo-key",
      },
    }));
    vi.unstubAllGlobals();
  });

  it("失败响应带上状态、错误码和上游说明，供批改任务展示原因", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { message: "Unknown model grok-4.7", type: "invalid_request_error" },
    }), { status: 400, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createWorkerOpenAIClient({ apiKey: "server-key", baseURL: "https://api.x.ai/v1", timeout: 900_000, maxRetries: 1 });
    await expect(client.chat.completions.create({ model: "grok-4.7", messages: [] })).rejects.toMatchObject({
      message: "AI upstream request failed",
      status: 400,
      code: "invalid_request_error",
      error: { message: "Unknown model grok-4.7" },
    });
    vi.unstubAllGlobals();
  });

  it("交给适配器之前去掉上游说明里的密钥", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { message: "bad Bearer sk-abcdefghijklmnop xai-SecretKey123456", code: "invalid_request_error" },
    }), { status: 401, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createWorkerOpenAIClient({ apiKey: "server-key", baseURL: "https://api.x.ai/v1", timeout: 900_000, maxRetries: 1 });
    const error = await client.chat.completions.create({ model: "grok-4.7", messages: [] }).then(() => {
      throw new Error("expected upstream failure");
    }, (reason: unknown) => reason) as { error?: { message?: string } };
    expect(error.error?.message).toContain("[密钥]");
    expect(error.error?.message).not.toContain("sk-abcdefghijklmnop");
    expect(error.error?.message).not.toContain("xai-SecretKey123456");
    vi.unstubAllGlobals();
  });

  it("把客户端超时时间传给上游 fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "{}" } }],
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createWorkerOpenAIClient({ apiKey: "server-key", baseURL: "https://gateway.test/v1", timeout: 180_000, maxRetries: 1 });
    await client.chat.completions.create({ model: "content-model", messages: [] });

    const init = fetchMock.mock.calls[0][1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    vi.unstubAllGlobals();
  });

  it("遇到 429 或 503 临时故障时按 maxRetries 自动重试，400 参数错误不重试", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "0" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "{\"ok\":true}" } }],
      }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createWorkerOpenAIClient({ apiKey: "server-key", baseURL: "https://gateway.test/v1", timeout: 10, maxRetries: 1 });
    await expect(client.chat.completions.create({ model: "content-model", messages: [] })).resolves.toEqual({
      choices: [{ message: { content: "{\"ok\":true}" } }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "bad request" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));
    await expect(client.chat.completions.create({ model: "content-model", messages: [] })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("解析 Gemini OpenAI 兼容端点返回的数组包裹错误对象并脱敏 AIza 密钥", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify([{
      error: {
        code: 403,
        message: "API key AIzaSyD1234567890abcdefghijklmno_pqrstuv lacks permission",
        status: "PERMISSION_DENIED",
      },
    }]), { status: 403, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createWorkerOpenAIClient({
      apiKey: "gemini-key",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      timeout: 240_000,
      maxRetries: 0,
    });
    await expect(client.chat.completions.create({ model: "gemini-4-carbon", messages: [] })).rejects.toMatchObject({
      status: 403,
      code: "PERMISSION_DENIED",
      error: { message: "API key [密钥] lacks permission" },
    });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{
      error: {
        code: "AIzaSyD1234567890abcdefghijklmno_pqrstuv",
        message: "Invalid credential custom-unprefixed-secret-value",
      },
    }]), { status: 401, headers: { "content-type": "application/json" } }));
    const customClient = createWorkerOpenAIClient({
      apiKey: "custom-unprefixed-secret-value",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      timeout: 240_000,
      maxRetries: 0,
    });
    await expect(customClient.chat.completions.create({ model: "gemini-4-carbon", messages: [] })).rejects.toMatchObject({
      status: 401,
      code: undefined,
      error: { message: "Invalid credential [密钥]" },
    });
    vi.unstubAllGlobals();
  });
});
