import { randomBytes } from "node:crypto";

export const PDF_PRINT_TOKEN_KEYCHAIN_SERVICE = "ai-composition-grader-pdf";
export const PDF_PRINT_TOKEN_KEYCHAIN_ACCOUNT = "print-token";

export interface PrintTokenSecretStore {
  get(): Promise<string | null>;
  set(secret: string): Promise<void>;
}

/** Provision one local, non-exported signing key for the internal PDF page. */
export async function ensurePrintTokenSecret(store: PrintTokenSecretStore): Promise<string> {
  const existing = await store.get();
  if (existing && existing.length >= 32) return existing;
  const generated = randomBytes(32).toString("base64url");
  await store.set(generated);
  return generated;
}
