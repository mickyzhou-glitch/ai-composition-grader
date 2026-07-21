import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

import {
  AuthRecordNotFoundError,
  AuthRepository,
  AuthStorageError,
  DuplicateUsernameError,
  TeacherLimitReachedError,
} from "./auth-repository";
import {
  DUMMY_ARGON2ID_HASH,
  generateSessionToken,
  hashPassword as defaultHashPassword,
  hashSessionToken,
  normalizeUsername,
  verifyPassword as defaultVerifyPassword,
} from "./password";
import type {
  AuthenticatedUser,
  SessionRecord,
  UserRecord,
  UserRole,
} from "./auth-types";

export type AuthErrorCode =
  | "INVALID_CREDENTIALS"
  | "LOGIN_RATE_LIMITED"
  | "MUST_CHANGE_PASSWORD"
  | "PASSWORD_REUSE"
  | "USER_LIMIT_REACHED"
  | "AUTH_NOT_FOUND"
  | "ACCOUNT_DISABLED"
  | "USER_ALREADY_EXISTS"
  | "INVALID_PASSWORD"
  | "AUTH_STORAGE_ERROR";

export class AuthServiceError extends Error {
  readonly code: AuthErrorCode;
  readonly retryAfterMs?: number;

  constructor(code: AuthErrorCode, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "AuthServiceError";
    this.code = code;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export interface AuthServiceOptions {
  now?: () => Date;
  randomSessionToken?: () => string;
  randomInitialPassword?: () => string;
  hashPassword?: (password: string) => Promise<string>;
  verifyPassword?: (passwordHash: string, password: string) => Promise<boolean>;
  sessionRefreshIntervalMs?: number;
  sessionLifetimeMs?: number;
}

export interface LoginInput {
  username: string;
  password: string;
  ipHash: string;
  sessionExpiresAt?: Date;
}

type RepositoryLike = AuthRepository;

const LOCK_RETRY_MS = 15 * 60 * 1000;
const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

function safeDate(value: Date, fallback: Date): Date {
  if (!(value instanceof Date)) return fallback;
  const timestamp = Date.prototype.getTime.call(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : fallback;
}

function asSafeUser(user: UserRecord): AuthenticatedUser {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
  };
}

export class AuthService {
  private readonly now: () => Date;
  private readonly createSessionToken: () => string;
  private readonly createInitialPassword: () => string;
  private readonly hash: (password: string) => Promise<string>;
  private readonly verify: (passwordHash: string, password: string) => Promise<boolean>;
  private readonly refreshIntervalMs: number;
  private readonly sessionLifetimeMs: number;

  constructor(
    private readonly repository: RepositoryLike,
    options: AuthServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createSessionToken = () => {
      const token = (options.randomSessionToken ?? generateSessionToken)();
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]+$/u.test(token)) {
        throw new AuthServiceError("AUTH_STORAGE_ERROR", "Authentication operation failed");
      }
      const decoded = Buffer.from(token, "base64url");
      if (decoded.length !== 32 || decoded.toString("base64url") !== token) {
        throw new AuthServiceError("AUTH_STORAGE_ERROR", "Authentication operation failed");
      }
      return token;
    };
    this.createInitialPassword = () => {
      const password = (options.randomInitialPassword ?? (() => randomBytes(24).toString("base64url")))();
      if (typeof password !== "string" || !/^[A-Za-z0-9_-]+$/u.test(password)) {
        throw new AuthServiceError("AUTH_STORAGE_ERROR", "Authentication operation failed");
      }
      const decoded = Buffer.from(password, "base64url");
      if (decoded.length < 20 || decoded.toString("base64url") !== password) {
        throw new AuthServiceError("AUTH_STORAGE_ERROR", "Authentication operation failed");
      }
      return password;
    };
    this.hash = options.hashPassword ?? defaultHashPassword;
    this.verify = options.verifyPassword ?? defaultVerifyPassword;
    this.refreshIntervalMs = options.sessionRefreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.sessionLifetimeMs = options.sessionLifetimeMs ?? DEFAULT_SESSION_LIFETIME_MS;
  }

  private normalizeForLogin(username: unknown): string | null {
    if (typeof username !== "string") return null;
    try {
      return normalizeUsername(username);
    } catch {
      return null;
    }
  }

