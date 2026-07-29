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
