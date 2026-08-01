import type { LoginChallengeRepository } from "../auth/login-challenge-repository";
import { createLoginProof, fromBase64Url, toBase64Url } from "../auth/password-proof";
import { sealPasswordVerifier, verifyLoginProof } from "../auth/password-proof-worker";

import type { D1PasswordProofRepository } from "./d1-password-proof-repository";
import type { D1SessionRepository } from "./d1-session-repository";

const CHALLENGE_TTL_MS = 5 * 60_000;

interface WorkerAuthDependencies {
  appOrigin: string;
  ipHmacSecret: string;
  proofs: Pick<D1PasswordProofRepository, "findByUsername"> & Partial<Pick<D1PasswordProofRepository, "findLoginCandidateByUsername" | "findLegacyByUsername" | "save" | "saveIfMissing" | "clearMustChangePassword">>;
  challenges: LoginChallengeRepository;
  sessions?: Pick<D1SessionRepository, "create" | "findActiveByTokenHash" | "revokeByTokenHash">;
  proofEncryptionKey?: string;
  randomNonce?: () => string;
}

interface LegacyPasswordParameters {
  salt: string;
  memorySize: number;
  iterations: number;
  parallelism: number;
  hashLength: number;
}

const DUMMY_LEGACY_PARAMETERS: LegacyPasswordParameters = {
  salt: "AAAAAAAAAAAAAAAAAAAAAA", memorySize: 65_536, iterations: 3, parallelism: 4, hashLength: 32,
};

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

