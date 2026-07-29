import type { LoginChallengeRepository } from "../auth/login-challenge-repository";
import { fromBase64Url, toBase64Url } from "../auth/password-proof";
import { verifyLoginProof } from "../auth/password-proof-worker";

import type { D1PasswordProofRepository } from "./d1-password-proof-repository";
import type { D1SessionRepository } from "./d1-session-repository";

const CHALLENGE_TTL_MS = 5 * 60_000;
const DUMMY_SALT = "AAAAAAAAAAAAAAAAAAAAAA";

interface WorkerAuthDependencies {
  appOrigin: string;
  ipHmacSecret: string;
  proofs: Pick<D1PasswordProofRepository, "findByUsername">;
  challenges: LoginChallengeRepository;
  sessions?: Pick<D1SessionRepository, "create" | "findActiveByTokenHash" | "revokeByTokenHash">;
  proofEncryptionKey?: string;
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

async function hashSessionToken(token: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
}

function cookie(value: string): string {
  return `__Host-zuowen_session=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`;
}

function sessionToken(request: Request): string | null {
  const match = /(?:^|;\s*)__Host-zuowen_session=([^;]+)/u.exec(request.headers.get("cookie") ?? "");
  return match ? decodeURIComponent(match[1]) : null;
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
  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    if (!dependencies.sessions) return jsonError("AUTHENTICATION_UNAVAILABLE", "认证服务暂时不可用", 503);
    const token = sessionToken(request);
    if (!token) return jsonError("UNAUTHENTICATED", "Authentication required", 401);
    const session = await dependencies.sessions.findActiveByTokenHash(await hashSessionToken(token), new Date());
    return session ? Response.json({ ok: true, data: session.user }, { headers: { "cache-control": "no-store" } }) : jsonError("UNAUTHENTICATED", "Authentication required", 401);
  }
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    if (!sameOrigin(request, dependencies.appOrigin) || !dependencies.sessions) return jsonError("UNTRUSTED_ORIGIN", "请求来源不受信任", 403);
    const token = sessionToken(request);
    if (token) await dependencies.sessions.revokeByTokenHash(await hashSessionToken(token), new Date());
    return Response.json({ ok: true, data: {} }, { headers: { "set-cookie": "__Host-zuowen_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" } });
  }
  if (!["/api/auth/login/challenge", "/api/auth/login/complete"].includes(url.pathname) || request.method !== "POST") return null;
  if (!sameOrigin(request, dependencies.appOrigin)) return jsonError("UNTRUSTED_ORIGIN", "请求来源不受信任", 403);
  const ipHash = await sourceIpHash(request, dependencies.ipHmacSecret);
  if (!ipHash) return jsonError("AUTHENTICATION_UNAVAILABLE", "认证服务暂时不可用", 503);
  let body: { username?: unknown; challengeId?: unknown; proof?: unknown };
  try {
    body = await request.json() as { username?: unknown };
  } catch {
    return jsonError("VALIDATION_ERROR", "请求参数无效", 400);
  }
  if (url.pathname === "/api/auth/login/complete") {
    if (!dependencies.sessions || !dependencies.proofEncryptionKey || typeof body.challengeId !== "string" || typeof body.proof !== "string") {
      return jsonError("VALIDATION_ERROR", "请求参数无效", 400);
    }
    const challenge = await dependencies.challenges.consumeIfActive(body.challengeId, ipHash);
    if (!challenge) return jsonError("INVALID_CREDENTIALS", "用户名或密码错误", 401);
    const proof = await dependencies.proofs.findByUsername(challenge.normalizedUsername);
    const valid = proof !== null && proof.disabledAt === null && await verifyLoginProof({
      sealed: proof.sealed, challengeId: challenge.id, nonce: challenge.nonce, proof: body.proof,
      encryptionKey: fromBase64Url(dependencies.proofEncryptionKey),
    });
    if (!valid) return jsonError("INVALID_CREDENTIALS", "用户名或密码错误", 401);
    const rawToken = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const now = new Date();
    await dependencies.sessions.create({ id: crypto.randomUUID(), userId: proof.user.id, tokenHash: await hashSessionToken(rawToken), expiresAt: new Date(now.getTime() + 12 * 60 * 60_000), now });
    return Response.json({ ok: true, data: proof.user }, { headers: { "set-cookie": cookie(rawToken), "cache-control": "no-store" } });
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
