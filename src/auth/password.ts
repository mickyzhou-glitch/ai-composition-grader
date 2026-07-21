import { Buffer } from "node:buffer";
import { createHash, createHmac, randomBytes } from "node:crypto";

import { argon2id, hash, verify } from "argon2";

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;
const ARGON2ID_PHC_PATTERN =
  /^\$argon2id\$v=(\d+)\$([^$]+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;
const MAX_ARGON2_MEMORY_KIB = 256 * 1024;
const MAX_ARGON2_TIME_COST = 10;
const MAX_ARGON2_PARALLELISM = 16;

export const DUMMY_ARGON2ID_HASH =
  "$argon2id$v=19$m=65536,p=4,t=3$+qmiDTFUMhDdPEdA2eCZOQ$Ik4syq2T2b6+0J1a5SmGBcp++/U3DjQ6k4R0B2A7VuA";

export function normalizeUsername(input: string): string {
  if (typeof input !== "string") {
    throw new TypeError("Username must be a string");
  }
  const trimmed = input.trim();
  if (!USERNAME_PATTERN.test(trimmed)) {
    throw new TypeError("Username must contain 3-32 allowed ASCII characters");
  }
  return trimmed.toLowerCase();
}

function requireNonEmpty(value: string, message: string): void {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(message);
}

function isCanonicalBase64(value: string, minimumBytes: number): boolean {
  if (value.length % 4 === 1) return false;
  const decoded = Buffer.from(value, "base64");
  return (
    decoded.length >= minimumBytes &&
    decoded.toString("base64").replace(/=+$/u, "") === value
  );
}

export function isValidArgon2idHash(value: string): boolean {
  if (typeof value !== "string") return false;
  const match = ARGON2ID_PHC_PATTERN.exec(value);
  if (!match) return false;
  const [, versionText, parametersText, salt, digest] = match;
  if (Number(versionText) !== 19 || !isCanonicalBase64(salt, 8)) return false;
  if (!isCanonicalBase64(digest, 4)) return false;

  const parameters = new Map<string, number>();
  for (const part of parametersText.split(",")) {
    const parameter = /^(m|t|p)=(\d+)$/u.exec(part);
    if (!parameter || parameters.has(parameter[1])) return false;
    const number = Number(parameter[2]);
    if (!Number.isSafeInteger(number) || number < 1 || number > 0xffffffff) {
      return false;
    }
    parameters.set(parameter[1], number);
  }

  const memoryCost = parameters.get("m");
  const timeCost = parameters.get("t");
  const parallelism = parameters.get("p");
  return (
    parameters.size === 3 &&
    memoryCost !== undefined &&
    timeCost !== undefined &&
    parallelism !== undefined &&
    memoryCost >= 8 * parallelism &&
    memoryCost <= MAX_ARGON2_MEMORY_KIB &&
    timeCost >= 1 &&
    timeCost <= MAX_ARGON2_TIME_COST &&
    parallelism <= MAX_ARGON2_PARALLELISM
  );
}

export async function hashPassword(password: string): Promise<string> {
  requireNonEmpty(password, "Password must not be empty");
  return hash(password, { type: argon2id });
}

export async function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  requireNonEmpty(password, "Password must not be empty");
  if (!isValidArgon2idHash(passwordHash)) {
    return false;
  }
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(rawToken: string): string {
  requireNonEmpty(rawToken, "Session token must not be empty");
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function hashSourceIp(ip: string, hmacSecret: string): string {
  requireNonEmpty(ip, "Source IP must not be empty");
  requireNonEmpty(hmacSecret, "IP HMAC secret must not be empty");
  return createHmac("sha256", hmacSecret).update(ip, "utf8").digest("hex");
}
