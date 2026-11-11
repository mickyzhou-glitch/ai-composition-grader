import { afterEach, describe, expect, it, vi } from "vitest";

import { createWorkerOpenAIClient } from "./worker-openai-client";

describe("createWorkerOpenAIClient", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each([429, 503])("等待 Retry-After 后重试临时错误 %s", async (status) => {
    vi.useFakeTimers();
    const payload = { choices: [{ message: { content: "批改完成" } }] };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { code: "busy" } }, { status, headers: { "retry-after": "30" } }))
      .mockResolvedValueOnce(Response.json(payload));
    vi.stubGlobal("fetch", fetchMock);
    const client = createWorkerOpenAIClient({ apiKey: "key", baseURL: "https://gateway.test/v1", timeout: 180_000, maxRetries: 1 });
    const pending = expect(client.chat.completions.create({ model: "content", messages: [] })).resolves.toEqual(payload);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]?.body).toBe(fetchMock.mock.calls[0][1]?.body);
  });

  it("持续限流只重试配置次数，保留安全错误码", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "rate_limit_exceeded" } }, { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createWorkerOpenAIClient({ apiKey: "key", baseURL: "https://gateway.test/v1", timeout: 180_000, maxRetries: 1 });
    const pending = expect(client.chat.completions.create({})).rejects.toMatchObject({ status: 429, code: "rate_limit_exceeded" });
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 402, 403])("权限或参数错误 %s 不重试", async (status) => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "rejected" } }, { status }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createWorkerOpenAIClient({ apiKey: "key", baseURL: "https://gateway.test/v1", timeout: 180_000, maxRetries: 1 });
    await expect(client.chat.completions.create({})).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maxRetries 为零时不重试 429", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("busy", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createWorkerOpenAIClient({ apiKey: "key", baseURL: "https://gateway.test/v1", timeout: 180_000, maxRetries: 0 });
    await expect(client.chat.completions.create({})).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("支持 HTTP 日期格式的 Retry-After", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T08:00:00Z"));
    const payload = { choices: [] };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 429, headers: { "retry-after": "Wed, 28 Oct 2026 08:00:45 GMT" } }))
      .mockResolvedValueOnce(Response.json(payload));
    vi.stubGlobal("fetch", fetchMock);
    const client = createWorkerOpenAIClient({ apiKey: "key", baseURL: "https://gateway.test/v1", timeout: 180_000, maxRetries: 1 });
    const pending = client.chat.completions.create({});
    await vi.advanceTimersByTimeAsync(44_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual(payload);
  });

  it("上游要求等待超过一分钟时不会提前重试", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("busy", { status: 429, headers: { "retry-after": "120" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createWorkerOpenAIClient({ apiKey: "key", baseURL: "https://gateway.test/v1", timeout: 180_000, maxRetries: 1 });
    await expect(client.chat.completions.create({})).rejects.toMatchObject({ status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("无效 Retry-After 使用限流退避，第二次等待更长", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("busy", { status: 429, headers: { "retry-after": "invalid" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createWorkerOpenAIClient({ apiKey: "key", baseURL: "https://gateway.test/v1", timeout: 180_000, maxRetries: 2 });
    const pending = expect(client.chat.completions.create({})).rejects.toMatchObject({ status: 429 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
