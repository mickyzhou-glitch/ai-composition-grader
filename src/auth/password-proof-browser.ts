import { argon2id } from "hash-wasm";

import { createLoginProof, fromBase64Url } from "./password-proof";

const ARGON2ID_OPTIONS = {
  parallelism: 1,
  iterations: 2,
  memorySize: 19_456,
  hashLength: 32,
  outputType: "binary" as const,
};

export async function deriveBrowserPasswordVerifier(password: string, salt: string): Promise<Uint8Array> {
  return argon2id({
    password,
    salt: fromBase64Url(salt),
    ...ARGON2ID_OPTIONS,
  });
}

export async function createBrowserLoginProof(input: {
  password: string;
  salt: string;
  challengeId: string;
  nonce: string;
}): Promise<string> {
  const verifier = await deriveBrowserPasswordVerifier(input.password, input.salt);
  return createLoginProof(verifier, input.challengeId, input.nonce);
}
