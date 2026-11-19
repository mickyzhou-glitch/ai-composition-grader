// @vitest-environment node
import { describe, expect, it } from "vitest";

import { d1Shim, migratedDatabase } from "../../test/d1-sqlite-shim";
import {
  CONSUMED_CHALLENGE_RETENTION_MS,
  EMPTY_DRAFT_TTL_MS,
  EXPIRED_SESSION_RETENTION_MS,
  runCloudMaintenance,
} from "./d1-maintenance";

const NOW = 1_790_000_000_000;
const CONFIG = JSON.stringify({
  title: "春天",
  grade: "六年级",
  writingRequirements: "叙事",
  targetCharacters: 600,
  structureRequirements: "完整",
  scoringFocus: "细节",
  templateType: "custom",
});

describe("runCloudMaintenance", () => {
  it("cleans up 24h+ empty drafts, expired login challenges, and expired/revoked sessions while keeping active records", async () => {
    const sqlite = migratedDatabase();
    try {
      const db = d1Shim(sqlite);
      sqlite.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, disabled_at, created_at, updated_at) VALUES (?, ?, 'hash', 'teacher', 0, NULL, 1, 1)")
        .run("teacher-1", "teacher-1");

      const insertReview = sqlite.prepare(`
        INSERT INTO reviews (id, owner_id, status, student_name, class_name, config, report, revision, image_revision, ocr_checkpoint, created_at, updated_at)
        VALUES (?, 'teacher-1', ?, '学生', '', ?, ?, 1, 0, ?, ?, ?)
      `);
      // 1) Old empty draft -> should be deleted
      insertReview.run("draft-old-empty", "draft", CONFIG, null, null, NOW - EMPTY_DRAFT_TTL_MS - 1_000, NOW - EMPTY_DRAFT_TTL_MS - 1_000);
      // 2) Recent empty draft (< 24h) -> must stay
      insertReview.run("draft-fresh-empty", "draft", CONFIG, null, null, NOW - EMPTY_DRAFT_TTL_MS + 60_000, NOW - EMPTY_DRAFT_TTL_MS + 60_000);
      // 3) Old draft WITH an image -> must stay
      insertReview.run("draft-old-with-image", "draft", CONFIG, null, null, NOW - EMPTY_DRAFT_TTL_MS - 1_000, NOW - EMPTY_DRAFT_TTL_MS - 1_000);
      sqlite.prepare(`
        INSERT INTO review_images (review_id, page_index, path, position, original_name, mime_type, original_path, annotation_path, ai_path, width, height, rotation, created_at)
        VALUES ('draft-old-with-image', 0, 'images/a.jpg', 0, 'a.jpg', 'image/jpeg', 'images/a.jpg', 'images/a.jpg', 'images/a.jpg', 100, 100, 0, ?)
      `).run(NOW - EMPTY_DRAFT_TTL_MS - 1_000);
      // 4) Old draft WITH a saved report -> must stay
      insertReview.run("draft-old-with-report", "draft", CONFIG, '{"version":2}', null, NOW - EMPTY_DRAFT_TTL_MS - 1_000, NOW - EMPTY_DRAFT_TTL_MS - 1_000);
      // 5) Old non-draft review -> must stay
      insertReview.run("ready-old", "ready_for_review", CONFIG, null, null, NOW - EMPTY_DRAFT_TTL_MS - 1_000, NOW - EMPTY_DRAFT_TTL_MS - 1_000);

      // Login challenges
      const insertChallenge = sqlite.prepare(`
        INSERT INTO login_challenges (id, normalized_username, salt, nonce, ip_hash, expires_at, consumed_at, created_at)
        VALUES (?, 'teacher-1', 'salt', 'nonce', 'iphash', ?, ?, ?)
      `);
      insertChallenge.run("ch-expired", NOW - 1, null, NOW - 10_000);
      insertChallenge.run("ch-old-consumed", NOW + 60_000, NOW - CONSUMED_CHALLENGE_RETENTION_MS - 1, NOW - CONSUMED_CHALLENGE_RETENTION_MS - 10_000);
      insertChallenge.run("ch-active", NOW + 60_000, null, NOW - 1_000);

      // Sessions
      const insertSession = sqlite.prepare(`
        INSERT INTO sessions (id, user_id, token_hash, last_seen_at, expires_at, created_at, revoked_at)
        VALUES (?, 'teacher-1', ?, ?, ?, ?, ?)
      `);
      insertSession.run("sess-expired", "tok-1", NOW - EXPIRED_SESSION_RETENTION_MS - 5_000, NOW - EXPIRED_SESSION_RETENTION_MS - 1, NOW - EXPIRED_SESSION_RETENTION_MS - 10_000, null);
      insertSession.run("sess-old-revoked", "tok-2", NOW - EXPIRED_SESSION_RETENTION_MS - 5_000, NOW + 60_000, NOW - EXPIRED_SESSION_RETENTION_MS - 10_000, NOW - EXPIRED_SESSION_RETENTION_MS - 1);
      insertSession.run("sess-active", "tok-3", NOW, NOW + 60_000, NOW - 1_000, null);
      insertSession.run("sess-recent-revoked", "tok-4", NOW, NOW + 60_000, NOW - 1_000, NOW - 1_000);

      const result = await runCloudMaintenance(db, NOW);
      expect(result).toEqual({
        emptyDraftsDeleted: 1,
        loginChallengesDeleted: 2,
        sessionsDeleted: 2,
      });

      const remainingReviews = sqlite.prepare("SELECT id FROM reviews ORDER BY id").all() as Array<{ id: string }>;
      expect(remainingReviews.map((row) => row.id)).toEqual([
        "draft-fresh-empty",
        "draft-old-with-image",
        "draft-old-with-report",
        "ready-old",
      ]);

      const remainingChallenges = sqlite.prepare("SELECT id FROM login_challenges ORDER BY id").all() as Array<{ id: string }>;
      expect(remainingChallenges.map((row) => row.id)).toEqual(["ch-active"]);

      const remainingSessions = sqlite.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{ id: string }>;
      expect(remainingSessions.map((row) => row.id)).toEqual(["sess-active", "sess-recent-revoked"]);
    } finally {
      sqlite.close();
    }
  });
});
