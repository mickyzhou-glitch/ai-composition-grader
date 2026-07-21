import { randomUUID } from "node:crypto";

import { and, desc, eq, gt, gte, isNull } from "drizzle-orm";

import type { AppDatabase } from "../db/client";
import { loginAttempts, securityEvents, sessions, users } from "../db/schema";
import type {
  AuthenticatedUser,
  CreateSessionInput,
  CreateUserInput,
  LoginAttemptInput,
  LoginAttemptRecord,
  LoginFailureQuery,
  LoginFailureStatus,
  RecordedLoginAttemptStatus,
  SecurityEventInput,
  SecurityEventRecord,
  SessionRecord,
  UserRecord,
  UserRole,
} from "./auth-types";
import { isValidArgon2idHash, normalizeUsername } from "./password";

const SESSION_EXTENSION_MS = 12 * 60 * 60 * 1000;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;
const SHA_256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const SECURITY_EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const SECURITY_METADATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_METADATA_ARRAY_LENGTH = 100;
const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_NODES = 512;
const MAX_METADATA_STRING_LENGTH = 16_384;
const SENSITIVE_METADATA_KEYS = new Set([
  "password",
  "passwordhash",
  "token",
  "tokenhash",
  "apikey",
  "cookie",
  "authorization",
  "essay",
  "essaybody",
  "essaytext",
  "compositionbody",
  "compositiontext",
  "imagedataurl",
  "imagebase64",
  "作文正文",
  "作文内容",
]);

export interface AuthRepositoryOptions {
  now?: () => Date;
  randomUUID?: () => string;
}

export class AuthStorageError extends Error {
  readonly code = "AUTH_STORAGE_ERROR";

  constructor() {
    super("Authentication storage operation failed");
    this.name = "AuthStorageError";
  }
}

export class DuplicateUsernameError extends Error {
  readonly code = "DUPLICATE_USERNAME";

  constructor() {
    super("Username is already in use");
    this.name = "DuplicateUsernameError";
  }
}

export class DuplicateSessionTokenError extends Error {
  readonly code = "DUPLICATE_SESSION_TOKEN";

  constructor() {
    super("Authentication record conflicts with existing data");
    this.name = "DuplicateSessionTokenError";
  }
}

export class AuthRecordNotFoundError extends Error {
  readonly code = "AUTH_RECORD_NOT_FOUND";

  constructor() {
    super("Authentication record was not found");
    this.name = "AuthRecordNotFoundError";
  }
}

export class InvalidSecurityMetadataError extends Error {
  readonly code = "INVALID_SECURITY_METADATA";

  constructor() {
    super("Security event metadata contains disallowed data");
    this.name = "InvalidSecurityMetadataError";
  }
}

function isSqliteError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === code
  );
}

function asUserRecord(row: typeof users.$inferSelect): UserRecord {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.passwordHash,
    role: row.role,
    mustChangePassword: row.mustChangePassword,
    disabledAt: row.disabledAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function asAuthenticatedUser(row: {
  id: string;
  username: string;
  role: UserRole;
  mustChangePassword: boolean;
}): AuthenticatedUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    mustChangePassword: row.mustChangePassword,
  };
}

function assertRole(role: string): asserts role is UserRole {
  if (role !== "admin" && role !== "teacher") {
    throw new TypeError("Role must be admin or teacher");
  }
}

function assertPasswordHash(passwordHash: string): void {
  if (!isValidArgon2idHash(passwordHash)) {
    throw new TypeError("Password hash must be a valid Argon2id PHC string");
  }
}

