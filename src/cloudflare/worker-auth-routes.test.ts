import { describe, expect, it, vi } from "vitest";

import { handleWorkerAuth } from "./worker-auth-routes";

const challenge = {
  id: "login-1", normalizedUsername: "teacher-1", salt: "c2FsdA", nonce: "bm9uY2U",
  ipHash: "a".repeat(64), expiresAt: new Date("2026-07-29T00:05:00.000Z"), consumedAt: null,
  createdAt: new Date("2026-07-29T00:00:00.000Z"),
};

describe("worker auth routes", () => {
  it("issues a challenge without exposing whether the account exists", async () => {
    const create = vi.fn().mockResolvedValue(challenge);
    const response = await handleWorkerAuth(new Request("https://grader.workers.dev/api/auth/login/challenge", {
      method: "POST",
      headers: { origin: "https://grader.workers.dev", "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify({ username: "teacher-1" }),
    }), {
      appOrigin: "https://grader.workers.dev",
      ipHmacSecret: "secret",
      proofs: { findByUsername: vi.fn().mockResolvedValue(null) },
      challenges: { create, consumeIfActive: vi.fn() },
      randomNonce: () => "bm9uY2U",
    });

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ ok: true, data: {
      id: "login-1", salt: "c2FsdA", nonce: "bm9uY2U", expiresAt: "2026-07-29T00:05:00.000Z",
    } });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ normalizedUsername: "teacher-1", ttlMs: 300_000 }));
  });

  it("rejects cross-origin challenge creation", async () => {
    const response = await handleWorkerAuth(new Request("https://grader.workers.dev/api/auth/login/challenge", {
      method: "POST", headers: { origin: "https://evil.example", "cf-connecting-ip": "203.0.113.7" }, body: "{}",
    }), {
      appOrigin: "https://grader.workers.dev", ipHmacSecret: "secret",
      proofs: { findByUsername: vi.fn() }, challenges: { create: vi.fn(), consumeIfActive: vi.fn() }, randomNonce: () => "bm9uY2U",
    });

    expect(response?.status).toBe(403);
  });
});
