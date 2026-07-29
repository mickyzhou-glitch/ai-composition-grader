import { describe, expect, it, vi } from "vitest";

const { argon2id } = vi.hoisted(() => ({ argon2id: vi.fn() }));

vi.mock("hash-wasm", () => ({ argon2id }));

import { createBrowserLoginProof } from "./password-proof-browser";

describe("browser password proof", () => {
  it("derives an Argon2id verifier locally and returns only a challenge-bound proof", async () => {
    argon2id.mockResolvedValue(new Uint8Array(32).fill(7));

    const proof = await createBrowserLoginProof({
      password: "never-send-this",
      salt: "c2FsdA",
      challengeId: "login-1",
      nonce: "nonce-a",
    });

    expect(argon2id).toHaveBeenCalledWith(expect.objectContaining({
      password: "never-send-this",
      outputType: "binary",
      parallelism: 1,
      hashLength: 32,
    }));
    expect(proof).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
