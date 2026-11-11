import { describe, expect, it, vi } from "vitest";

import { createWorkerOpenAIClient } from "./worker-openai-client";
import { completionWithFinish } from "../ai/adapter-shared";

describe("createWorkerOpenAIClient", () => {
  it.each(["AbortError", "TimeoutError"])("读取200响应正文时的%s仍归为超时", async (name) => {
    const response = new Response("{}", { status: 200 });
    vi.spyOn(response, "json").mockRejectedValue(Object.assign(new Error("body interrupted"), { name }));
    vi.stubGlobal("fetch", vi.fn(async () => response));
    try {
      const client = createWorkerOpenAIClient({ apiKey: "key", baseURL: "https://gateway.test/v1", timeout: 180_000, maxRetries: 1 });
      await expect(completionWithFinish(client, {})).rejects.toMatchObject({ code: "AI_REQUEST_FAILED", upstreamCode: "request_timeout" });
    } finally { vi.unstubAllGlobals(); }
  });
  it("200 响应信封损坏时返回专门错误，区别于传输故障", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not JSON", { status: 200 })));
    try {
      const client = createWorkerOpenAIClient({ apiKey: "key", baseURL: "https://gateway.test/v1", timeout: 180_000, maxRetries: 1 });
      await expect(client.chat.completions.create({})).rejects.toMatchObject({ code: "AI_INVALID_RESPONSE", upstreamCode: "response_envelope" });
    } finally { vi.unstubAllGlobals(); }
  });
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
});
