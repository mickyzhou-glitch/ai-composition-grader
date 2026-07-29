import { describe, expect, it, vi } from "vitest";

import { D1LoginChallengeRepository } from "./d1-login-challenge-repository";

describe("D1LoginChallengeRepository", () => {
  it("uses one conditional UPDATE ... RETURNING statement to consume a challenge", async () => {
    const first = vi.fn().mockResolvedValue(null);
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const repository = new D1LoginChallengeRepository(
      { prepare } as never,
      () => new Date("2026-07-29T00:00:00.000Z"),
    );

    await expect(repository.consumeIfActive("login-1", "a".repeat(64))).resolves.toBeNull();
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("consumed_at IS NULL"));
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("RETURNING"));
  });
});
