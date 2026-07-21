// @vitest-environment node

import { Buffer } from "node:buffer";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openAppDatabase } from "../db/client";
import {
  AuthRecordNotFoundError,
  AuthRepository,
  AuthStorageError,
  DuplicateSessionTokenError,
  DuplicateUsernameError,
  InvalidSecurityMetadataError,
} from "./auth-repository";
import {
  DUMMY_ARGON2ID_HASH,
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  hashSourceIp,
  normalizeUsername,
  verifyPassword,
} from "./password";
import { AuthService } from "./auth-service";
import { parseArgs } from "../../scripts/accounts";

describe("password security primitives", () => {
  it("normalizes usernames to one trim-and-lowercase storage form", () => {
    expect(normalizeUsername("  Teacher.One_2-3  ")).toBe("teacher.one_2-3");
  });

  it.each([
    "",
    "   ",
    "ab",
    "a".repeat(33),
    "教师",
    "Ｔeacher",
    "Kelvin",
    "KKK",
    "teacher name",
    "teacher@example.com",
    ". leading",
  ])("rejects an invalid or ambiguous username: %j", (username) => {
    expect(() => normalizeUsername(username)).toThrow(TypeError);
  });

  it("hashes and verifies non-empty passwords with Argon2id", async () => {
    const password = "correct horse battery staple";
    const hash = await hashPassword(password);

    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain(password);
    await expect(verifyPassword(hash, password)).resolves.toBe(true);
    await expect(verifyPassword(hash, "wrong password")).resolves.toBe(false);
  });

  it("rejects empty passwords and safely handles invalid or non-Argon2id hashes", async () => {
    await expect(hashPassword("")).rejects.toThrow(TypeError);
    await expect(verifyPassword(DUMMY_ARGON2ID_HASH, "")).rejects.toThrow(TypeError);
    await expect(verifyPassword(DUMMY_ARGON2ID_HASH, "not the password")).resolves.toBe(
      false,
    );
    await expect(verifyPassword("not-a-hash", "password")).resolves.toBe(false);
    await expect(
      verifyPassword("$argon2i$v=19$m=4096,t=3,p=1$c2FsdA$aGFzaA", "password"),
    ).resolves.toBe(false);
  });

  it("generates 32-byte base64url session tokens and hashes them with SHA-256", () => {
    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken);

    expect(rawToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(rawToken, "base64url")).toHaveLength(32);
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHash).toBe(hashSessionToken(rawToken));
  });

  it("HMAC-hashes source IPs with a caller-provided independent secret", () => {
    const ip = "203.0.113.42";
    const first = hashSourceIp(ip, "independent-login-audit-secret");
    const second = hashSourceIp(ip, "another-independent-secret");

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain(ip);
    expect(() => hashSourceIp("", "secret")).toThrow(TypeError);
    expect(() => hashSourceIp(ip, "")).toThrow(TypeError);
  });
});

