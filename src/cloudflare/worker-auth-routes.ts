import type { LoginChallengeRepository } from "../auth/login-challenge-repository";
import { toBase64Url } from "../auth/password-proof";

import type { D1PasswordProofRepository } from "./d1-password-proof-repository";

const CHALLENGE_TTL_MS = 5 * 60_000;
const DUMMY_SALT = "AAAAAAAAAAAAAAAAAAAAAA";

interface WorkerAuthDependencies {
  appOrigin: string;
  ipHmacSecret: string;
  proofs: Pick<D1PasswordProofRepository, "findByUsername">;
  challenges: LoginChallengeRepository;
  randomNonce?: () => string;
}

function normalizeUsername(value: unknown): string {
  if (typeof value !== "string") return "anonymous";
  const username = value.trim().toLowerCase();
  return /^[a-z0-9._-]{3,32}$/u.test(username) ? username : "anonymous";
}

function defaultNonce(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sourceIpHash(request: Request, secret: string): Promise<string | null> {
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  if (!ip || !secret) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip))));
}

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ ok: false, error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

function sameOrigin(request: Request, origin: string): boolean {
  try {
    return request.headers.get("origin") === origin && new URL(request.url).origin === origin;
  } catch {
    return false;
  }
}

export async function handleWorkerAuth(request: Request, dependencies: WorkerAuthDependencies): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/auth/login/challenge" || request.method !== "POST") return null;
  if (!sameOrigin(request, dependencies.appOrigin)) return jsonError("UNTRUSTED_ORIGIN", "请求来源不受信任", 403);
  const ipHash = await sourceIpHash(request, dependencies.ipHmacSecret);
  if (!ipHash) return jsonError("AUTHENTICATION_UNAVAILABLE", "认证服务暂时不可用", 503);
  let body: { username?: unknown };
  try {
    body = await request.json() as { username?: unknown };
  } catch {
    return jsonError("VALIDATION_ERROR", "请求参数无效", 400);
  }
  const normalizedUsername = normalizeUsername(body.username);
  const proof = await dependencies.proofs.findByUsername(normalizedUsername);
  const challenge = await dependencies.challenges.create({
    normalizedUsername,
    salt: proof?.salt ?? DUMMY_SALT,
    nonce: (dependencies.randomNonce ?? defaultNonce)(),
    ipHash,
    ttlMs: CHALLENGE_TTL_MS,
  });
  return Response.json({
    ok: true,
    data: {
      id: challenge.id,
      salt: challenge.salt,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt.toISOString(),
    },
  }, { headers: { "cache-control": "no-store" } });
}
