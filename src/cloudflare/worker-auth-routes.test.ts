import { describe, expect, it, vi } from "vitest";

import { handleWorkerAuth } from "./worker-auth-routes";
import { createLoginProof, sealPasswordVerifier } from "../auth/password-proof-worker";
import { fromBase64Url, toBase64Url } from "../auth/password-proof";
import { hashPassword } from "../auth/password";
import type { LegacyPasswordParameters } from "../auth/legacy-password-proof-browser";

const challenge = {
  id: "login-1", normalizedUsername: "teacher-1", salt: "c2FsdA", nonce: "bm9uY2U",
  ipHash: "a".repeat(64), expiresAt: new Date("2026-07-29T00:05:00.000Z"), consumedAt: null,
  createdAt: new Date("2026-07-29T00:00:00.000Z"),
};

const authUser = { id: "u1", username: "teacher-1", role: "teacher" as const, mustChangePassword: false };
const modernProof = {
  user: authUser,
  disabledAt: null,
  salt: toBase64Url(new Uint8Array(16).fill(1)),
  sealed: { ciphertext: "ciphertext", iv: "iv", version: 1 as const },
};

function challengeRepository() {
  return {
    create: vi.fn(async (input: {
      normalizedUsername: string;
      salt: string;
      nonce: string;
      ipHash: string;
      ttlMs: number;
    }) => ({
      ...challenge,
      normalizedUsername: input.normalizedUsername,
      salt: input.salt,
      nonce: input.nonce,
      ipHash: input.ipHash,
    })),
    consumeIfActive: vi.fn(),
  };
}

