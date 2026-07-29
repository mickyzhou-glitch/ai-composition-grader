export interface SealedPasswordVerifier {
  ciphertext: string;
  iv: string;
  version: 1;
}

export interface VerifyLoginProofInput {
  sealed: SealedPasswordVerifier;
  challengeId: string;
  nonce: string;
  proof: string;
  encryptionKey: Uint8Array;
}

const textEncoder = new TextEncoder();

export function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new TypeError("invalid base64url");
  const padded = `${value.replace(/-/gu, "+").replace(/_/gu, "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function createLoginProof(verifier: Uint8Array, challengeId: string, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", copyToArrayBuffer(verifier), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const data = textEncoder.encode(`${challengeId}.${nonce}`);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, copyToArrayBuffer(data))));
}
