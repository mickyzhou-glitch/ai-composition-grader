import { describe, expect, it, vi } from "vitest";

import { handleWorkerAuth } from "./worker-auth-routes";
import { createLoginProof, sealPasswordVerifier } from "../auth/password-proof-worker";
import { toBase64Url } from "../auth/password-proof";
import { hashPassword } from "../auth/password";

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

  it("issues a strict host-only session cookie after a valid proof", async () => {
    const encryptionKey = new Uint8Array(32).fill(9);
    const verifier = new Uint8Array(32).fill(7);
    const sealed = await sealPasswordVerifier(verifier, encryptionKey);
    const create = vi.fn();
    const response = await handleWorkerAuth(new Request("https://grader.workers.dev/api/auth/login/complete", {
      method: "POST", headers: { origin: "https://grader.workers.dev", "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify({ challengeId: "login-1", proof: await createLoginProof(verifier, "login-1", "nonce-a") }),
    }), {
      appOrigin: "https://grader.workers.dev", ipHmacSecret: "secret", proofEncryptionKey: toBase64Url(encryptionKey),
      proofs: { findByUsername: vi.fn().mockResolvedValue({ user: { id: "u1", username: "teacher-1", role: "teacher", mustChangePassword: false }, disabledAt: null, salt: "c2FsdA", sealed }) },
      challenges: { create: vi.fn(), consumeIfActive: vi.fn().mockResolvedValue({ ...challenge, nonce: "nonce-a" }) },
      sessions: { create, findActiveByTokenHash: vi.fn(), revokeByTokenHash: vi.fn() }, randomNonce: () => "bm9uY2U",
    });

    expect(response?.status).toBe(200);
    expect(response?.headers.get("set-cookie")).toContain("__Host-zuowen_session=");
    expect(response?.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response?.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(create).toHaveBeenCalledOnce();
  });

  it("returns the active user from the host-only session cookie", async () => {
    const response = await handleWorkerAuth(new Request("https://grader.workers.dev/api/auth/me", {
      headers: { cookie: "__Host-zuowen_session=token" },
    }), {
      appOrigin: "https://grader.workers.dev", ipHmacSecret: "secret",
      proofs: { findByUsername: vi.fn() }, challenges: { create: vi.fn(), consumeIfActive: vi.fn() },
      sessions: { create: vi.fn(), revokeByTokenHash: vi.fn(), findActiveByTokenHash: vi.fn().mockResolvedValue({ user: { id: "u1", username: "teacher-1", role: "teacher", mustChangePassword: false } }) },
    });

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({ ok: true, data: { username: "teacher-1" } });
  });

  it("upgrades a valid legacy password login to a sealed browser proof", async () => {
    const passwordHash = await hashPassword("legacy-password");
    const digest = passwordHash.split("$").at(-1)!;
    const digestBytes = Uint8Array.from(atob(digest), (character) => character.charCodeAt(0));
    const legacyUser = { user: { id: "u1", username: "teacher-1", role: "teacher" as const, mustChangePassword: false }, disabledAt: null, passwordHash };
    const create = vi.fn();
    const save = vi.fn();
    const encryptionKey = new Uint8Array(32).fill(3);
    const challengeResponse = await handleWorkerAuth(new Request("https://grader.workers.dev/api/auth/login/legacy/challenge", {
      method: "POST", headers: { origin: "https://grader.workers.dev", "cf-connecting-ip": "203.0.113.7" }, body: JSON.stringify({ username: "teacher-1" }),
    }), {
      appOrigin: "https://grader.workers.dev", ipHmacSecret: "secret", proofEncryptionKey: toBase64Url(encryptionKey),
      proofs: { findByUsername: vi.fn(), findLegacyByUsername: vi.fn().mockResolvedValue(legacyUser), save },
      challenges: { create: vi.fn().mockResolvedValue(challenge), consumeIfActive: vi.fn().mockResolvedValue(challenge) },
      sessions: { create, findActiveByTokenHash: vi.fn(), revokeByTokenHash: vi.fn() },
    });
    expect(challengeResponse?.status).toBe(200);
    const newVerifier = new Uint8Array(32).fill(8);
    const completeResponse = await handleWorkerAuth(new Request("https://grader.workers.dev/api/auth/login/legacy/complete", {
      method: "POST", headers: { origin: "https://grader.workers.dev", "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify({ challengeId: challenge.id, proof: await createLoginProof(digestBytes, challenge.id, challenge.nonce), verifier: toBase64Url(newVerifier) }),
    }), {
      appOrigin: "https://grader.workers.dev", ipHmacSecret: "secret", proofEncryptionKey: toBase64Url(encryptionKey),
      proofs: { findByUsername: vi.fn(), findLegacyByUsername: vi.fn().mockResolvedValue(legacyUser), save },
      challenges: { create: vi.fn(), consumeIfActive: vi.fn().mockResolvedValue(challenge) },
      sessions: { create, findActiveByTokenHash: vi.fn(), revokeByTokenHash: vi.fn() },
    });

    expect(completeResponse?.status).toBe(200);
    expect(save).toHaveBeenCalledWith("u1", challenge.salt, expect.any(Object), expect.any(Date));
    expect(create).toHaveBeenCalledOnce();
  });
});
