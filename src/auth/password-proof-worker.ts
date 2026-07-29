import { copyToArrayBuffer, createLoginProof, fromBase64Url, toBase64Url, type SealedPasswordVerifier, type VerifyLoginProofInput } from "./password-proof";

async function importEncryptionKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== 32) throw new TypeError("encryption key must contain 32 bytes");
  return crypto.subtle.importKey("raw", copyToArrayBuffer(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export { createLoginProof } from "./password-proof";

export async function sealPasswordVerifier(verifier: Uint8Array, encryptionKey: Uint8Array): Promise<SealedPasswordVerifier> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey(encryptionKey);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: copyToArrayBuffer(iv) }, key, copyToArrayBuffer(verifier));
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
      { name: "AES-GCM", iv: copyToArrayBuffer(fromBase64Url(input.sealed.iv)) },
      key,
      copyToArrayBuffer(fromBase64Url(input.sealed.ciphertext)),
    ));
    const expected = fromBase64Url(await createLoginProof(verifier, input.challengeId, input.nonce));
    return constantTimeEqual(expected, fromBase64Url(input.proof));
  } catch {
    return false;
  }
}