  private currentTime(): Date {
    const value = this.now();
    return safeDate(value, new Date());
  }

  private recordEvent(
    userId: string | null,
    eventType: "login_success" | "login_failed" | "login_locked" | "password_changed" | "user_disabled" | "user_enabled" | "sessions_revoked" | "user_created" | "password_reset",
    metadata: Record<string, unknown>,
  ): void {
    try {
      this.repository.recordSecurityEvent({ userId, eventType, metadata });
    } catch {
      // Audit persistence must not turn a successful authentication into a
      // user-visible failure after a session has already been issued.
    }
  }

  private findUserById(userId: string): UserRecord | null {
    return this.repository.findUserById(userId);
  }

  private allUsers(): UserRecord[] {
    return this.repository.listUsers();
  }

  async login(input: LoginInput): Promise<{ rawToken: string; user: AuthenticatedUser; session: SessionRecord }> {
    const username = this.normalizeForLogin(input?.username);
    if (username === null || typeof input?.password !== "string" || input.password.length === 0 || typeof input?.ipHash !== "string" || !/^[a-f0-9]{64}$/u.test(input.ipHash)) {
      throw new AuthServiceError("INVALID_CREDENTIALS", "Invalid username or password");
    }
    const password = input.password;
    const ipHash = input.ipHash;
    const user = this.repository.findUserByUsername(username);
    const usable = user !== null && user.disabledAt === null && user.passwordHash !== "!bootstrap-required";
    let valid = false;
    try {
      valid = await this.verify(usable ? user.passwordHash : DUMMY_ARGON2ID_HASH, password);
    } catch {
      valid = false;
    }
    const recorded = this.repository.recordLoginAttemptAndGetStatus({
      username,
      ipHash,
      succeeded: usable && valid,
    });
    if (recorded.lockedBeforeAttempt) {
      this.recordEvent(user?.id ?? null, "login_locked", { reason: "rate_limit", retryAfterMs: LOCK_RETRY_MS });
      throw new AuthServiceError("LOGIN_RATE_LIMITED", "Login temporarily unavailable", LOCK_RETRY_MS);
    }
    if (!usable || !valid) {
      const retry = recorded.status.usernameLocked || recorded.status.ipLocked ? LOCK_RETRY_MS : undefined;
      this.recordEvent(user?.id ?? null, retry ? "login_locked" : "login_failed", {
        reason: retry ? "rate_limit" : "invalid_credentials",
        ...(retry ? { retryAfterMs: retry } : {}),
      });
      throw new AuthServiceError("INVALID_CREDENTIALS", "Invalid username or password", retry);
    }

    const rawToken = this.createSessionToken();
    const currentTime = this.currentTime();
    const expiresAt = input.sessionExpiresAt
      ? safeDate(input.sessionExpiresAt, new Date(currentTime.getTime() + this.sessionLifetimeMs))
      : new Date(currentTime.getTime() + this.sessionLifetimeMs);
    const session = this.repository.createSession({ userId: user.id, tokenHash: hashSessionToken(rawToken), expiresAt });
    this.recordEvent(user.id, "login_success", { reason: "authenticated" });
    return { rawToken, user: asSafeUser(user), session };
  }

  authenticateSession(rawToken: string): SessionRecord | null {
    if (typeof rawToken !== "string" || rawToken.length === 0) return null;
    return this.repository.findValidSessionByTokenHash(hashSessionToken(rawToken));
  }

  refreshSessionIfNeeded(sessionId: string, lastSeenAt: Date): SessionRecord | null {
    const now = this.currentTime();
    const seen = safeDate(lastSeenAt, now);
    if (now.getTime() - seen.getTime() < this.refreshIntervalMs) return null;
    try {
      return this.repository.refreshSession(sessionId);
    } catch (error) {
      if (error instanceof AuthRecordNotFoundError) return null;
      throw error;
    }
  }

  logout(rawToken: string): void {
    const session = this.authenticateSession(rawToken);
    if (session) this.repository.revokeSession(session.id);
  }

