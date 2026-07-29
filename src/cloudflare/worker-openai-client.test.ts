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
});
