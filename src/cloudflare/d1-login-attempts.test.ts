// @vitest-environment node
import { describe, expect, it } from "vitest";

import { d1Shim, migratedDatabase } from "../../test/d1-sqlite-shim";
import {
  CHALLENGE_IP_BURST_LIMIT,
  D1LoginAttemptRepository,
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_IP_FAILURE_LIMIT,
  LOGIN_USERNAME_FAILURE_LIMIT,
} from "./d1-login-attempts";

describe("D1LoginAttemptRepository", () => {
  it("locks username after consecutive failures, resets on success, and unlocks after the window", async () => {
    const sqlite = migratedDatabase();
    try {
      let now = 1_790_000_000_000;
      const repo = new D1LoginAttemptRepository(d1Shim(sqlite), () => now);
      const ip = "a".repeat(64);

      for (let i = 0; i < LOGIN_USERNAME_FAILURE_LIMIT - 1; i += 1) {
        await repo.record("teacher-1", ip, false);
        now += 1_000;
      }
      expect(await repo.isRateLimited("teacher-1", ip)).toBe(false);

      await repo.record("teacher-1", ip, false);
      expect(await repo.isRateLimited("teacher-1", ip)).toBe(true);
      expect(await repo.isRateLimited("teacher-2", ip)).toBe(false);

      // A successful login resets consecutive failures immediately
      now += 1_000;
      await repo.record("teacher-1", ip, true);
      expect(await repo.isRateLimited("teacher-1", ip)).toBe(false);

      // Failing again locks, and advancing past window unlocks
      for (let i = 0; i < LOGIN_USERNAME_FAILURE_LIMIT; i += 1) {
        now += 1_000;
        await repo.record("teacher-1", ip, false);
      }
      expect(await repo.isRateLimited("teacher-1", ip)).toBe(true);
      now += LOGIN_FAILURE_WINDOW_MS + 1;
      expect(await repo.isRateLimited("teacher-1", ip)).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it("locks an IP across usernames after hitting the IP failure threshold", async () => {
    const sqlite = migratedDatabase();
    try {
      let now = 1_790_000_000_000;
      const repo = new D1LoginAttemptRepository(d1Shim(sqlite), () => now);
      const ip = "b".repeat(64);

      for (let i = 0; i < LOGIN_IP_FAILURE_LIMIT; i += 1) {
        now += 100;
        await repo.record(`user-${i}`, ip, false);
      }
      expect(await repo.isRateLimited("fresh-user", ip)).toBe(true);
      expect(await repo.isRateLimited("fresh-user", "c".repeat(64))).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it("detects challenge bursts per IP", async () => {
    const sqlite = migratedDatabase();
    try {
      const now = 1_790_000_000_000;
      const repo = new D1LoginAttemptRepository(d1Shim(sqlite), () => now);
      const ip = "d".repeat(64);
      const insert = sqlite.prepare(`
        INSERT INTO login_challenges (id, normalized_username, salt, nonce, ip_hash, expires_at, consumed_at, created_at)
        VALUES (?, 'teacher-1', 'salt', 'nonce', ?, ?, NULL, ?)
      `);
      for (let i = 0; i < CHALLENGE_IP_BURST_LIMIT - 1; i += 1) {
        insert.run(`ch-${i}`, ip, now + 300_000, now - 1_000);
      }
      expect(await repo.isChallengeFlooded(ip)).toBe(false);

      insert.run("ch-last", ip, now + 300_000, now - 500);
      expect(await repo.isChallengeFlooded(ip)).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});
