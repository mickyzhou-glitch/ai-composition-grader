import { describe, expect, it } from "vitest";

import { InMemoryLoginChallengeRepository } from "./login-challenge-repository";

const IP_HASH = "a".repeat(64);

describe("login challenge repository", () => {
  it("consumes a challenge once and rejects expiry or a different IP hash", async () => {
    let now = new Date("2026-07-29T00:00:00.000Z");
    const repository = new InMemoryLoginChallengeRepository({
      now: () => now,
      createId: () => "login-1",
    });
    const challenge = await repository.create({
      normalizedUsername: "teacher-1",
      salt: "c2FsdA",
      nonce: "bm9uY2U",
      ipHash: IP_HASH,
      ttlMs: 5 * 60_000,
    });

    await expect(repository.consumeIfActive(challenge.id, "b".repeat(64))).resolves.toBeNull();
    await expect(repository.consumeIfActive(challenge.id, IP_HASH)).resolves.toMatchObject({ id: "login-1" });
    await expect(repository.consumeIfActive(challenge.id, IP_HASH)).resolves.toBeNull();

    const expired = await repository.create({
      normalizedUsername: "teacher-1", salt: "c2FsdA", nonce: "bm9uY2U", ipHash: IP_HASH, ttlMs: 1,
    });
    now = new Date(now.getTime() + 1);
    await expect(repository.consumeIfActive(expired.id, IP_HASH)).resolves.toBeNull();
  });
});
