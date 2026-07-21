import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export interface PrintTokenClaims {
  ownerId: string;
  reviewId: string;
  expiresAt: number;
}

const HEADER_NAME = "x-zuowen-print-token";
const TTL_MS = 2 * 60 * 1000;
const consumed = new Map<string, number>();

export const PRINT_TOKEN_HEADER = HEADER_NAME;

function secret(): string {
  const value = process.env.PDF_PRINT_TOKEN_SECRET;
  if (!value || value.length < 32) {
    throw new Error("PDF_PRINT_TOKEN_SECRET must be configured with at least 32 characters");
  }
  return value;
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signature(payload: string, key: string): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

function cleanup(now: number): void {
  for (const [token, expiresAt] of consumed) {
    if (expiresAt <= now) consumed.delete(token);
  }
}

export function createPrintToken(
  claims: Omit<PrintTokenClaims, "expiresAt"> & { expiresAt?: number },
  key = secret(),
  now = Date.now(),
): string {
  if (!claims.ownerId || !claims.reviewId) throw new TypeError("print token claims are incomplete");
  const expiresAt = claims.expiresAt ?? now + TTL_MS;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) throw new TypeError("print token expiry is invalid");
  const payload = encode(JSON.stringify({ ...claims, expiresAt, nonce: randomBytes(16).toString("base64url") }));
  return `${payload}.${signature(payload, key)}`;
}

export function consumePrintToken(
  token: string | null | undefined,
  expected: Partial<Pick<PrintTokenClaims, "ownerId" | "reviewId">>,
  key = secret(),
  now = Date.now(),
): PrintTokenClaims | null {
  if (!token || token.length > 4096) return null;
  cleanup(now);
  const [payload, provided] = token.split(".");
  if (!payload || !provided || provided.length !== 43) return null;
  const expectedSignature = signature(payload, key);
  const left = Buffer.from(provided);
  const right = Buffer.from(expectedSignature);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decode(payload));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const claims = parsed as Partial<PrintTokenClaims> & { nonce?: unknown };
  if (
    typeof claims.ownerId !== "string" ||
    typeof claims.reviewId !== "string" ||
    typeof claims.expiresAt !== "number" ||
    typeof claims.nonce !== "string" ||
    (expected.ownerId !== undefined && claims.ownerId !== expected.ownerId) ||
    (expected.reviewId !== undefined && claims.reviewId !== expected.reviewId) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt <= now
  ) return null;
  if (consumed.has(token)) return null;
  consumed.set(token, claims.expiresAt);
  return { ownerId: claims.ownerId, reviewId: claims.reviewId, expiresAt: claims.expiresAt };
}
