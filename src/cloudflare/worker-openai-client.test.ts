import { describe, expect, it, vi } from "vitest";

import { createWorkerOpenAIClient } from "./worker-openai-client";

describe("createWorkerOpenAIClient", () => {
  it("只发送 OpenAI 兼容网关所需的认证与 JSON 请求头", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
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
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
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

  it("把客户端超时时间传给上游 fetch", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "{}" } }],
    }), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createWorkerOpenAIClient({ apiKey: "server-key", baseURL: "https://gateway.test/v1", timeout: 180_000, maxRetries: 1 });
    await client.chat.completions.create({ model: "content-model", messages: [] });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    vi.unstubAllGlobals();
  });
});
