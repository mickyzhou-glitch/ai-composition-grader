import { describe, expect, it } from "vitest";

import { GET } from "../../app/api/health/route";

describe("health route", () => {
  it("returns only the minimal up status", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, data: { status: "up" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