function assertSha256Hash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA_256_HEX_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 hex hash`);
  }
}

function snapshotDate(value: unknown, label: string): Date {
  if (!(value instanceof Date)) {
    throw new TypeError(`${label} must be a valid date`);
  }
  let timestamp: number;
  try {
    timestamp = Date.prototype.getTime.call(value);
  } catch {
    throw new TypeError(`${label} must be a valid date`);
  }
  if (Number.isNaN(timestamp)) throw new TypeError(`${label} must be a valid date`);
  return new Date(timestamp);
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
}

function snapshotOwnDataProperty(
  input: unknown,
  key: string,
  optional = false,
): unknown {
  try {
    if (typeof input !== "object" || input === null) throw new TypeError();
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor) {
      if (optional) return undefined;
      throw new TypeError();
    }
    if (!("value" in descriptor)) throw new TypeError();
    return descriptor.value;
  } catch {
    throw new TypeError("Authentication input must use own data properties");
  }
}

function snapshotLoginAttemptInput(input: LoginAttemptInput): {
  normalizedUsername: string;
  ipHash: string;
  succeeded: boolean;
} {
  const username = snapshotOwnDataProperty(input, "username");
  const ipHash = snapshotOwnDataProperty(input, "ipHash");
  const succeeded = snapshotOwnDataProperty(input, "succeeded");
  if (typeof username !== "string") throw new TypeError("Username must be a string");
  assertSha256Hash(ipHash, "IP hash");
  assertBoolean(succeeded, "succeeded");
  return {
    normalizedUsername: normalizeUsername(username),
    ipHash,
    succeeded,
  };
}

function snapshotSafeMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const ancestors = new Set<object>();
  let nodes = 0;
  let stringLength = 0;

  const clone = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_METADATA_NODES || depth > MAX_METADATA_DEPTH) {
      throw new InvalidSecurityMetadataError();
    }
    if (typeof value === "string") {
      if (/^data:/i.test(value.trim())) throw new InvalidSecurityMetadataError();
      stringLength += value.length;
      if (stringLength > MAX_METADATA_STRING_LENGTH) {
        throw new InvalidSecurityMetadataError();
      }
      return value;
    }
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new InvalidSecurityMetadataError();
      }
      return value;
    }
    if (Array.isArray(value)) {
      if (ancestors.has(value)) throw new InvalidSecurityMetadataError();
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new InvalidSecurityMetadataError();
      }
      ancestors.add(value);
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > MAX_METADATA_ARRAY_LENGTH
      ) {
        throw new InvalidSecurityMetadataError();
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const snapshot: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) {
          snapshot.push(null);
          continue;
        }
        if (!("value" in descriptor)) throw new InvalidSecurityMetadataError();
        snapshot.push(clone(descriptor.value, depth + 1));
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string") throw new InvalidSecurityMetadataError();
        if (key === "length" || /^\d+$/u.test(key)) continue;
        const descriptor = descriptors[key];
        if (descriptor.enumerable) throw new InvalidSecurityMetadataError();
      }
      ancestors.delete(value);
      return snapshot;
    }
    if (typeof value !== "object" || value === null) {
      throw new InvalidSecurityMetadataError();
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InvalidSecurityMetadataError();
    }
    if (ancestors.has(value)) throw new InvalidSecurityMetadataError();
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") throw new InvalidSecurityMetadataError();
      const descriptor = descriptors[key];
      if (!SECURITY_METADATA_KEY_PATTERN.test(key)) {
        throw new InvalidSecurityMetadataError();
      }
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) {
        throw new InvalidSecurityMetadataError();
      }
      const normalizedKey = key.toLowerCase().replace(/[._-]/g, "");
      if (
        SENSITIVE_METADATA_KEYS.has(normalizedKey) ||
        normalizedKey.includes("essay") ||
        normalizedKey.includes("composition") ||
        normalizedKey.includes("作文")
      ) {
        throw new InvalidSecurityMetadataError();
      }
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: clone(descriptor.value, depth + 1),
        writable: true,
      });
    }
    ancestors.delete(value);
    return snapshot;
  };

  try {
    const snapshot = clone(metadata, 0);
    if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
      throw new InvalidSecurityMetadataError();
    }
    return snapshot as Record<string, unknown>;
  } catch (error) {
    if (error instanceof InvalidSecurityMetadataError) throw error;
    throw new InvalidSecurityMetadataError();
  }
}

export class AuthRepository {
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(
    private readonly database: AppDatabase,
    options: AuthRepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.randomUUID ?? randomUUID;
  }

  private safely<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (
        error instanceof AuthStorageError ||
        error instanceof DuplicateUsernameError ||
        error instanceof DuplicateSessionTokenError ||
        error instanceof AuthRecordNotFoundError ||
        error instanceof InvalidSecurityMetadataError
      ) {
        throw error;
      }
      throw new AuthStorageError();
    }
  }

  createUser(input: CreateUserInput): UserRecord {
    const inputUsername = snapshotOwnDataProperty(input, "username");
    const passwordHash = snapshotOwnDataProperty(input, "passwordHash");
    const role = snapshotOwnDataProperty(input, "role");
    const mustChangePassword = snapshotOwnDataProperty(
      input,
      "mustChangePassword",
      true,
    );
    if (typeof inputUsername !== "string") {
      throw new TypeError("Username must be a string");
    }
    if (typeof passwordHash !== "string") {
      throw new TypeError("Password hash must be a string");
    }
    if (typeof role !== "string") throw new TypeError("Role must be a string");
    const username = normalizeUsername(inputUsername);
    assertRole(role);
    assertPasswordHash(passwordHash);
    if (mustChangePassword !== undefined) {
      assertBoolean(mustChangePassword, "mustChangePassword");
    }
    const timestamp = snapshotDate(this.now(), "Current time");
    const id = this.createId();

    try {
      this.database
        .insert(users)
        .values({
          id,
          username,
          passwordHash,
          role,
          mustChangePassword: mustChangePassword ?? false,
          disabledAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        })
        .run();
    } catch (error) {
      if (isSqliteError(error, "SQLITE_CONSTRAINT_UNIQUE")) {
        throw new DuplicateUsernameError();
      }
      throw new AuthStorageError();
    }
    return this.requireUserById(id);
  }

  findUserByUsername(username: string): UserRecord | null {
    const normalizedUsername = normalizeUsername(username);
    return this.safely(() => {
      const row = this.database
        .select()
        .from(users)
        .where(eq(users.username, normalizedUsername))
        .get();
      return row ? asUserRecord(row) : null;
    });
  }

  private requireUserById(userId: string): UserRecord {
    return this.safely(() => {
      const row = this.database.select().from(users).where(eq(users.id, userId)).get();
      if (!row) throw new AuthRecordNotFoundError();
      return asUserRecord(row);
    });
  }

  updatePasswordHash(
    userId: string,
    passwordHash: string,
    mustChangePassword = false,
  ): UserRecord {
    assertPasswordHash(passwordHash);
    assertBoolean(mustChangePassword, "mustChangePassword");
    const timestamp = this.now();
    return this.safely(() => {
      this.database.transaction((transaction) => {
        const update = transaction
          .update(users)
          .set({ passwordHash, mustChangePassword, updatedAt: timestamp })
          .where(eq(users.id, userId))
          .run();
        if (update.changes === 0) throw new AuthRecordNotFoundError();
        transaction
          .update(sessions)
          .set({ revokedAt: timestamp })
          .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
          .run();
      });
      return this.requireUserById(userId);
    });
  }

  disableUser(userId: string): UserRecord {
    const timestamp = this.now();
    return this.safely(() => {
      this.database.transaction((transaction) => {
        const update = transaction
          .update(users)
          .set({ disabledAt: timestamp, updatedAt: timestamp })
          .where(eq(users.id, userId))
          .run();
        if (update.changes === 0) throw new AuthRecordNotFoundError();
        transaction
          .update(sessions)
          .set({ revokedAt: timestamp })
          .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
          .run();
      });
      return this.requireUserById(userId);
    });
  }

  restoreUser(userId: string): UserRecord {
    const timestamp = this.now();
    return this.safely(() => {
      const update = this.database
        .update(users)
        .set({ disabledAt: null, updatedAt: timestamp })
        .where(eq(users.id, userId))
        .run();
      if (update.changes === 0) throw new AuthRecordNotFoundError();
      return this.requireUserById(userId);
    });
  }

  createSession(input: CreateSessionInput): SessionRecord {
    const userId = snapshotOwnDataProperty(input, "userId");
    const tokenHash = snapshotOwnDataProperty(input, "tokenHash");
    const inputExpiresAt = snapshotOwnDataProperty(input, "expiresAt");
    if (typeof userId !== "string" || userId.length === 0) {
      throw new TypeError("Session user ID must not be empty");
    }
    assertSha256Hash(tokenHash, "Session token hash");
    const expiresAt = snapshotDate(inputExpiresAt, "Session expiration");
    const timestamp = this.now();
    const id = this.createId();
    try {
      this.database.transaction((transaction) => {
        const activeUser = transaction
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, userId), isNull(users.disabledAt)))
          .get();
        if (!activeUser) throw new AuthStorageError();
        transaction
          .insert(sessions)
          .values({
            id,
            userId,
            tokenHash,
            lastSeenAt: timestamp,
            expiresAt,
            createdAt: timestamp,
            revokedAt: null,
          })
          .run();
      });
    } catch (error) {
      if (error instanceof AuthStorageError) throw error;
      if (isSqliteError(error, "SQLITE_CONSTRAINT_UNIQUE")) {
        throw new DuplicateSessionTokenError();
      }
      throw new AuthStorageError();
    }
    return this.requireSessionById(id);
  }

  private requireSessionById(sessionId: string): SessionRecord {
    return this.safely(() => {
      const row = this.database
        .select({
          id: sessions.id,
          lastSeenAt: sessions.lastSeenAt,
          expiresAt: sessions.expiresAt,
          createdAt: sessions.createdAt,
          userId: users.id,
          username: users.username,
          role: users.role,
          mustChangePassword: users.mustChangePassword,
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(eq(sessions.id, sessionId))
        .get();
      if (!row) throw new AuthRecordNotFoundError();
      return {
        id: row.id,
        user: asAuthenticatedUser({
          id: row.userId,
          username: row.username,
          role: row.role,
          mustChangePassword: row.mustChangePassword,
        }),
        lastSeenAt: row.lastSeenAt,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
      };
    });
  }

  findValidSessionByTokenHash(tokenHash: string): SessionRecord | null {
    if (typeof tokenHash !== "string" || !SHA_256_HEX_PATTERN.test(tokenHash)) return null;
    const timestamp = this.now();
    return this.safely(() => {
      const row = this.database
        .select({
          id: sessions.id,
          lastSeenAt: sessions.lastSeenAt,
          expiresAt: sessions.expiresAt,
          createdAt: sessions.createdAt,
          userId: users.id,
          username: users.username,
          role: users.role,
          mustChangePassword: users.mustChangePassword,
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(
          and(
            eq(sessions.tokenHash, tokenHash),
            isNull(sessions.revokedAt),
            gt(sessions.expiresAt, timestamp),
            isNull(users.disabledAt),
          ),
        )
        .get();
      if (!row) return null;
      return {
        id: row.id,
        user: asAuthenticatedUser({
          id: row.userId,
          username: row.username,
          role: row.role,
          mustChangePassword: row.mustChangePassword,
        }),
        lastSeenAt: row.lastSeenAt,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
      };
    });
  }

  refreshSession(sessionId: string): SessionRecord {
    const timestamp = this.now();
    const expiresAt = new Date(timestamp.valueOf() + SESSION_EXTENSION_MS);
    return this.safely(() => {
      this.database.transaction((transaction) => {
        const active = transaction
          .select({ id: sessions.id })
          .from(sessions)
          .innerJoin(users, eq(sessions.userId, users.id))
          .where(
            and(
              eq(sessions.id, sessionId),
              isNull(sessions.revokedAt),
              gt(sessions.expiresAt, timestamp),
              isNull(users.disabledAt),
            ),
          )
          .get();
        if (!active) throw new AuthRecordNotFoundError();
        transaction
          .update(sessions)
          .set({ lastSeenAt: timestamp, expiresAt })
          .where(eq(sessions.id, sessionId))
          .run();
      });
      return this.requireSessionById(sessionId);
    });
  }

  revokeSession(sessionId: string): boolean {
    const timestamp = this.now();
    return this.safely(
      () =>
        this.database
          .update(sessions)
          .set({ revokedAt: timestamp })
          .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
          .run().changes > 0,
    );
  }

  revokeAllUserSessions(userId: string): number {
    const timestamp = this.now();
    return this.safely(
      () =>
        this.database
          .update(sessions)
          .set({ revokedAt: timestamp })
          .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
          .run().changes,
    );
  }

  recordLoginAttempt(input: LoginAttemptInput): LoginAttemptRecord {
    const { normalizedUsername, ipHash, succeeded } =
      snapshotLoginAttemptInput(input);
    const attemptedAt = this.now();
    return this.safely(() => {
      const result = this.database
        .insert(loginAttempts)
        .values({
          normalizedUsername,
          ipHash,
          succeeded,
          attemptedAt,
        })
        .run();
      return {
        id: Number(result.lastInsertRowid),
        normalizedUsername,
        ipHash,
        succeeded,
        attemptedAt,
      };
    });
  }

  private countConsecutiveFailures(
    condition: ReturnType<typeof eq>,
    cutoff: Date,
  ): number {
    const attempts = this.database
      .select({ succeeded: loginAttempts.succeeded })
      .from(loginAttempts)
      .where(and(condition, gte(loginAttempts.attemptedAt, cutoff)))
      .orderBy(desc(loginAttempts.attemptedAt), desc(loginAttempts.id))
      .all();
    let failures = 0;
    for (const attempt of attempts) {
      if (attempt.succeeded) break;
      failures += 1;
    }
    return failures;
  }

  getLoginFailureStatus(query: LoginFailureQuery): LoginFailureStatus {
    const username = snapshotOwnDataProperty(query, "username");
    const ipHash = snapshotOwnDataProperty(query, "ipHash");
    if (typeof username !== "string") throw new TypeError("Username must be a string");
    const normalizedUsername = normalizeUsername(username);
    assertSha256Hash(ipHash, "IP hash");
    const cutoff = new Date(this.now().valueOf() - LOGIN_FAILURE_WINDOW_MS);
    return this.safely(() => {
      const usernameFailures = this.countConsecutiveFailures(
        eq(loginAttempts.normalizedUsername, normalizedUsername),
        cutoff,
      );
      const ipFailures = this.countConsecutiveFailures(
        eq(loginAttempts.ipHash, ipHash),
        cutoff,
      );
      return {
        usernameFailures,
        ipFailures,
        usernameLocked: usernameFailures >= LOGIN_FAILURE_LIMIT,
        ipLocked: ipFailures >= LOGIN_FAILURE_LIMIT,
      };
    });
  }

  recordLoginAttemptAndGetStatus(
    input: LoginAttemptInput,
  ): RecordedLoginAttemptStatus {
    const { normalizedUsername, ipHash, succeeded } =
      snapshotLoginAttemptInput(input);
    const attemptedAt = this.now();
    const cutoff = new Date(attemptedAt.valueOf() - LOGIN_FAILURE_WINDOW_MS);

    return this.safely(() =>
      this.database.transaction((transaction) => {
        const inserted = transaction
          .insert(loginAttempts)
          .values({
            normalizedUsername,
            ipHash,
            succeeded,
            attemptedAt,
          })
          .run();
        const countFailures = (condition: ReturnType<typeof eq>): number => {
          const attempts = transaction
            .select({ succeeded: loginAttempts.succeeded })
            .from(loginAttempts)
            .where(and(condition, gte(loginAttempts.attemptedAt, cutoff)))
            .orderBy(desc(loginAttempts.attemptedAt), desc(loginAttempts.id))
            .all();
          let failures = 0;
          for (const attempt of attempts) {
            if (attempt.succeeded) break;
            failures += 1;
          }
          return failures;
        };
        const usernameFailures = countFailures(
          eq(loginAttempts.normalizedUsername, normalizedUsername),
        );
        const ipFailures = countFailures(eq(loginAttempts.ipHash, ipHash));

        return {
          attempt: {
            id: Number(inserted.lastInsertRowid),
            normalizedUsername,
            ipHash,
            succeeded,
            attemptedAt,
          },
          status: {
            usernameFailures,
            ipFailures,
            usernameLocked: usernameFailures >= LOGIN_FAILURE_LIMIT,
            ipLocked: ipFailures >= LOGIN_FAILURE_LIMIT,
          },
        };
      }),
    );
  }

  recordSecurityEvent(input: SecurityEventInput): SecurityEventRecord {
    const userId = snapshotOwnDataProperty(input, "userId");
    const eventType = snapshotOwnDataProperty(input, "eventType");
    const inputMetadata = snapshotOwnDataProperty(input, "metadata");
    if (userId !== null && typeof userId !== "string") {
      throw new TypeError("Security event user ID must be a string or null");
    }
    if (
      typeof eventType !== "string" ||
      !SECURITY_EVENT_TYPE_PATTERN.test(eventType)
    ) {
      throw new TypeError("Security event type must use the safe ASCII format");
    }
    const metadata = snapshotSafeMetadata(
      inputMetadata as Record<string, unknown>,
    );
    const createdAt = this.now();
    return this.safely(() => {
      const result = this.database
        .insert(securityEvents)
        .values({
          userId,
          eventType,
          metadata,
          createdAt,
        })
        .run();
      return {
        id: Number(result.lastInsertRowid),
        userId,
        eventType,
        metadata,
        createdAt,
      };
    });
  }
}

export type {
  AuthenticatedUser,
  CreateSessionInput,
  CreateUserInput,
  LoginAttemptInput,
  LoginAttemptRecord,
  LoginFailureQuery,
  LoginFailureStatus,
  RecordedLoginAttemptStatus,
  SecurityEventInput,
  SecurityEventRecord,
  SessionRecord,
  UserRecord,
  UserRole,
} from "./auth-types";