  async changePassword(input: { userId: string; currentPassword: string; newPassword: string }): Promise<AuthenticatedUser> {
    const user = this.findUserById(input.userId);
    const current = typeof input.currentPassword === "string" && input.currentPassword.length > 0 ? input.currentPassword : "invalid-password";
    const matches = await this.verify(
      user && user.disabledAt === null ? user.passwordHash : DUMMY_ARGON2ID_HASH,
      current,
    ).catch(() => false);
    if (!user || user.disabledAt !== null || !matches) throw new AuthServiceError("INVALID_CREDENTIALS", "Current password is invalid");
    if (typeof input.newPassword !== "string" || input.newPassword.length === 0) throw new AuthServiceError("INVALID_PASSWORD", "Password does not meet requirements");
    if (input.newPassword === current) throw new AuthServiceError("PASSWORD_REUSE", "New password must differ from current password");
    const passwordHash = await this.hash(input.newPassword);
    const updated = this.repository.updatePasswordHash(user.id, passwordHash, false);
    this.recordEvent(user.id, "password_changed", { reason: "password_change" });
    return asSafeUser(updated);
  }

  async createInvitedUser(input: { username: string; password: string; role: UserRole; mustChangePassword?: boolean }): Promise<AuthenticatedUser> {
    if (input.role !== "admin" && input.role !== "teacher") throw new AuthServiceError("INVALID_PASSWORD", "Invalid account role");
    const passwordHash = await this.hash(input.password);
    try {
      const user = this.repository.createUserWithTeacherLimit({ username: input.username, passwordHash, role: input.role, mustChangePassword: input.mustChangePassword ?? true });
      this.recordEvent(user.id, "user_created", { reason: "invited_user" });
      return asSafeUser(user);
    } catch (error) {
      if (error instanceof DuplicateUsernameError) throw new AuthServiceError("USER_ALREADY_EXISTS", "Username is already in use");
      if (error instanceof TeacherLimitReachedError) throw new AuthServiceError("USER_LIMIT_REACHED", "Teacher account limit reached");
      throw error;
    }
  }

  async resetPassword(username: string): Promise<string> {
    let user: UserRecord | null;
    try {
      user = this.repository.findUserByUsername(username);
    } catch (error) {
      if (error instanceof AuthStorageError) throw error;
      if (error instanceof TypeError) user = null;
      else throw error;
    }
    if (!user) throw new AuthServiceError("AUTH_NOT_FOUND", "Account was not found");
    const temporaryPassword = this.createInitialPassword();
    const passwordHash = await this.hash(temporaryPassword);
    this.repository.updatePasswordHash(user.id, passwordHash, true);
    this.recordEvent(user.id, "password_reset", { reason: "administrator_reset" });
    return temporaryPassword;
  }

  disableUser(userId: string): AuthenticatedUser {
    try {
      const user = this.repository.disableUser(userId);
      this.recordEvent(user.id, "user_disabled", { reason: "administrator_action" });
      return asSafeUser(user);
    } catch (error) {
      if (error instanceof AuthRecordNotFoundError) throw new AuthServiceError("AUTH_NOT_FOUND", "Account was not found");
      throw error;
    }
  }

  enableUser(userId: string): AuthenticatedUser {
    try {
      const user = this.repository.restoreUser(userId);
      this.recordEvent(user.id, "user_enabled", { reason: "administrator_action" });
      return asSafeUser(user);
    } catch (error) {
      if (error instanceof AuthRecordNotFoundError) throw new AuthServiceError("AUTH_NOT_FOUND", "Account was not found");
      throw error;
    }
  }

  revokeAllSessions(userId: string): number {
    const count = this.repository.revokeAllUserSessions(userId);
    this.recordEvent(userId, "sessions_revoked", { reason: "administrator_action", sessionCount: count });
    return count;
  }

  listUsers(): Array<Pick<UserRecord, "id" | "username" | "role" | "mustChangePassword" | "disabledAt" | "createdAt" | "updatedAt">> {
    return this.allUsers().map(({ id, username, role, mustChangePassword, disabledAt, createdAt, updatedAt }) => ({ id, username, role, mustChangePassword, disabledAt, createdAt, updatedAt }));
  }

  findUserByUsername(username: string): AuthenticatedUser | null {
    let user: UserRecord | null;
    try {
      user = this.repository.findUserByUsername(username);
    } catch (error) {
      if (error instanceof AuthStorageError) throw error;
      if (error instanceof TypeError) return null;
      throw error;
    }
    return user ? asSafeUser(user) : null;
  }
}