function toBase64UrlFromBase64(value: string): string {
  const binary = atob(value);
  return toBase64Url(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

function legacyPasswordParameters(passwordHash: string): LegacyPasswordParameters | null {
  const match = /^\$argon2id\$v=19\$((?:[mtp]=\d+,?){3})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/u.exec(passwordHash);
  if (!match) return null;
  const [, parametersText, salt, digest] = match;
  const parameters = new Map<string, string>();
  for (const part of parametersText.split(",").filter(Boolean)) {
    const [name, value] = part.split("=");
    if (!name || !value || parameters.has(name)) return null;
    parameters.set(name, value);
  }
  if (parameters.size !== 3 || !parameters.has("m") || !parameters.has("t") || !parameters.has("p")) return null;
  const memorySize = Number(parameters.get("m"));
  const iterations = Number(parameters.get("t"));
  const parallelism = Number(parameters.get("p"));
  try {
    const hashLength = atob(digest).length;
    if (!Number.isSafeInteger(memorySize) || memorySize < 8 * parallelism || memorySize > 256 * 1024 ||
      !Number.isSafeInteger(iterations) || iterations < 1 || iterations > 10 ||
      !Number.isSafeInteger(parallelism) || parallelism < 1 || parallelism > 16 || hashLength < 4) return null;
    return { salt: toBase64UrlFromBase64(salt), memorySize, iterations, parallelism, hashLength };
  } catch {
    return null;
  }
}

function legacyDigest(passwordHash: string): Uint8Array | null {
  const match = /^\$argon2id\$v=19\$(?:[mtp]=\d+,?){3}\$[A-Za-z0-9+/]+\$([A-Za-z0-9+/]+)$/u.exec(passwordHash);
  if (!match) return null;
  try {
    return Uint8Array.from(atob(match[1]), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

async function sourceIpHash(request: Request, secret: string): Promise<string | null> {
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  if (!ip || !secret) return null;
  return toHex(await hmacSha256(secret, ip));
}

async function hmacSha256(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function dummyChallengeProfile(username: string, secret: string): Promise<{
  mode: "proof" | "legacy";
  salt: string;
  legacy?: LegacyPasswordParameters;
}> {
  const digest = await hmacSha256(secret, `login-challenge-dummy\0${username}`);
  const mode = (digest[0] & 1) === 0 ? "proof" as const : "legacy" as const;
  const salt = toBase64Url(digest.slice(1, 17));
  return {
    mode,
    salt,
    ...(mode === "legacy" ? { legacy: { ...DUMMY_LEGACY_PARAMETERS, salt } } : {}),
  };
}

async function findLoginCandidate(dependencies: WorkerAuthDependencies, username: string) {
  if (dependencies.proofs.findLoginCandidateByUsername) {
    const candidate = await dependencies.proofs.findLoginCandidateByUsername(username);
    return { proof: candidate?.proof ?? null, legacy: candidate?.legacy ?? null };
  }
  const proof = await dependencies.proofs.findByUsername(username);
  const legacy = proof === null ? await dependencies.proofs.findLegacyByUsername?.(username) ?? null : null;
  return { proof, legacy };
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

export async function authenticatedWorkerUser(
  request: Request,
  sessions: Pick<D1SessionRepository, "findActiveByTokenHash">,
) {
  const token = sessionToken(request);
  if (!token) return null;
  return (await sessions.findActiveByTokenHash(await hashSessionToken(token), new Date()))?.user ?? null;
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
    const user = await authenticatedWorkerUser(request, dependencies.sessions);
    return user ? Response.json({ ok: true, data: user }, { headers: { "cache-control": "no-store" } }) : jsonError("UNAUTHENTICATED", "Authentication required", 401);
  }
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    if (!sameOrigin(request, dependencies.appOrigin) || !dependencies.sessions) return jsonError("UNTRUSTED_ORIGIN", "请求来源不受信任", 403);
    const token = sessionToken(request);
    if (token) await dependencies.sessions.revokeByTokenHash(await hashSessionToken(token), new Date());
    return Response.json({ ok: true, data: {} }, { headers: { "set-cookie": "__Host-zuowen_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0" } });
  }
  if (url.pathname === "/api/auth/change-password" && request.method === "POST") {
    if (!sameOrigin(request, dependencies.appOrigin) || !dependencies.sessions || !dependencies.proofs.save || !dependencies.proofEncryptionKey) return jsonError("UNTRUSTED_ORIGIN", "请求来源不受信任", 403);
    const user = await authenticatedWorkerUser(request, dependencies.sessions);
    if (!user) return jsonError("UNAUTHENTICATED", "需要登录", 401);
    try {
      const body = await request.json() as { salt?: unknown; verifier?: unknown };
      if (typeof body.salt !== "string" || typeof body.verifier !== "string") throw new Error();
      const verifier = fromBase64Url(body.verifier);
      if (fromBase64Url(body.salt).length < 16 || verifier.length !== 32) throw new Error();
      await dependencies.proofs.save(user.id, body.salt, await sealPasswordVerifier(verifier, fromBase64Url(dependencies.proofEncryptionKey)), new Date());
      await dependencies.proofs.clearMustChangePassword?.(user.id);
      return Response.json({ ok: true, data: { user: { ...user, mustChangePassword: false } } });
    } catch { return jsonError("VALIDATION_ERROR", "请求参数无效", 400); }
  }
  if (["/api/auth/login/legacy/challenge", "/api/auth/login/legacy/complete"].includes(url.pathname)) {
    return handleLegacyPasswordLogin(request, dependencies);
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
    const challenge = await dependencies.challenges.consumeIfActive(body.challengeId);
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
  const { proof, legacy } = await findLoginCandidate(dependencies, normalizedUsername);
  const legacyParameters = proof === null
    ? (legacy && legacy.disabledAt === null ? legacyPasswordParameters(legacy.passwordHash) : null)
    : null;
  const profile = proof
    ? { mode: "proof" as const, salt: proof.salt }
    : legacyParameters
      ? { mode: "legacy" as const, salt: legacyParameters.salt, legacy: legacyParameters }
      : await dummyChallengeProfile(normalizedUsername, dependencies.ipHmacSecret);
  const challenge = await dependencies.challenges.create({
    normalizedUsername,
    salt: profile.salt,
    nonce: (dependencies.randomNonce ?? defaultNonce)(),
    ipHash,
    ttlMs: CHALLENGE_TTL_MS,
  });
  return Response.json({
    ok: true,
    data: {
      id: challenge.id,
      mode: profile.mode,
      salt: challenge.salt,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt.toISOString(),
      ...(profile.legacy ? { legacy: { ...profile.legacy, salt: challenge.salt } } : {}),
    },
  }, { headers: { "cache-control": "no-store" } });
}

async function handleLegacyPasswordLogin(request: Request, dependencies: WorkerAuthDependencies): Promise<Response> {
  if (!sameOrigin(request, dependencies.appOrigin)) return jsonError("UNTRUSTED_ORIGIN", "请求来源不受信任", 403);
  if (!dependencies.proofs.findLegacyByUsername) {
    return jsonError("AUTHENTICATION_UNAVAILABLE", "认证服务暂时不可用", 503);
  }
  const ipHash = await sourceIpHash(request, dependencies.ipHmacSecret);
  if (!ipHash) return jsonError("AUTHENTICATION_UNAVAILABLE", "认证服务暂时不可用", 503);
  let body: { username?: unknown; challengeId?: unknown; proof?: unknown; verifier?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return jsonError("VALIDATION_ERROR", "请求参数无效", 400);
  }
  if (new URL(request.url).pathname === "/api/auth/login/legacy/challenge") {
    const username = normalizeUsername(body.username);
    const { proof: modern, legacy } = await findLoginCandidate(dependencies, username);
    const parameters = !modern && legacy && legacy.disabledAt === null ? legacyPasswordParameters(legacy.passwordHash) : null;
    const fallbackSalt = parameters
      ? null
      : modern?.salt ?? (await dummyChallengeProfile(username, dependencies.ipHmacSecret)).salt;
    const challengeParameters = parameters ?? { ...DUMMY_LEGACY_PARAMETERS, salt: fallbackSalt! };
    const challenge = await dependencies.challenges.create({
      normalizedUsername: username,
      salt: challengeParameters.salt,
      nonce: (dependencies.randomNonce ?? defaultNonce)(),
      ipHash,
      ttlMs: CHALLENGE_TTL_MS,
    });
    return Response.json({ ok: true, data: { id: challenge.id, nonce: challenge.nonce, legacy: { ...challengeParameters, salt: challenge.salt } } }, { headers: { "cache-control": "no-store" } });
  }
  if (!dependencies.proofs.saveIfMissing || !dependencies.sessions || !dependencies.proofEncryptionKey) {
    return jsonError("AUTHENTICATION_UNAVAILABLE", "认证服务暂时不可用", 503);
  }
  if (typeof body.challengeId !== "string" || typeof body.proof !== "string" || typeof body.verifier !== "string") {
    return jsonError("VALIDATION_ERROR", "请求参数无效", 400);
  }
  const challenge = await dependencies.challenges.consumeIfActive(body.challengeId);
  if (!challenge) return jsonError("INVALID_CREDENTIALS", "用户名或密码错误", 401);
  const { proof: modern, legacy } = await findLoginCandidate(dependencies, challenge.normalizedUsername);
  if (modern) {
    return jsonError("INVALID_CREDENTIALS", "用户名或密码错误", 401);
  }
  const digest = legacy && legacy.disabledAt === null ? legacyDigest(legacy.passwordHash) : null;
  let verifier: Uint8Array;
  let suppliedProof: Uint8Array;
  try {
    verifier = fromBase64Url(body.verifier);
    suppliedProof = fromBase64Url(body.proof);
  } catch {
    return jsonError("INVALID_CREDENTIALS", "用户名或密码错误", 401);
  }
  const expected = digest ? fromBase64Url(await createLoginProof(digest, challenge.id, challenge.nonce)) : new Uint8Array();
  if (!legacy || !digest || verifier.length !== 32 || !constantTimeEqual(expected, suppliedProof)) {
    return jsonError("INVALID_CREDENTIALS", "用户名或密码错误", 401);
  }
  const now = new Date();
  const inserted = await dependencies.proofs.saveIfMissing(
    legacy.user.id,
    challenge.salt,
    await sealPasswordVerifier(verifier, fromBase64Url(dependencies.proofEncryptionKey)),
    now,
  );
  if (!inserted) return jsonError("INVALID_CREDENTIALS", "用户名或密码错误", 401);
  const rawToken = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  await dependencies.sessions.create({ id: crypto.randomUUID(), userId: legacy.user.id, tokenHash: await hashSessionToken(rawToken), expiresAt: new Date(now.getTime() + 12 * 60 * 60_000), now });
  return Response.json({ ok: true, data: legacy.user }, { headers: { "set-cookie": cookie(rawToken), "cache-control": "no-store" } });
}
