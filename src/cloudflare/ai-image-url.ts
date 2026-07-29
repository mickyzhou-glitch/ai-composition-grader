import { toBase64Url } from "../auth/password-proof";

const encoder = new TextEncoder();

function payload(input: { reviewId: string; imageId: number; variant: string; expiresAt: number }): string {
  return `${input.reviewId}.${input.imageId}.${input.variant}.${input.expiresAt}`;
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

export async function createAiImageUrl(input: {
  origin: string;
  secret: string;
  reviewId: string;
  imageId: number;
  variant: "original" | "annotation" | "ai";
  expiresAt: number;
}): Promise<string> {
  const url = new URL(`/api/ai-images/${encodeURIComponent(input.reviewId)}/${input.imageId}`, input.origin);
  url.searchParams.set("variant", input.variant);
  url.searchParams.set("expires", String(input.expiresAt));
  url.searchParams.set("signature", await sign(payload(input), input.secret));
  return url.toString();
}

export async function verifyAiImageUrl(input: {
  secret: string;
  reviewId: string;
  imageId: number;
  variant: string | null;
  expires: string | null;
  signature: string | null;
  now?: number;
}): Promise<"original" | "annotation" | "ai" | null> {
  if (!input.variant || !["original", "annotation", "ai"].includes(input.variant) || !input.expires || !input.signature) return null;
  const expiresAt = Number(input.expires);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < (input.now ?? Date.now())) return null;
  const expected = await sign(payload({ reviewId: input.reviewId, imageId: input.imageId, variant: input.variant, expiresAt }), input.secret);
  return expected === input.signature ? input.variant as "original" | "annotation" | "ai" : null;
}
