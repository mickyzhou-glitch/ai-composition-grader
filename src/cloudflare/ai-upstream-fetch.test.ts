import { describe, expect, it, vi } from "vitest";

import { fetchAiUpstream } from "./ai-upstream-fetch";

describe("fetchAiUpstream", () => {
  it("通过 TCP 向 IP 地址发送带认证的请求并解析分块响应", async () => {
    const writes: Uint8Array[] = [];
    const responseBytes = new TextEncoder().encode(
      "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n" +
      "1c\r\n{\"choices\":[{\"message\":{}}]}\r\n0\r\n\r\n",
    );
    const connect = vi.fn(() => ({
      opened: Promise.resolve({ remoteAddress: "47.77.214.208" }),
      readable: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(responseBytes); controller.close(); } }),
      writable: new WritableStream<Uint8Array>({ write(chunk) { writes.push(chunk); } }),
      close: vi.fn(async () => {}),
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unexpected fetch", { status: 502 })));

    const response = await fetchAiUpstream(
      "http://47.77.214.208:3002/v1/chat/completions",
      {
        method: "POST",
        headers: { authorization: "Bearer secret-key", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-6.1-sol", messages: [] }),
      },
      connect,
    );

    expect(connect).toHaveBeenCalledWith({ hostname: "47.77.214.208", port: 3002 }, { allowHalfOpen: true });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ choices: [{ message: {} }] });
    const sent = new TextDecoder().decode(writes[0]);
    expect(sent).toContain("POST /v1/chat/completions HTTP/1.1\r\n");
    expect(sent).toContain("host: 47.77.214.208:3002\r\n");
    expect(sent).toContain("authorization: Bearer secret-key\r\n");
    expect(sent).toContain("\r\n\r\n{\"model\":\"gpt-6.1-sol\"");
  });
});