describe("worker auth routes", () => {
  it("labels a modern password-proof challenge without reading the legacy hash", async () => {
    const challenges = challengeRepository();
    const findLegacyByUsername = vi.fn();
    const response = await handleWorkerAuth(new Request("https://grader.workers.dev/api/auth/login/challenge", {
      method: "POST",
      headers: { origin: "https://grader.workers.dev", "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify({ username: "teacher-1" }),
    }), {
      appOrigin: "https://grader.workers.dev",
      ipHmacSecret: "secret",
      proofs: { findByUsername: vi.fn().mockResolvedValue(modernProof), findLegacyByUsername },
      challenges,
      randomNonce: () => "bm9uY2U",
    });

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ ok: true, data: {
      id: "login-1", mode: "proof", salt: modernProof.salt, nonce: "bm9uY2U", expiresAt: "2026-07-29T00:05:00.000Z",
    } });
    expect(findLegacyByUsername).not.toHaveBeenCalled();
    expect(challenges.create).toHaveBeenCalledWith(expect.objectContaining({ normalizedUsername: "teacher-1", ttlMs: 300_000 }));
  });

  it("returns legacy parameters in the first challenge for an account without a modern proof", async () => {
    const passwordHash = await hashPassword("legacy-password");
    const legacyUser = { user: authUser, disabledAt: null, passwordHash };
    const challenges = challengeRepository();
    const findByUsername = vi.fn().mockResolvedValue(null);
    const findLegacyByUsername = vi.fn().mockResolvedValue(legacyUser);
    const findLoginCandidateByUsername = vi.fn().mockResolvedValue({ proof: null, legacy: legacyUser });
    const response = await handleWorkerAuth(new Request("https://grader.workers.dev/api/auth/login/challenge", {
      method: "POST",
      headers: { origin: "https://grader.workers.dev", "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify({ username: "teacher-1" }),
    }), {
      appOrigin: "https://grader.workers.dev",
      ipHmacSecret: "secret",
      proofs: {
        findByUsername,
        findLegacyByUsername,
        findLoginCandidateByUsername,
      },
      challenges,
      randomNonce: () => "bm9uY2U",
    });

    expect(response?.status).toBe(200);
    const payload = await response?.json() as { data: { mode: string; salt: string; legacy: LegacyPasswordParameters } };
    expect(payload.data).toMatchObject({
      mode: "legacy",
      legacy: { memorySize: 65_536, iterations: 3, parallelism: 4, hashLength: 32 },
    });
    expect(payload.data.salt).toBe(payload.data.legacy.salt);
    expect(fromBase64Url(payload.data.salt)).toHaveLength(16);
    expect(findLoginCandidateByUsername).toHaveBeenCalledWith("teacher-1");
    expect(findByUsername).not.toHaveBeenCalled();
    expect(findLegacyByUsername).not.toHaveBeenCalled();
  });

  it("uses a stable secret-derived challenge profile for an unknown account", async () => {
    const issue = async (username: string) => {
      const response = await handleWorkerAuth(new Request("https://grader.workers.dev/api/auth/login/challenge", {
        method: "POST",
        headers: { origin: "https://grader.workers.dev", "cf-connecting-ip": "203.0.113.7" },
        body: JSON.stringify({ username }),
      }), {
        appOrigin: "https://grader.workers.dev",
        ipHmacSecret: "secret",
        proofs: {
          findByUsername: vi.fn().mockResolvedValue(null),
          findLegacyByUsername: vi.fn().mockResolvedValue(null),
        },
        challenges: challengeRepository(),
        randomNonce: () => "bm9uY2U",
      });
      return await response?.json() as { data: { mode: "proof" | "legacy"; salt: string; legacy?: LegacyPasswordParameters } };
    };

    const first = await issue("unknown-user");
    const repeated = await issue("unknown-user");
    const other = await issue("other-unknown-user");

    expect(repeated.data).toEqual(first.data);
    expect(fromBase64Url(first.data.salt)).toHaveLength(16);
    expect(other.data.salt).not.toBe(first.data.salt);
    if (first.data.mode === "legacy") expect(first.data.legacy?.salt).toBe(first.data.salt);
    else expect(first.data.legacy).toBeUndefined();
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
    const saveIfMissing = vi.fn().mockResolvedValue(true);
    const encryptionKey = new Uint8Array(32).fill(3);
    const challengeResponse = await handleWorkerAuth(new Request("https://grader.workers.dev/api/auth/login/legacy/challenge", {
      method: "POST", headers: { origin: "https://grader.workers.dev", "cf-connecting-ip": "203.0.113.7" }, body: JSON.stringify({ username: "teacher-1" }),
    }), {
      appOrigin: "https://grader.workers.dev", ipHmacSecret: "secret", proofEncryptionKey: toBase64Url(encryptionKey),
      proofs: { findByUsername: vi.fn().mockResolvedValue(null), findLegacyByUsername: vi.fn().mockResolvedValue(legacyUser), save, saveIfMissing },
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
      proofs: { findByUsername: vi.fn().mockResolvedValue(null), findLegacyByUsername: vi.fn().mockResolvedValue(legacyUser), save, saveIfMissing },
      challenges: { create: vi.fn(), consumeIfActive: vi.fn().mockResolvedValue(challenge) },
      sessions: { create, findActiveByTokenHash: vi.fn(), revokeByTokenHash: vi.fn() },
    });

    expect(completeResponse?.status).toBe(200);
    expect(saveIfMissing).toHaveBeenCalledWith("u1", challenge.salt, expect.any(Object), expect.any(Date));
    expect(save).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
  });

  it("returns a dummy legacy challenge after the account has a modern proof", async () => {
    const challenges = challengeRepository();
    const passwordHash = await hashPassword("old-password");
    const realLegacySalt = toBase64Url(Uint8Array.from(atob(passwordHash.split("$").at(-2)!), (character) => character.charCodeAt(0)));
    const legacyUser = { user: authUser, disabledAt: null, passwordHash };
    const findLoginCandidateByUsername = vi.fn().mockResolvedValue({ proof: modernProof, legacy: legacyUser });
    const response = await handleWorkerAuth(new Request("https://grader.workers.dev/api/auth/login/legacy/challenge", {
      method: "POST",
      headers: { origin: "https://grader.workers.dev", "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify({ username: "teacher-1" }),
    }), {
      appOrigin: "https://grader.workers.dev",
      ipHmacSecret: "secret",
      proofEncryptionKey: toBase64Url(new Uint8Array(32).fill(3)),
      proofs: {
        findByUsername: vi.fn().mockResolvedValue(modernProof),
        findLegacyByUsername: vi.fn().mockResolvedValue(legacyUser),
        findLoginCandidateByUsername,
        save: vi.fn(),
      },
      challenges,
      sessions: { create: vi.fn(), findActiveByTokenHash: vi.fn(), revokeByTokenHash: vi.fn() },
      randomNonce: () => "bm9uY2U",
    });

    expect(response?.status).toBe(200);
    const payload = await response?.json() as { data: { legacy: LegacyPasswordParameters } };
    expect(payload).toMatchObject({
      ok: true,
      data: {
        id: "login-1",
        nonce: "bm9uY2U",
        legacy: { memorySize: 65_536, iterations: 3, parallelism: 4, hashLength: 32 },
      },
    });
    expect(fromBase64Url(payload.data.legacy.salt)).toHaveLength(16);
    expect(payload.data.legacy.salt).toBe(modernProof.salt);
    expect(payload.data.legacy.salt).not.toBe(realLegacySalt);
    expect(findLoginCandidateByUsername).toHaveBeenCalledWith("teacher-1");
    expect(challenges.create).toHaveBeenCalledOnce();
  });

  it("rejects a legacy completion when another request creates the modern proof first", async () => {
    const passwordHash = await hashPassword("legacy-password");
    const digest = passwordHash.split("$").at(-1)!;
    const digestBytes = Uint8Array.from(atob(digest), (character) => character.charCodeAt(0));
    const create = vi.fn();
    const save = vi.fn();
    const saveIfMissing = vi.fn().mockResolvedValue(false);
    const response = await handleWorkerAuth(new Request("https://grader.workers.dev/api/auth/login/legacy/complete", {
      method: "POST",
      headers: { origin: "https://grader.workers.dev", "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify({
        challengeId: challenge.id,
        proof: await createLoginProof(digestBytes, challenge.id, challenge.nonce),
        verifier: toBase64Url(new Uint8Array(32).fill(8)),
      }),
    }), {
      appOrigin: "https://grader.workers.dev",
      ipHmacSecret: "secret",
      proofEncryptionKey: toBase64Url(new Uint8Array(32).fill(3)),
      proofs: {
        findByUsername: vi.fn().mockResolvedValue(null),
        findLegacyByUsername: vi.fn().mockResolvedValue({ user: authUser, disabledAt: null, passwordHash }),
        save,
        saveIfMissing,
      },
      challenges: { create: vi.fn(), consumeIfActive: vi.fn().mockResolvedValue(challenge) },
      sessions: { create, findActiveByTokenHash: vi.fn(), revokeByTokenHash: vi.fn() },
    });

    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toMatchObject({ ok: false, error: { code: "INVALID_CREDENTIALS" } });
    expect(saveIfMissing).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a valid old-password completion after the account has a modern proof", async () => {
    const passwordHash = await hashPassword("old-password");
    const digest = passwordHash.split("$").at(-1)!;
    const digestBytes = Uint8Array.from(atob(digest), (character) => character.charCodeAt(0));
    const save = vi.fn();
    const create = vi.fn();
    const response = await handleWorkerAuth(new Request("https://grader.workers.dev/api/auth/login/legacy/complete", {
      method: "POST",
      headers: { origin: "https://grader.workers.dev", "cf-connecting-ip": "203.0.113.7" },
      body: JSON.stringify({
        challengeId: challenge.id,
        proof: await createLoginProof(digestBytes, challenge.id, challenge.nonce),
        verifier: toBase64Url(new Uint8Array(32).fill(8)),
      }),
    }), {
      appOrigin: "https://grader.workers.dev",
      ipHmacSecret: "secret",
      proofEncryptionKey: toBase64Url(new Uint8Array(32).fill(3)),
      proofs: {
        findByUsername: vi.fn().mockResolvedValue(modernProof),
        findLegacyByUsername: vi.fn().mockResolvedValue({ user: authUser, disabledAt: null, passwordHash }),
        save,
        saveIfMissing: vi.fn().mockResolvedValue(false),
      },
      challenges: { create: vi.fn(), consumeIfActive: vi.fn().mockResolvedValue(challenge) },
      sessions: { create, findActiveByTokenHash: vi.fn(), revokeByTokenHash: vi.fn() },
    });

    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toMatchObject({ ok: false, error: { code: "INVALID_CREDENTIALS" } });
    expect(save).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
