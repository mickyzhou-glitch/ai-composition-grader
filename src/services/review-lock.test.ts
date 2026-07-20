// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { InMemoryReviewLock } from "./review-lock";

describe("InMemoryReviewLock", () => {
  it("串行化同一 review 的操作", async () => {
    const lock = new InMemoryReviewLock();
    const events: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = lock.runExclusive("review-1", async () => {
      events.push("first:start");
      await gate;
      events.push("first:end");
    });
    const second = lock.runExclusive("review-1", async () => {
      events.push("second");
    });
    await vi.waitFor(() => expect(events).toEqual(["first:start"]));

    expect(events).toEqual(["first:start"]);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });
});
