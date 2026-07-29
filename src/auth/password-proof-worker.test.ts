import { describe, expect, it } from "vitest";

import { createLoginProof, sealPasswordVerifier, verifyLoginProof } from "./password-proof-worker";

describe("password proof worker", () => {
  it("accepts only the proof bound to the issued nonce", async () => {
    const verifier = new Uint8Array(32).fill(7);
    const encryptionKey = new Uint8Array(32).fill(9);
    const sealed = await sealPasswordVerifier(verifier, encryptionKey);
    const proof = await createLoginProof(verifier, "login-1", "nonce-a");

    await expect(verifyLoginProof({ sealed, challengeId: "login-1", nonce: "nonce-a", proof, encryptionKey }))
      .resolves.toBe(true);
    await expect(verifyLoginProof({ sealed, challengeId: "login-1", nonce: "nonce-b", proof, encryptionKey }))
      .resolves.toBe(false);
  });
});