describe("AuthRepository", () => {
  let opened: ReturnType<typeof openAppDatabase>;
  let now: Date;
  let repository: AuthRepository;
  let nextId: number;

  beforeEach(() => {
    opened = openAppDatabase(":memory:");
    now = new Date("2026-07-21T02:00:00.000Z");
    nextId = 1;
    repository = new AuthRepository(opened.db, {
      now: () => new Date(now),
      randomUUID: () => `test-user-${nextId++}`,
    });
  });

  afterEach(() => opened.close());

  async function createUser(username = "Teacher.One") {
    return repository.createUser({
      username,
      passwordHash: await hashPassword("never stored as plaintext"),
      role: "teacher",
    });
  }

  function createSession(userId: string, rawToken = generateSessionToken()) {
    return {
      rawToken,
      record: repository.createSession({
        userId,
        tokenHash: hashSessionToken(rawToken),
        expiresAt: new Date(now.valueOf() + 60 * 60 * 1000),
      }),
    };
  }

  it("creates and finds a normalized user without storing plaintext passwords", async () => {
    const passwordHash = await hashPassword("test-only-plaintext-password");
    const user = repository.createUser({
      username: "  ADMIN.One  ",
      passwordHash,
      role: "admin",
      mustChangePassword: true,
    });

    expect(user).toMatchObject({
      id: "test-user-1",
      username: "admin.one",
      role: "admin",
      mustChangePassword: true,
      passwordHash,
      disabledAt: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(repository.findUserByUsername(" ADMIN.ONE ")).toEqual(user);

    const stored = opened.sqlite
      .prepare("SELECT username, password_hash FROM users WHERE id = ?")
      .get(user.id) as { username: string; password_hash: string };
    expect(stored).toEqual({ username: "admin.one", password_hash: passwordHash });
    expect(JSON.stringify(stored)).not.toContain("test-only-plaintext-password");
  });

  it("rejects accessor-backed user input before validated values can be replaced", async () => {
    const validHash = await hashPassword("valid password");
    let usernameReads = 0;
    let passwordHashReads = 0;
    const input = {} as Parameters<AuthRepository["createUser"]>[0];
    Object.defineProperties(input, {
      username: {
        get: () => (++usernameReads === 1 ? "valid.user" : "Kelvin"),
      },
      passwordHash: {
        get: () => (++passwordHashReads === 1 ? validHash : "plaintext-password"),
      },
      role: { value: "teacher" },
      mustChangePassword: { value: false },
    });

    expect(() => repository.createUser(input)).toThrow(TypeError);
    expect(repository.findUserByUsername("valid.user")).toBeNull();
    expect(
      opened.sqlite.prepare("SELECT count(*) AS count FROM users WHERE id != ?").get(
        "local-admin",
      ),
    ).toEqual({ count: 0 });
  });

  it("rejects normalized duplicate usernames with a stable sanitized error", async () => {
    await createUser(" Teacher.One ");

    let thrown: unknown;
    try {
      await createUser("teacher.one");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DuplicateUsernameError);
    expect((thrown as Error).message).toBe("Username is already in use");
    expect((thrown as Error).message).not.toMatch(/SQL|password|hash/i);
  });

  it("rejects invalid roles before they reach SQLite", async () => {
    const passwordHash = await hashPassword("password");
    expect(() =>
      repository.createUser({
        username: "teacher.two",
        passwordHash,
        role: "owner" as "teacher",
      }),
    ).toThrow(TypeError);
  });

  it("rejects non-boolean mustChangePassword values before they reach SQLite", async () => {
    const passwordHash = await hashPassword("password");
    for (const value of ["true", 1]) {
      expect(() =>
        repository.createUser({
          username: "invalid.boolean",
          passwordHash,
          role: "teacher",
          mustChangePassword: value as unknown as boolean,
        }),
      ).toThrow(TypeError);
    }
    expect(repository.findUserByUsername("invalid.boolean")).toBeNull();

    const user = await createUser("valid.boolean");
    const session = createSession(user.id);
    expect(() =>
      repository.updatePasswordHash(
        user.id,
        passwordHash,
        "false" as unknown as boolean,
      ),
    ).toThrow(TypeError);
    expect(
      repository.findValidSessionByTokenHash(hashSessionToken(session.rawToken)),
    ).not.toBeNull();
  });

  it("stores only token hashes and returns a safe user view for valid sessions", async () => {
    const user = await createUser();
    const { rawToken, record } = createSession(user.id);
    const tokenHash = hashSessionToken(rawToken);

    const stored = opened.sqlite
      .prepare("SELECT token_hash FROM sessions WHERE id = ?")
      .get(record.id) as { token_hash: string };
    expect(stored.token_hash).toBe(tokenHash);
    expect(stored.token_hash).toHaveLength(64);
    expect(JSON.stringify(stored)).not.toContain(rawToken);
    expect(repository.findValidSessionByTokenHash(rawToken)).toBeNull();
    expect(repository.findValidSessionByTokenHash(tokenHash)).toMatchObject({
      id: record.id,
      user: {
        id: user.id,
        username: user.username,
        role: "teacher",
        mustChangePassword: false,
      },
    });
    expect(repository.findValidSessionByTokenHash(tokenHash)).not.toHaveProperty(
      "tokenHash",
    );
    expect(repository.findValidSessionByTokenHash(tokenHash)?.user).not.toHaveProperty(
      "passwordHash",
    );
  });

  it("rejects accessor-backed session input before validation and persistence diverge", async () => {
    const activeUser = await createUser("active.user");
    const disabledUser = await createUser("disabled.user");
    repository.disableUser(disabledUser.id);
    const validHash = hashSessionToken("valid-session-secret");
    let userIdReads = 0;
    let tokenHashReads = 0;
    const input = {} as Parameters<AuthRepository["createSession"]>[0];
    Object.defineProperties(input, {
      userId: {
        get: () => (++userIdReads === 1 ? activeUser.id : disabledUser.id),
      },
      tokenHash: {
        get: () => (++tokenHashReads === 1 ? validHash : "raw-session-secret"),
      },
      expiresAt: { value: new Date(now.valueOf() + 60 * 60 * 1000) },
    });

    expect(() => repository.createSession(input)).toThrow(TypeError);
    expect(opened.sqlite.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({
      count: 0,
    });
  });

  it("snapshots session expiration without invoking an overridden valueOf", async () => {
    const user = await createUser();
    const expectedExpiration = new Date(now.valueOf() + 60 * 60 * 1000);
    class SwitchingDate extends Date {
      private reads = 0;

      override valueOf(): number {
        this.reads += 1;
        return this.reads === 1
          ? expectedExpiration.valueOf()
          : now.valueOf() - 1000;
      }
    }

    const session = repository.createSession({
      userId: user.id,
      tokenHash: hashSessionToken("expiration-session-secret"),
      expiresAt: new SwitchingDate(expectedExpiration),
    });

    expect(session.expiresAt).toEqual(expectedExpiration);
  });

  it("treats expiresAt equal to now as invalid", async () => {
    const user = await createUser();
    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken);
    repository.createSession({ userId: user.id, tokenHash, expiresAt: now });

    expect(repository.findValidSessionByTokenHash(tokenHash)).toBeNull();
  });

  it("invalidates sessions immediately when revoked, disabled, or password changes", async () => {
    const user = await createUser();
    const first = createSession(user.id);
    repository.revokeSession(first.record.id);
    expect(repository.findValidSessionByTokenHash(hashSessionToken(first.rawToken))).toBeNull();

    const second = createSession(user.id);
    repository.disableUser(user.id);
    expect(repository.findValidSessionByTokenHash(hashSessionToken(second.rawToken))).toBeNull();

    const restored = repository.restoreUser(user.id);
    expect(restored.disabledAt).toBeNull();
    const third = createSession(user.id);
    const updatedHash = await hashPassword("updated password");
    const updated = repository.updatePasswordHash(user.id, updatedHash, false);
    expect(updated.passwordHash).toBe(updatedHash);
    expect(updated.mustChangePassword).toBe(false);
    expect(repository.findValidSessionByTokenHash(hashSessionToken(third.rawToken))).toBeNull();
  });

  it("cannot create a session while disabled that becomes valid after restoration", async () => {
    const user = await createUser();
    repository.disableUser(user.id);
    const rawToken = generateSessionToken();
    const tokenHash = hashSessionToken(rawToken);

    expect(() =>
      repository.createSession({
        userId: user.id,
        tokenHash,
        expiresAt: new Date(now.valueOf() + 60 * 60 * 1000),
      }),
    ).toThrow(AuthStorageError);

    repository.restoreUser(user.id);
    expect(repository.findValidSessionByTokenHash(tokenHash)).toBeNull();
  });

  it("rejects malformed Argon2id hashes before create or password update", async () => {
    expect(() =>
      repository.createUser({
        username: "invalid.hash",
        passwordHash: "$argon2id$garbage",
        role: "teacher",
      }),
    ).toThrow(TypeError);
    expect(repository.findUserByUsername("invalid.hash")).toBeNull();
    expect(() =>
      repository.createUser({
        username: "extreme.hash",
        passwordHash:
          "$argon2id$v=19$m=134217728,t=1,p=16777216$c2FsdHNhbHQ$aGFzaA",
        role: "teacher",
      }),
    ).toThrow(TypeError);

    const user = await createUser();
    const session = createSession(user.id);
    expect(() =>
      repository.updatePasswordHash(user.id, "$argon2id$plaintext-password"),
    ).toThrow(TypeError);
    expect(repository.findUserByUsername(user.username)?.passwordHash).toBe(
      user.passwordHash,
    );
    expect(
      repository.findValidSessionByTokenHash(hashSessionToken(session.rawToken)),
    ).not.toBeNull();
  });

  it("revokes every existing session in the same user-scoped operation", async () => {
    const user = await createUser();
    const first = createSession(user.id);
    const second = createSession(user.id);

    expect(repository.revokeAllUserSessions(user.id)).toBe(2);
    expect(repository.findValidSessionByTokenHash(hashSessionToken(first.rawToken))).toBeNull();
    expect(repository.findValidSessionByTokenHash(hashSessionToken(second.rawToken))).toBeNull();
  });

  it("refreshes lastSeenAt and extends expiration to exactly twelve hours", async () => {
    const user = await createUser();
    const session = createSession(user.id);
    now = new Date("2026-07-21T02:30:00.000Z");

    const refreshed = repository.refreshSession(session.record.id);

    expect(refreshed).toMatchObject({
      id: session.record.id,
      lastSeenAt: now,
      expiresAt: new Date(now.valueOf() + 12 * 60 * 60 * 1000),
    });
  });

  it("counts five consecutive failures by username independently from IP", () => {
    for (let index = 0; index < 5; index += 1) {
      repository.recordLoginAttempt({
        username: " Missing.User ",
        ipHash: hashSourceIp(`203.0.113.${index}`, "audit-secret"),
        succeeded: false,
      });
    }

    const status = repository.getLoginFailureStatus({
      username: "missing.user",
      ipHash: hashSourceIp("198.51.100.99", "audit-secret"),
    });
    expect(status).toEqual({
      usernameFailures: 5,
      ipFailures: 0,
      usernameLocked: true,
      ipLocked: false,
    });
  });

  it("counts five consecutive failures by IP independently from username", () => {
    const ipHash = hashSourceIp("203.0.113.8", "audit-secret");
    for (let index = 0; index < 5; index += 1) {
      repository.recordLoginAttempt({
        username: `teacher.${index}`,
        ipHash,
        succeeded: false,
      });
    }

    expect(
      repository.getLoginFailureStatus({ username: "unseen.user", ipHash }),
    ).toEqual({
      usernameFailures: 0,
      ipFailures: 5,
      usernameLocked: false,
      ipLocked: true,
    });
  });

  it("resets consecutive counts after success and ignores failures outside 15 minutes", () => {
    const ipHash = hashSourceIp("203.0.113.10", "audit-secret");
    for (let index = 0; index < 3; index += 1) {
      repository.recordLoginAttempt({ username: "teacher.one", ipHash, succeeded: false });
    }
    repository.recordLoginAttempt({ username: "teacher.one", ipHash, succeeded: true });
    for (let index = 0; index < 2; index += 1) {
      repository.recordLoginAttempt({ username: "teacher.one", ipHash, succeeded: false });
    }
    expect(repository.getLoginFailureStatus({ username: "teacher.one", ipHash })).toEqual({
      usernameFailures: 2,
      ipFailures: 2,
      usernameLocked: false,
      ipLocked: false,
    });

    now = new Date(now.valueOf() + 15 * 60 * 1000 + 1);
    expect(repository.getLoginFailureStatus({ username: "teacher.one", ipHash })).toEqual({
      usernameFailures: 0,
      ipFailures: 0,
      usernameLocked: false,
      ipLocked: false,
    });
  });

  it("atomically records a login attempt and returns the post-write lock status", () => {
    const ipHash = hashSourceIp("203.0.113.11", "audit-secret");
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = repository.recordLoginAttemptAndGetStatus({
        username: "teacher.atomic",
        ipHash,
        succeeded: false,
      });
      expect(result.attempt.normalizedUsername).toBe("teacher.atomic");
      expect(result.status).toEqual({
        usernameFailures: attempt,
        ipFailures: attempt,
        usernameLocked: attempt === 5,
        ipLocked: attempt === 5,
      });
    }

    const reset = repository.recordLoginAttemptAndGetStatus({
      username: "teacher.atomic",
      ipHash,
      succeeded: true,
    });
    expect(reset.lockedBeforeAttempt).toBe(true);
    expect(reset.attempt.succeeded).toBe(false);
    expect(reset.status.usernameLocked).toBe(true);
  });

  it("rejects accessor-backed login failure queries before validated values change", () => {
    const validHash = hashSourceIp("203.0.113.12", "audit-secret");
    let ipHashReads = 0;
    const query = {} as Parameters<AuthRepository["getLoginFailureStatus"]>[0];
    Object.defineProperties(query, {
      username: { value: "teacher.query" },
      ipHash: {
        get: () => (++ipHashReads === 1 ? validHash : "unvalidated-ip-value"),
      },
    });

    expect(() => repository.getLoginFailureStatus(query)).toThrow(TypeError);
  });

  it("stores normalized usernames and only HMAC IP values for login attempts", () => {
    const rawIp = "198.51.100.20";
    const ipHash = hashSourceIp(rawIp, "audit-secret");
    repository.recordLoginAttempt({
      username: "  Unknown.User ",
      ipHash,
      succeeded: false,
    });

    const stored = opened.sqlite.prepare("SELECT * FROM login_attempts").get() as Record<
      string,
      unknown
    >;
    expect(stored.normalized_username).toBe("unknown.user");
    expect(stored.ip_hash).toBe(ipHash);
    expect(JSON.stringify(stored)).not.toContain(rawIp);
  });

  it("rejects non-boolean login attempt outcomes before they reach SQLite", () => {
    const ipHash = hashSourceIp("198.51.100.21", "audit-secret");
    for (const value of ["false", 0]) {
      expect(() =>
        repository.recordLoginAttempt({
          username: "unknown.user",
          ipHash,
          succeeded: value as unknown as boolean,
        }),
      ).toThrow(TypeError);
    }
    expect(opened.sqlite.prepare("SELECT count(*) AS count FROM login_attempts").get()).toEqual(
      { count: 0 },
    );
  });

  it.each(["recordLoginAttempt", "recordLoginAttemptAndGetStatus"] as const)(
    "rejects accessor-backed input in %s before raw IP data can be stored",
    (method) => {
      const validHash = hashSourceIp("198.51.100.22", "audit-secret");
      let ipHashReads = 0;
      const input = {} as Parameters<AuthRepository[typeof method]>[0];
      Object.defineProperties(input, {
        username: { value: "unknown.user" },
        ipHash: {
          get: () => (++ipHashReads === 1 ? validHash : "198.51.100.22"),
        },
        succeeded: { value: false },
      });

      expect(() => repository[method](input)).toThrow(TypeError);
      expect(
        opened.sqlite.prepare("SELECT count(*) AS count FROM login_attempts").get(),
      ).toEqual({ count: 0 });
    },
  );

  it.each([
    { password: "secret" },
    { nested: { PaSsWoRdHaSh: "hash" } },
    { nested: [{ token: "raw-token" }] },
    { apiKey: "key" },
    { cookie: "session=value" },
    { authorization: "Bearer value" },
    { essayBody: "作文正文" },
    { essayContent: "an ordinary English sentence" },
    { nested: { Composition_Content: "ordinary text" } },
    { nested: [{ "作文-内容": "普通文本" }] },
    { imageDataUrl: "not-even-needed" },
    { preview: "data:image/png;base64,AAAA" },
  ])("rejects sensitive security event metadata: %j", (metadata) => {
    expect(() =>
      repository.recordSecurityEvent({
        userId: null,
        eventType: "login_failed",
        metadata,
      }),
    ).toThrow(InvalidSecurityMetadataError);
  });

  it.each([
    { "ｅｓｓａｙContent": "full essay" },
    { nested: { "𝖊ssayContent": "full essay" } },
    { nested: { "еssayContent": "full essay" } },
    { "": "empty key" },
    { [`a${"b".repeat(64)}`]: "overlong key" },
    { "unsafe$key": "symbol key" },
  ])("rejects unsafe metadata keys: %j", (metadata) => {
    expect(() =>
      repository.recordSecurityEvent({
        userId: null,
        eventType: "metadata_rejected",
        metadata,
      }),
    ).toThrow(InvalidSecurityMetadataError);
  });

  it("rejects metadata arrays that exceed the safe length budget", () => {
    const sparse = new Array<unknown>(101);
    expect(() =>
      repository.recordSecurityEvent({
        userId: null,
        eventType: "metadata_rejected",
        metadata: { items: sparse },
      }),
    ).toThrow(InvalidSecurityMetadataError);
  });

  it("rejects metadata that exceeds depth, node, or string budgets", () => {
    let deeplyNested: Record<string, unknown> = { value: true };
    for (let depth = 0; depth < 9; depth += 1) {
      deeplyNested = { nested: deeplyNested };
    }
    const tooManyNodes = Object.fromEntries(
      Array.from({ length: 513 }, (_, index) => [`field${index}`, index]),
    );

    for (const metadata of [
      deeplyNested,
      tooManyNodes,
      { message: "x".repeat(16_385) },
    ]) {
      expect(() =>
        repository.recordSecurityEvent({
          userId: null,
          eventType: "metadata_rejected",
          metadata,
        }),
      ).toThrow(InvalidSecurityMetadataError);
    }
  });

  it.each(["object", "array"] as const)(
    "rejects oversized %s metadata before reading property descriptors",
    (kind) => {
      const target: Record<string, unknown> | unknown[] =
        kind === "array" ? [] : {};
      for (let index = 0; index < 513; index += 1) {
        Object.defineProperty(target, `field${index}`, {
          enumerable: kind === "object",
          value: index,
        });
      }
      let descriptorReads = 0;
      const metadata = new Proxy(target, {
        getOwnPropertyDescriptor: (proxyTarget, key) => {
          descriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(proxyTarget, key);
        },
      });

      expect(() =>
        repository.recordSecurityEvent({
          userId: null,
          eventType: "metadata_rejected",
          metadata: metadata as Record<string, unknown>,
        }),
      ).toThrow(InvalidSecurityMetadataError);
      expect(descriptorReads).toBe(0);
    },
  );

  it.each([
    "",
    "   ",
    "password=secret",
    "data:image/png;base64,AAAA",
    "登录失败",
    "Login_Failed",
    `a${"b".repeat(64)}`,
  ])("rejects an unsafe security event type: %j", (eventType) => {
    expect(() =>
      repository.recordSecurityEvent({
        userId: null,
        eventType,
        metadata: { reason: "validation" },
      }),
    ).toThrow(TypeError);
  });

  it("stores ordinary JSON security event metadata", async () => {
    const user = await createUser();
    const event = repository.recordSecurityEvent({
      userId: user.id,
      eventType: "password_changed",
      metadata: { reason: "user_request", context: { sessionCount: 2 } },
    });

    expect(event).toMatchObject({
      userId: user.id,
      eventType: "password_changed",
      metadata: { reason: "user_request", context: { sessionCount: 2 } },
      createdAt: now,
    });
  });

  it("rejects accessor metadata instead of validating and serializing different values", () => {
    let readCount = 0;
    const metadata = {} as Record<string, unknown>;
    Object.defineProperty(metadata, "preview", {
      enumerable: true,
      get: () => {
        readCount += 1;
        return readCount === 1 ? "safe" : "data:image/png;base64,AAAA";
      },
    });

    expect(() =>
      repository.recordSecurityEvent({
        userId: null,
        eventType: "adversarial_metadata",
        metadata,
      }),
    ).toThrow(InvalidSecurityMetadataError);
    expect(opened.sqlite.prepare("SELECT count(*) AS count FROM security_events").get()).toEqual(
      { count: 0 },
    );
  });

  it.each([
    ["root object", { reason: "safe" }, { reason: "safe" }],
    [
      "nested object",
      { context: { reason: "safe" } },
      { context: { reason: "safe" } },
    ],
    ["nested array", { items: [] }, { items: [] }],
  ] as const)(
    "isolates %s metadata snapshots from prototype toJSON pollution",
    (_name, target, expected) => {
      const originalToJson = Object.getOwnPropertyDescriptor(
        Object.prototype,
        "toJSON",
      );
      const metadata = new Proxy(target, {
        ownKeys: (proxyTarget) => {
          Object.defineProperty(Object.prototype, "toJSON", {
            configurable: true,
            value: () => ({ password: "prototype-injected" }),
          });
          return Reflect.ownKeys(proxyTarget);
        },
      });
      let rawMetadata = "";

      try {
        repository.recordSecurityEvent({
          userId: null,
          eventType: "prototype_pollution_blocked",
          metadata: metadata as Record<string, unknown>,
        });
        rawMetadata = (
          opened.sqlite.prepare("SELECT metadata FROM security_events").get() as {
            metadata: string;
          }
        ).metadata;
      } finally {
        if (originalToJson) {
          Object.defineProperty(Object.prototype, "toJSON", originalToJson);
        } else {
          delete (Object.prototype as { toJSON?: unknown }).toJSON;
        }
      }

      expect(rawMetadata).not.toMatch(/password|prototype-injected/i);
      expect(JSON.parse(rawMetadata)).toEqual(expected);
    },
  );

  it.each(["userId", "eventType", "metadata"] as const)(
    "rejects accessor-backed security event %s input",
    (accessorField) => {
      let eventTypeReads = 0;
      const input = {} as Parameters<AuthRepository["recordSecurityEvent"]>[0];
      Object.defineProperties(input, {
        userId:
          accessorField === "userId" ? { get: () => null } : { value: null },
        eventType:
          accessorField === "eventType"
            ? {
                get: () =>
                  ++eventTypeReads <= 2 ? "login_failed" : "password=secret",
              }
            : { value: "login_failed" },
        metadata:
          accessorField === "metadata"
            ? { get: () => ({ reason: "safe" }) }
            : { value: { reason: "safe" } },
      });

      expect(() => repository.recordSecurityEvent(input)).toThrow(TypeError);
      expect(
        opened.sqlite.prepare("SELECT count(*) AS count FROM security_events").get(),
      ).toEqual({ count: 0 });
    },
  );

  it("maps database failures to stable errors without SQL or credential material", async () => {
    const user = await createUser();
    const secretTokenHash = hashSessionToken("test-secret-session-token");
    repository.createSession({
      userId: user.id,
      tokenHash: secretTokenHash,
      expiresAt: new Date(now.valueOf() + 1000),
    });

    let conflict: unknown;
    try {
      repository.createSession({
        userId: user.id,
        tokenHash: secretTokenHash,
        expiresAt: new Date(now.valueOf() + 1000),
      });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(DuplicateSessionTokenError);
    expect((conflict as Error).message).toBe(
      "Authentication record conflicts with existing data",
    );
    expect((conflict as Error).message).not.toMatch(
      /sql|password|token|hash|secret|cookie|authorization/i,
    );

    try {
      repository.createSession({
        userId: "missing-user",
        tokenHash: hashSessionToken("another-secret-token"),
        expiresAt: new Date(now.valueOf() + 1000),
      });
      throw new Error("expected createSession to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthStorageError);
      expect((error as Error).message).toBe("Authentication storage operation failed");
      expect((error as Error).message).not.toMatch(/SQL|FOREIGN|hash|token|secret/i);
    }
  });

  it("uses a stable not-found domain error for mutation targets", async () => {
    const passwordHash = await hashPassword("not included in errors");
    expect(() => repository.updatePasswordHash("missing", passwordHash)).toThrow(
      AuthRecordNotFoundError,
    );
  });

  it("maps database driver TypeErrors to the stable storage error", () => {
    const local = openAppDatabase(":memory:");
    const closedRepository = new AuthRepository(local.db);
    local.close();

    expect(() => closedRepository.findUserByUsername("teacher.one")).toThrow(
      AuthStorageError,
    );
  });

  class MisleadingDate extends Date {
    override getTime(): number {
      return Date.prototype.getTime.call(this) + 2 * 60 * 60 * 1000;
    }

    override valueOf(): number {
      return Date.prototype.getTime.call(this) + 2 * 60 * 60 * 1000;
    }
  }

  function repositoryWithMisleadingClock() {
    return new AuthRepository(opened.db, {
      now: () => new MisleadingDate(now),
      randomUUID: () => `misleading-clock-${nextId++}`,
    });
  }

  it("stores the clock's internal time instead of overridden date methods", () => {
    const clockRepository = repositoryWithMisleadingClock();
    const ipHash = hashSourceIp("198.51.100.30", "audit-secret");

    const attempt = clockRepository.recordLoginAttempt({
      username: "clock.user",
      ipHash,
      succeeded: false,
    });

    expect(attempt.attemptedAt).toEqual(now);
    expect(
      opened.sqlite.prepare("SELECT attempted_at FROM login_attempts").get(),
    ).toEqual({ attempted_at: now.valueOf() });
  });

  it("uses the clock's internal time for login failure cutoffs", () => {
    const ipHash = hashSourceIp("198.51.100.31", "audit-secret");
    repository.recordLoginAttempt({
      username: "clock.user",
      ipHash,
      succeeded: false,
    });

    expect(
      repositoryWithMisleadingClock().getLoginFailureStatus({
        username: "clock.user",
        ipHash,
      }),
    ).toMatchObject({ usernameFailures: 1, ipFailures: 1 });
  });

  it("uses the clock's internal time when refreshing a session", async () => {
    const user = await createUser("clock.user");
    const session = createSession(user.id);
    now = new Date(now.valueOf() + 30 * 60 * 1000);

    const refreshed = repositoryWithMisleadingClock().refreshSession(session.record.id);

    expect(refreshed.lastSeenAt).toEqual(now);
    expect(refreshed.expiresAt).toEqual(
      new Date(now.valueOf() + 12 * 60 * 60 * 1000),
    );
  });
});

describe("AuthService", () => {
  it("returns a raw session token while persisting only its hash", async () => {
    const opened = openAppDatabase(":memory:");
    const repository = new AuthRepository(opened.db, {
      now: () => new Date("2026-07-21T02:00:00.000Z"),
      randomUUID: (() => {
        let n = 1;
        return () => `service-${n++}`;
      })(),
    });
    const service = new AuthService(repository, {
      now: () => new Date("2026-07-21T02:00:00.000Z"),
      randomSessionToken: () => generateSessionToken(),
    });
    await service.createInvitedUser({
      username: "teacher.service",
      password: "correct horse",
      role: "teacher",
    });
    const result = await service.login({
      username: "teacher.service",
      password: "correct horse",
      ipHash: hashSourceIp("127.0.0.1", "test-secret"),
    });
    expect(result.rawToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(result.user).not.toHaveProperty("passwordHash");
    expect(
      opened.sqlite.prepare("SELECT token_hash FROM sessions").get(),
    ).toEqual({ token_hash: hashSessionToken(result.rawToken) });
    opened.close();
  });

  it("uses a uniform error for unknown, disabled, and sentinel users", async () => {
    const opened = openAppDatabase(":memory:");
    const repository = new AuthRepository(opened.db);
    const service = new AuthService(repository);
    const ipHash = hashSourceIp("127.0.0.1", "test-secret");
    await expect(
      service.login({ username: "missing.user", password: "wrong", ipHash }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await expect(
      service.login({ username: "local-admin", password: "wrong", ipHash }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    opened.close();
  });

  it("rejects a third teacher but permits another administrator", async () => {
    const opened = openAppDatabase(":memory:");
    const repository = new AuthRepository(opened.db);
    const service = new AuthService(repository);
    await service.createInvitedUser({ username: "teacher.one", password: "one", role: "teacher" });
    await service.createInvitedUser({ username: "teacher.two", password: "two", role: "teacher" });
    await expect(
      service.createInvitedUser({ username: "teacher.three", password: "three", role: "teacher" }),
    ).rejects.toMatchObject({ code: "USER_LIMIT_REACHED" });
    await expect(
      service.createInvitedUser({ username: "admin.two", password: "admin password", role: "admin" }),
    ).resolves.toMatchObject({ role: "admin" });
    await expect(
      service.createInvitedUser({ username: "teacher.one", password: "new password", role: "teacher" }),
    ).rejects.toMatchObject({ code: "USER_ALREADY_EXISTS" });
    opened.close();
  });

  it("rejects a correct password after the username is already locked", async () => {
    const opened = openAppDatabase(":memory:");
    const repository = new AuthRepository(opened.db);
    const service = new AuthService(repository);
    await service.createInvitedUser({ username: "locked.user", password: "correct password", role: "admin" });
    const ipHash = hashSourceIp("127.0.0.1", "lock-test");
    for (let index = 0; index < 5; index += 1) {
      await expect(service.login({ username: "locked.user", password: "wrong", ipHash })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    }
    await expect(service.login({ username: "locked.user", password: "correct password", ipHash })).rejects.toMatchObject({ code: "LOGIN_RATE_LIMITED" });
    expect(opened.sqlite.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
    opened.close();
  });

  it("atomically limits concurrent teacher invitations to two", async () => {
    const opened = openAppDatabase(":memory:");
    const service = new AuthService(new AuthRepository(opened.db));
    const results = await Promise.allSettled([
      service.createInvitedUser({ username: "parallel.one", password: "password one", role: "teacher" }),
      service.createInvitedUser({ username: "parallel.two", password: "password two", role: "teacher" }),
      service.createInvitedUser({ username: "parallel.three", password: "password three", role: "teacher" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected" && result.reason?.code === "USER_LIMIT_REACHED")).toHaveLength(1);
    opened.close();
  });

  it.each(["", "not-a-hash", "A".repeat(64), null])("rejects malformed ipHash safely: %j", async (ipHash) => {
    const opened = openAppDatabase(":memory:");
    const service = new AuthService(new AuthRepository(opened.db));
    await expect(service.login({ username: "missing.user", password: "wrong", ipHash: ipHash as string })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    expect(opened.sqlite.prepare("SELECT count(*) AS count FROM login_attempts").get()).toEqual({ count: 0 });
    opened.close();
  });
});

describe("local accounts CLI", () => {
  it("rejects password flags without echoing their value", () => {
    expect(() => parseArgs(["create", "--username", "teacher.cli", "--password=secret"]))
      .toThrow("--password is not accepted");
  });
});

describe("AuthRepository user accessors", () => {
  it("finds users by stable id and lists safe records", async () => {
    const opened = openAppDatabase(":memory:");
    const repository = new AuthRepository(opened.db, { randomUUID: () => "accessor-user" });
    const created = repository.createUser({
      username: "accessor.user",
      passwordHash: await hashPassword("password"),
      role: "teacher",
    });
    expect(repository.findUserById(created.id)).toMatchObject({ id: created.id, username: created.username });
    expect(repository.findUserById("missing-user")).toBeNull();
    expect(repository.listUsers().map((user) => user.id)).toContain(created.id);
    opened.close();
  });
});
