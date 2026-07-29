import { argon2id } from "hash-wasm";

import { createLoginProof, fromBase64Url } from "./password-proof";
import { deriveBrowserPasswordVerifier } from "./password-proof-browser";

export interface LegacyPasswordParameters {
  salt: string;
  memorySize: number;
  iterations: number;
  parallelism: number;
  hashLength: number;
}

export async function createLegacyPasswordLogin(input: {
  password: string;
  challengeId: string;
  nonce: string;
  legacy: LegacyPasswordParameters;
}): Promise<{ proof: string; verifier: string }> {
  const legacyVerifier = await argon2id({
    password: input.password,
    salt: fromBase64Url(input.legacy.salt),
    memorySize: input.legacy.memorySize,
    iterations: input.legacy.iterations,
    parallelism: input.legacy.parallelism,
    hashLength: input.legacy.hashLength,
    outputType: "binary",
  });
  const verifier = await deriveBrowserPasswordVerifier(input.password, input.legacy.salt);
  return {
    proof: await createLoginProof(legacyVerifier, input.challengeId, input.nonce),
    verifier: btoa(String.fromCharCode(...verifier)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, ""),
  };
}
