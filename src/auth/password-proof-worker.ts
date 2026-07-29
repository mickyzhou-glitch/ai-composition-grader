import type { SealedPasswordVerifier, VerifyLoginProofInput } from "./password-proof";

const textEncoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new TypeError("invalid base64url");
  const padded = `${value.replace(/-/gu, "+").replace(/_/gu, "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importEncryptionKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== 32) throw new TypeError("encryption key must contain 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function createLoginProof(verifier: Uint8Array, challengeId: string, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", verifier, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const data = textEncoder.encode(`${challengeId}.${nonce}`);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
}

export async function sealPasswordVerifier(verifier: Uint8Array, encryptionKey: Uint8Array): Promise<SealedPasswordVerifier> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey(encryptionKey);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, verifier);
  return { ciphertext: toBase64Url(new Uint8Array(ciphertext)), iv: toBase64Url(iv), version: 1 };
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

export async function verifyLoginProof(input: VerifyLoginProofInput): Promise<boolean> {
  try {
    if (input.sealed.version !== 1) return false;
    const key = await importEncryptionKey(input.encryptionKey);
    const verifier = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(input.sealed.iv) },
      key,
      fromBase64Url(input.sealed.ciphertext),
    ));
    const expected = fromBase64Url(await createLoginProof(verifier, input.challengeId, input.nonce));
    return constantTimeEqual(expected, fromBase64Url(input.proof));
  } catch {
    return false;
  }
}
