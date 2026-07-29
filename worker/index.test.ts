import { describe, expect, it } from "vitest";

import worker from "./index";

describe("Cloudflare Worker", () => {
  it("answers the unauthenticated health endpoint without requiring secrets", async () => {
    const response = await worker.fetch(
      new Request("https://grader.workers.dev/api/health"),
      { ASSETS: { fetch: async () => new Response("asset") } } as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, data: { status: "ok" } });
  });
});
