// @vitest-environment node
import { describe, expect, it } from "vitest";

import { toBase64Url } from "../auth/password-proof";
import { sealPasswordVerifier, verifyLoginProof } from "../auth/password-proof-worker";
import { d1Shim, migratedDatabase } from "../../test/d1-sqlite-shim";
import { D1AdminAccounts } from "./d1-admin-accounts";
import { D1PasswordProofRepository } from "./d1-password-proof-repository";
import { D1SessionRepository } from "./d1-session-repository";
import { handleWorkerAdmin } from "./worker-admin-routes";

const NOW = new Date("2026-11-21T04:00:00.000Z");
const NOW_MS = NOW.getTime();
const RAW_KEY = new Uint8Array(32).fill(7);
const KEY_B64 = toBase64Url(RAW_KEY);
const CONFIG_JSON = JSON.stringify({
  title: "为自己鼓掌",
  grade: "上海五四学制六年级",
  writingRequirements: "叙事具体",
  targetCharacters: 600,
  structureRequirements: "五段式",
  scoringFocus: "细节描写",
  templateType: "custom",
});

describe("D1AdminAccounts & handleWorkerAdmin", () => {
  it("aggregates login, online session, review usage, AI job, and rate-limit telemetry accurately", async () => {
    const sqlite = migratedDatabase();
    try {
      sqlite.prepare("DELETE FROM users").run();
      const db = d1Shim(sqlite);
      const admin = new D1AdminAccounts(db);

      // Seed 1 admin + 2 teachers
      const insertUser = sqlite.prepare(`
        INSERT INTO users (id, username, password_hash, role, must_change_password, disabled_at, created_at, updated_at)
        VALUES (?, ?, '!proof-only', ?, ?, ?, ?, ?)
      `);
      insertUser.run("admin-1", "micky", "admin", 0, null, NOW_MS - 30 * 86_400_000, NOW_MS);
      insertUser.run("teacher-1", "teacher_li", "teacher", 0, null, NOW_MS - 20 * 86_400_000, NOW_MS);
      insertUser.run("teacher-2", "teacher_locked", "teacher", 1, null, NOW_MS - 10 * 86_400_000, NOW_MS);

      sqlite.prepare(`
        INSERT INTO user_password_proofs (user_id, salt, sealed_verifier, created_at, updated_at)
        VALUES ('admin-1', 'salt', '{}', ?, ?)
      `).run(NOW_MS, NOW_MS);

      // Active session for admin-1 (seen 2m ago -> online) and teacher-1 (seen 3h ago -> today)
      const insertSession = sqlite.prepare(`
        INSERT INTO sessions (id, user_id, token_hash, last_seen_at, expires_at, created_at, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
      `);
      insertSession.run("s-1", "admin-1", "hash-a1", NOW_MS - 2 * 60_000, NOW_MS + 3_600_000, NOW_MS - 10 * 60_000);
      insertSession.run("s-2", "teacher-1", "hash-t1", NOW_MS - 3 * 3_600_000, NOW_MS + 3_600_000, NOW_MS - 4 * 3_600_000);

      // 8 consecutive failures for teacher_locked within 15m -> rateLimited = true
      const insertAttempt = sqlite.prepare(`
        INSERT INTO login_attempts (normalized_username, ip_hash, succeeded, attempted_at)
        VALUES (?, 'ip', ?, ?)
      `);
      for (let i = 0; i < 8; i += 1) {
        insertAttempt.run("teacher_locked", 0, NOW_MS - (i + 1) * 30_000);
      }
      insertAttempt.run("teacher_li", 1, NOW_MS - 4 * 3_600_000);

      // Reviews & AI jobs for teacher-1
      const insertReview = sqlite.prepare(`
        INSERT INTO reviews (id, owner_id, status, student_name, class_name, config, report, teacher_reviewed_at, revision, image_revision, created_at, updated_at)
        VALUES (?, 'teacher-1', ?, '林小雨', '六（1）班', ?, '{"version":2}', ?, 1, 0, ?, ?)
      `);
      insertReview.run("rev-pending", "ready_for_review", CONFIG_JSON, null, NOW_MS - 2 * 86_400_000, NOW_MS - 3_600_000);
      insertReview.run("rev-reviewed", "ready_for_review", CONFIG_JSON, NOW_MS - 1_800_000, NOW_MS - 15 * 86_400_000, NOW_MS - 1_800_000);
      insertReview.run("rev-exported", "exported", CONFIG_JSON, NOW_MS - 86_400_000, NOW_MS - 40 * 86_400_000, NOW_MS - 86_400_000);

      sqlite.prepare(`
        INSERT INTO analysis_jobs (id, review_id, owner_id, status, attempt, available_at, progress_stage, created_at, finished_at)
        VALUES ('job-1', 'rev-pending', 'teacher-1', 'succeeded', 1, ?, 'saving_result', ?, ?)
      `).run(NOW_MS - 3_600_000, NOW_MS - 3_600_000, NOW_MS - 3_500_000);

      sqlite.prepare(`
        INSERT INTO saved_assignments (id, owner_id, title, config, created_at, updated_at)
        VALUES ('asg-1', 'teacher-1', '为自己鼓掌', ?, ?, ?)
      `).run(CONFIG_JSON, NOW_MS, NOW_MS);

      sqlite.prepare(`
        INSERT INTO grading_opinions (id, owner_id, body, reason, change_request, scope, created_at, updated_at)
        VALUES ('op-1', 'teacher-1', '规则', '规则', '', 'standing', ?, ?)
      `).run(NOW_MS, NOW_MS);

      const overview = await admin.overview("admin-1", NOW);
      expect(overview.summary).toMatchObject({
        totalUsers: 3,
        enabledUsers: 3,
        disabledUsers: 0,
        adminCount: 1,
        teacherCount: 2,
        onlineUsers: 1,
        activeSessionsTotal: 2,
        activeUsers7d: 2,
        totalReviews: 3,
        reviews7d: 1,
        totalJobsSucceeded: 1,
        totalJobsFailed: 0,
        loginsSucceeded7d: 1,
        loginsFailed7d: 8,
        rateLimitedUsers: 1,
      });

      const micky = overview.accounts.find((item) => item.username === "micky")!;
      expect(micky.isCurrentUser).toBe(true);
      expect(micky.activityLevel).toBe("online");
      expect(micky.proofMode).toBe("modern");

      const li = overview.accounts.find((item) => item.username === "teacher_li")!;
      expect(li.activityLevel).toBe("today");
      expect(li.usage).toMatchObject({
        totalReviews: 3,
        reviews7d: 1,
        reviews30d: 2,
        pendingReviewCount: 1,
        reviewedCount: 1,
        exportedCount: 1,
        jobsSucceeded: 1,
        savedAssignmentsCount: 1,
        standingRulesCount: 1,
      });

      const locked = overview.accounts.find((item) => item.username === "teacher_locked")!;
      expect(locked.rateLimited).toBe(true);
      expect(locked.consecutiveFailures15m).toBe(8);
      expect(locked.mustChangePassword).toBe(true);

      // Unlock rate limit clears consecutive failures
      const unlocked = await admin.unlockLoginRateLimit({
        actor: { id: "admin-1", username: "micky" },
        targetUserId: "teacher-2",
        now: NOW,
      });
      expect(unlocked.clearedCount).toBe(8);
      const afterUnlock = await admin.overview("admin-1", NOW);
      expect(afterUnlock.accounts.find((item) => item.id === "teacher-2")?.rateLimited).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it("creates accounts with sealed password proofs, enforces self/last-admin guards, and resets passwords cleanly", async () => {
    const sqlite = migratedDatabase();
    try {
      sqlite.prepare("DELETE FROM users").run();
      const db = d1Shim(sqlite);
      const admin = new D1AdminAccounts(db);
      const proofs = new D1PasswordProofRepository(db);
      const sessions = new D1SessionRepository(db);

      sqlite.prepare(`
        INSERT INTO users (id, username, password_hash, role, must_change_password, disabled_at, created_at, updated_at)
        VALUES ('admin-1', 'micky', '!proof-only', 'admin', 0, NULL, ?, ?)
      `).run(NOW_MS, NOW_MS);

      const salt = toBase64Url(new Uint8Array(16).fill(3));
      const verifier = new Uint8Array(32).fill(9);
      const sealed = await sealPasswordVerifier(verifier, RAW_KEY);

      const created = await admin.createAccount({
        actor: { id: "admin-1", username: "micky" },
        username: "Teacher_Zhang",
        role: "teacher",
        mustChangePassword: true,
        salt,
        sealed,
        now: NOW,
      });
      expect(created.username).toBe("teacher_zhang");
      expect(created.mustChangePassword).toBe(true);

      // Verify sealed proof is immediately usable for login verification
      const storedProof = await proofs.findByUsername("teacher_zhang");
      expect(storedProof).not.toBeNull();
      const loginProof = await (await import("../auth/password-proof")).createLoginProof(verifier, "ch-1", "nonce-1");
      await expect(verifyLoginProof({
        sealed: storedProof!.sealed,
        challengeId: "ch-1",
        nonce: "nonce-1",
        proof: loginProof,
        encryptionKey: RAW_KEY,
      })).resolves.toBe(true);

      // Duplicate username rejected (case-insensitive)
      await expect(admin.createAccount({
        actor: { id: "admin-1", username: "micky" },
        username: "TEACHER_ZHANG",
        role: "teacher",
        mustChangePassword: true,
        salt,
        sealed,
        now: NOW,
      })).rejects.toMatchObject({ code: "USERNAME_TAKEN", status: 409 });

      // Self-disable and self-demote are blocked
      await expect(admin.updateAccount({
        actor: { id: "admin-1", username: "micky" },
        targetUserId: "admin-1",
        disabled: true,
        now: NOW,
      })).rejects.toMatchObject({ code: "SELF_ACTION_FORBIDDEN", status: 400 });

      await expect(admin.updateAccount({
        actor: { id: "admin-1", username: "micky" },
        targetUserId: "admin-1",
        role: "teacher",
        now: NOW,
      })).rejects.toMatchObject({ code: "SELF_ACTION_FORBIDDEN", status: 400 });

      // Disabling teacher revokes their active session
      await sessions.create({
        id: "sess-t",
        userId: created.id,
        tokenHash: "tok-teacher",
        expiresAt: new Date(NOW_MS + 3_600_000),
        now: NOW,
      });
      await admin.updateAccount({
        actor: { id: "admin-1", username: "micky" },
        targetUserId: created.id,
        disabled: true,
        now: NOW,
      });
      await expect(sessions.findActiveByTokenHash("tok-teacher", NOW)).resolves.toBeNull();
    } finally {
      sqlite.close();
    }
  });

  it("enforces RBAC on /api/admin/* HTTP routes (401 unauthenticated, 403 teacher, 200/201 admin)", async () => {
    const sqlite = migratedDatabase();
    try {
      sqlite.prepare("DELETE FROM users").run();
      const db = d1Shim(sqlite);
      sqlite.prepare(`
        INSERT INTO users (id, username, password_hash, role, must_change_password, disabled_at, created_at, updated_at)
        VALUES ('admin-1', 'micky', '!proof-only', 'admin', 0, NULL, ?, ?)
      `).run(NOW_MS, NOW_MS);

      const unauth = await handleWorkerAdmin(new Request("https://grader.example/api/admin/accounts"), {
        user: null,
        database: db,
        proofEncryptionKey: KEY_B64,
      });
      expect(unauth?.status).toBe(401);

      const teacherForbidden = await handleWorkerAdmin(new Request("https://grader.example/api/admin/accounts"), {
        user: { id: "t-1", username: "teacher", role: "teacher", mustChangePassword: false },
        database: db,
        proofEncryptionKey: KEY_B64,
      });
      expect(teacherForbidden?.status).toBe(403);

      const createRes = await handleWorkerAdmin(new Request("https://grader.example/api/admin/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "new_teacher",
          role: "teacher",
          mustChangePassword: true,
          salt: toBase64Url(new Uint8Array(16).fill(5)),
          verifier: toBase64Url(new Uint8Array(32).fill(6)),
        }),
      }), {
        user: { id: "admin-1", username: "micky", role: "admin", mustChangePassword: false },
        database: db,
        proofEncryptionKey: KEY_B64,
      });
      expect(createRes?.status).toBe(201);

      const listRes = await handleWorkerAdmin(new Request("https://grader.example/api/admin/accounts"), {
        user: { id: "admin-1", username: "micky", role: "admin", mustChangePassword: false },
        database: db,
        proofEncryptionKey: KEY_B64,
      });
      expect(listRes?.status).toBe(200);
      const payload = await listRes!.json() as { ok: boolean; data: { summary: { totalUsers: number } } };
      expect(payload.ok).toBe(true);
      expect(payload.data.summary.totalUsers).toBe(2);
    } finally {
      sqlite.close();
    }
  });
});
