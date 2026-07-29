// @vitest-environment node

import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openAppDatabase } from "./client";
import { initializeSchema } from "./init";

const temporaryDirectories: string[] = [];
const itOnPosix = process.platform === "win32" ? it.skip : it;

function createTemporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "ai-composition-grader-db-"));
  temporaryDirectories.push(directory);
  return directory;
}

function tableColumns(sqlite: Database.Database, table: string) {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: 0 | 1;
  }>;
}

function createLegacyDatabase() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE reviews (
      id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'failed')),
      config TEXT NOT NULL,
      report TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE review_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      page_index INTEGER NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO reviews VALUES ('legacy', 'draft', '{"title":"legacy"}', NULL, 1, 2);
    INSERT INTO review_images(review_id, page_index, path, created_at)
    VALUES ('legacy', 2, 'images/legacy.jpg', 1);
  `);
  return sqlite;
}

function createCurrentVersionDatabase() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE TABLE reviews (
      id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN (
          'draft',
          'analyzing',
          'needs_better_images',
          'ready_for_review',
          'exported',
          'failed'
        )
      ),
      config TEXT NOT NULL,
      report TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      analysis_run_id TEXT,
      pdf_filename TEXT,
      pdf_path TEXT,
      pdf_revision INTEGER,
      exported_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE review_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      page_index INTEGER NOT NULL CHECK (page_index >= 0),
      path TEXT NOT NULL,
      position INTEGER NOT NULL CHECK (position >= 0),
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      original_path TEXT NOT NULL,
      annotation_path TEXT NOT NULL,
      ai_path TEXT NOT NULL,
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      rotation INTEGER NOT NULL CHECK (rotation IN (0, 90, 180, 270)),
      crop TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX review_images_review_id_idx ON review_images(review_id);
    CREATE TABLE annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      page_index INTEGER NOT NULL CHECK (page_index >= 0),
      x REAL NOT NULL CHECK (x >= 0 AND x <= 1),
      y REAL NOT NULL CHECK (y >= 0 AND y <= 1),
      category TEXT NOT NULL CHECK (
        category IN ('typo', 'punctuation', 'sentence', 'expression', 'structure', 'highlight')
      ),
      anchor_text TEXT NOT NULL,
      comment TEXT NOT NULL,
      is_highlight INTEGER NOT NULL CHECK (is_highlight IN (0, 1)),
      UNIQUE(review_id, position)
    );
    CREATE INDEX annotations_review_id_idx ON annotations(review_id);

    INSERT INTO settings(id, base_url, model, updated_at)
      VALUES (1, 'https://example.invalid/v1', 'legacy-model', 9);
    INSERT INTO reviews (
      id, status, config, report, revision, analysis_run_id,
      pdf_filename, pdf_path, pdf_revision, exported_at, created_at, updated_at
    ) VALUES (
      'current-review', 'ready_for_review', '{"title":"当前作文"}',
      '{"summary":"保留批改结果"}', 7, 'run-current',
      'current.pdf', 'pdf/current.pdf', 7, 8, 1, 8
    );
    INSERT INTO review_images (
      review_id, page_index, path, position, original_name, mime_type,
      original_path, annotation_path, ai_path, width, height, rotation, crop, created_at
    ) VALUES (
      'current-review', 0, 'images/annotation.jpg', 0, '第一页.jpg', 'image/jpeg',
      'images/original.jpg', 'images/annotation.jpg', 'images/ai.jpg',
      1200, 1600, 90, '{"x":0.1,"y":0.2,"width":0.8,"height":0.7}', 2
    );
    INSERT INTO annotations (
      review_id, position, page_index, x, y, category,
      anchor_text, comment, is_highlight
    ) VALUES (
      'current-review', 0, 0, 0.25, 0.5, 'sentence',
      '原文锚点', '保留批注', 0
    );
  `);
  return sqlite;
}

function schemaSnapshot(sqlite: Database.Database) {
  return sqlite
    .prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `)
    .all();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("openAppDatabase", () => {
  it("schema 初始化失败时关闭已打开的 SQLite 连接", () => {
    const close = vi.spyOn(Database.prototype, "close");

    expect(() =>
      openAppDatabase(":memory:", {
        initialize: () => {
          throw new Error("init failed");
        },
      }),
    ).toThrow("init failed");
    expect(close).toHaveBeenCalledOnce();

    close.mockRestore();
  });

  it("空数据库创建账号、会话、安全审计和分析任务表", () => {
    const sqlite = new Database(":memory:");

    try {
      initializeSchema(sqlite);

      const tables = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(tables).toEqual(
        expect.arrayContaining([
          "users",
          "sessions",
          "login_attempts",
          "security_events",
          "analysis_jobs",
        ]),
      );

      const requiredColumns: Record<string, string[]> = {
        users: [
          "id",
          "username",
          "password_hash",
          "role",
          "must_change_password",
          "disabled_at",
          "created_at",
          "updated_at",
        ],
        sessions: [
          "id",
          "user_id",
          "token_hash",
          "last_seen_at",
          "expires_at",
          "created_at",
          "revoked_at",
        ],
        login_attempts: [
          "id",
          "normalized_username",
          "ip_hash",
          "succeeded",
          "attempted_at",
        ],
        security_events: ["id", "user_id", "event_type", "metadata", "created_at"],
        analysis_jobs: [
          "id",
          "review_id",
          "owner_id",
          "status",
          "attempt",
          "available_at",
          "lease_expires_at",
          "progress_stage",
          "error_code",
          "message",
          "teacher_guidance",
          "created_at",
          "started_at",
          "finished_at",
        ],
      };
      for (const [table, columns] of Object.entries(requiredColumns)) {
        expect(tableColumns(sqlite, table).map(({ name }) => name)).toEqual(columns);
      }
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("安全事件迁移为用户按时间查询创建复合索引并清理旧单列索引", () => {
    const sqlite = new Database(":memory:");

    try {
      initializeSchema(sqlite);
      sqlite.exec(`
        DROP INDEX IF EXISTS security_events_user_created_at_idx;
        CREATE INDEX IF NOT EXISTS security_events_user_id_idx
          ON security_events(user_id);
        CREATE INDEX IF NOT EXISTS security_events_created_at_idx
          ON security_events(created_at);
      `);

      initializeSchema(sqlite);

      const indexes = sqlite
        .prepare("PRAGMA index_list(security_events)")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(indexes).not.toContain("security_events_user_id_idx");
      expect(indexes).not.toContain("security_events_created_at_idx");
      expect(
        sqlite
          .prepare("PRAGMA index_info(security_events_user_created_at_idx)")
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual(["user_id", "created_at"]);
      const queryPlan = sqlite
        .prepare(`
          EXPLAIN QUERY PLAN
          SELECT * FROM security_events
          WHERE user_id = ?
          ORDER BY created_at
        `)
        .all("local-admin") as Array<{ detail: string }>;
      const queryPlanDetails = queryPlan.map(({ detail }) => detail).join("\n");
      expect(queryPlanDetails).toMatch(
        /USING INDEX security_events_user_created_at_idx/,
      );
      expect(queryPlanDetails).not.toMatch(/TEMP B-TREE/);
    } finally {
      sqlite.close();
    }
  });

  it("sessions 的 token_hash 只有一个唯一索引", () => {
    const sqlite = new Database(":memory:");

    try {
      initializeSchema(sqlite);

      const tokenHashUniqueIndexes = (
        sqlite.prepare("PRAGMA index_list(sessions)").all() as Array<{
          name: string;
          unique: 0 | 1;
        }>
      ).filter(({ name, unique }) => {
        if (unique !== 1) return false;
        const columns = sqlite
          .prepare(`PRAGMA index_info(${name})`)
          .all()
          .map((row) => (row as { name: string }).name);
        return columns.length === 1 && columns[0] === "token_hash";
      });

      expect(tokenHashUniqueIndexes.map(({ name }) => name)).toEqual([
        "sessions_token_hash_unique_idx",
      ]);
    } finally {
      sqlite.close();
    }
  });

  it("reviews 具有强制 owner 和过期删除字段", () => {
    const sqlite = new Database(":memory:");

    try {
      initializeSchema(sqlite);

      const columns = tableColumns(sqlite, "reviews");
      expect(columns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "owner_id", notnull: 1 }),
          expect.objectContaining({ name: "expires_at", notnull: 0 }),
          expect.objectContaining({ name: "deleting_at", notnull: 0 }),
        ]),
      );
      expect(
        sqlite.prepare("PRAGMA foreign_key_list(reviews)").all(),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: "owner_id", table: "users", to: "id" }),
        ]),
      );
    } finally {
      sqlite.close();
    }
  });

  it("迁移旧数据时创建不可登录管理员并接管全部作文", () => {
    const sqlite = createLegacyDatabase();
    sqlite.exec(
      "INSERT INTO reviews VALUES ('legacy-2', 'failed', '{}', NULL, 3, 4)",
    );

    try {
      initializeSchema(sqlite);

      expect(
        sqlite.prepare("SELECT * FROM users WHERE username = 'local-admin'").get(),
      ).toMatchObject({
        id: "local-admin",
        password_hash: "!bootstrap-required",
        role: "admin",
        must_change_password: 1,
      });
      expect(
        sqlite.prepare("SELECT id, owner_id FROM reviews ORDER BY id").all(),
      ).toEqual([
        { id: "legacy", owner_id: "local-admin" },
        { id: "legacy-2", owner_id: "local-admin" },
      ]);
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it("迁移当前完整数据库时保留作文、图片、批注、约束和级联删除", () => {
    const sqlite = createCurrentVersionDatabase();
    const expectedReview = sqlite.prepare("SELECT * FROM reviews").get();
    const expectedImage = sqlite.prepare("SELECT * FROM review_images").get();
    const expectedAnnotation = sqlite.prepare("SELECT * FROM annotations").get();

    try {
      initializeSchema(sqlite);

      expect(
        sqlite
          .prepare(`
            SELECT id, status, config, report, revision, analysis_run_id,
              pdf_filename, pdf_path, pdf_revision, exported_at, created_at, updated_at
            FROM reviews
          `)
          .get(),
      ).toEqual(expectedReview);
      expect(sqlite.prepare("SELECT * FROM review_images").get()).toEqual(expectedImage);
      expect(sqlite.prepare("SELECT * FROM annotations").get()).toEqual(expectedAnnotation);
      expect(
        sqlite.prepare("SELECT owner_id FROM reviews WHERE id = 'current-review'").get(),
      ).toEqual({ owner_id: "local-admin" });
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        sqlite
          .prepare("PRAGMA index_info(review_images_review_id_idx)")
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual(["review_id"]);
      expect(
        sqlite
          .prepare("PRAGMA index_info(annotations_review_id_idx)")
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual(["review_id"]);

      expect(() =>
        sqlite.exec(`
          INSERT INTO annotations (
            review_id, position, page_index, x, y, category,
            anchor_text, comment, is_highlight
          ) VALUES (
            'current-review', 0, 0, 0.5, 0.5, 'typo', 'duplicate', 'duplicate', 0
          );
        `),
      ).toThrow(/UNIQUE/);
      expect(() =>
        sqlite.prepare("UPDATE reviews SET status = 'invalid' WHERE id = ?").run(
          "current-review",
        ),
      ).toThrow(/CHECK/);
      expect(() =>
        sqlite.prepare("UPDATE review_images SET width = 0 WHERE review_id = ?").run(
          "current-review",
        ),
      ).toThrow(/CHECK/);

      sqlite.prepare("DELETE FROM reviews WHERE id = ?").run("current-review");
      expect(sqlite.prepare("SELECT count(*) AS count FROM review_images").get()).toEqual({
        count: 0,
      });
      expect(sqlite.prepare("SELECT count(*) AS count FROM annotations").get()).toEqual({
        count: 0,
      });
    } finally {
      sqlite.close();
    }
  });

  it("重复迁移不重复账号、不破坏旧数据且不覆盖已设置的密码哈希", () => {
    const sqlite = createLegacyDatabase();

    try {
      initializeSchema(sqlite);
      sqlite
        .prepare("UPDATE users SET password_hash = ? WHERE id = 'local-admin'")
        .run("$argon2id$already-configured");

      initializeSchema(sqlite);

      expect(
        sqlite.prepare("SELECT count(*) AS count FROM users WHERE username = 'local-admin'").get(),
      ).toEqual({ count: 1 });
      expect(
        sqlite.prepare("SELECT password_hash FROM users WHERE id = 'local-admin'").get(),
      ).toEqual({ password_hash: "$argon2id$already-configured" });
      expect(sqlite.prepare("SELECT config, report FROM reviews WHERE id = 'legacy'").get()).toEqual({
        config: '{"title":"legacy"}',
        report: null,
      });
      expect(sqlite.prepare("SELECT path FROM review_images WHERE review_id = 'legacy'").get()).toEqual({
        path: "images/legacy.jpg",
      });
    } finally {
      sqlite.close();
    }
  });

  it("同一作文最多有一个活动分析任务，结束后可以创建下一个", () => {
    const sqlite = new Database(":memory:");

    try {
      initializeSchema(sqlite);
      sqlite.exec(`
        INSERT INTO reviews (id, owner_id, status, config, created_at, updated_at)
        VALUES ('review-1', 'local-admin', 'draft', '{}', 1, 1);
        INSERT INTO analysis_jobs (
          id, review_id, owner_id, status, available_at, progress_stage, created_at
        ) VALUES (
          'job-1', 'review-1', 'local-admin', 'queued', 1, 'queued', 1
        );
      `);

      expect(() =>
        sqlite.exec(`
          INSERT INTO analysis_jobs (
            id, review_id, owner_id, status, available_at, progress_stage, created_at
          ) VALUES (
            'job-2', 'review-1', 'local-admin', 'running', 2, 'reading_images', 2
          );
        `),
      ).toThrow(/UNIQUE/);

      sqlite.exec(`
        UPDATE analysis_jobs
        SET status = 'succeeded', progress_stage = 'saving_result', finished_at = 3
        WHERE id = 'job-1';
        INSERT INTO analysis_jobs (
          id, review_id, owner_id, status, available_at, progress_stage, created_at
        ) VALUES (
          'job-2', 'review-1', 'local-admin', 'running', 3, 'reading_images', 3
        );
      `);
      expect(sqlite.prepare("SELECT id FROM analysis_jobs ORDER BY id").all()).toEqual([
        { id: "job-1" },
        { id: "job-2" },
      ]);
      expect(
        sqlite
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get("analysis_jobs_one_active_per_review_idx"),
      ).toMatchObject({ sql: expect.stringMatching(/WHERE\s+status\s+IN\s*\(\s*'queued'\s*,\s*'running'/i) });
      expect(
        sqlite
          .prepare("PRAGMA index_info(analysis_jobs_review_id_idx)")
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual(["review_id"]);
    } finally {
      sqlite.close();
    }
  });

  it("迁移中途失败时回滚已创建的表、新列和数据更新", () => {
    const sqlite = createCurrentVersionDatabase();
    sqlite
      .prepare("UPDATE review_images SET original_path = '' WHERE review_id = ?")
      .run("current-review");
    sqlite.exec(`
      CREATE TRIGGER reject_current_image_update
      BEFORE UPDATE ON review_images
      BEGIN
        SELECT RAISE(ABORT, 'forced migration failure');
      END;
    `);
    const originalSchema = schemaSnapshot(sqlite);
    const originalReviews = sqlite.prepare("SELECT * FROM reviews").all();
    const originalImages = sqlite.prepare("SELECT * FROM review_images").all();
    const originalAnnotations = sqlite.prepare("SELECT * FROM annotations").all();
    const originalImageForeignKeys = sqlite.prepare("PRAGMA foreign_key_list(review_images)").all();
    const originalAnnotationForeignKeys = sqlite.prepare("PRAGMA foreign_key_list(annotations)").all();

    try {
      expect(() => initializeSchema(sqlite)).toThrow(/forced migration failure/);

      expect(schemaSnapshot(sqlite)).toEqual(originalSchema);
      expect(sqlite.prepare("SELECT * FROM reviews").all()).toEqual(originalReviews);
      expect(sqlite.prepare("SELECT * FROM review_images").all()).toEqual(originalImages);
      expect(sqlite.prepare("SELECT * FROM annotations").all()).toEqual(originalAnnotations);
      expect(sqlite.prepare("PRAGMA foreign_key_list(review_images)").all()).toEqual(
        originalImageForeignKeys,
      );
      expect(sqlite.prepare("PRAGMA foreign_key_list(annotations)").all()).toEqual(
        originalAnnotationForeignKeys,
      );
      expect(sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get(),
      ).toBeUndefined();
    } finally {
      sqlite.close();
    }
  });

  itOnPosix("默认数据库将数据目录和 SQLite 文件限制为仅当前用户可访问", async () => {
    const workspace = createTemporaryDirectory();
    const databaseDirectory = path.join(workspace, ".data");
    mkdirSync(databaseDirectory, { recursive: true, mode: 0o755 });
    chmodSync(databaseDirectory, 0o755);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(workspace);

    try {
      vi.resetModules();
      const { DEFAULT_DATABASE_PATH: defaultPath, openAppDatabase: openDefaultDatabase } = await import("./client");
      const database = openDefaultDatabase();

      expect(defaultPath).toBe(path.join(workspace, ".data/app.db"));
      expect(statSync(databaseDirectory).mode & 0o777).toBe(0o700);
      expect(statSync(defaultPath).mode & 0o777).toBe(0o600);

      for (const suffix of ["-wal", "-shm", "-journal"]) {
        writeFileSync(`${defaultPath}${suffix}`, "sqlite sidecar");
        chmodSync(`${defaultPath}${suffix}`, 0o644);
      }
      database.close();

      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        expect(statSync(`${defaultPath}${suffix}`).mode & 0o777).toBe(0o600);
      }
    } finally {
      cwd.mockRestore();
      vi.resetModules();
    }
  });

  itOnPosix("自定义数据库只收紧数据库文件，不修改调用方目录权限", () => {
    const root = createTemporaryDirectory();
    const databaseDirectory = path.join(root, "custom-database");
    const databasePath = path.join(databaseDirectory, "app.db");
    mkdirSync(databaseDirectory, { recursive: true, mode: 0o755 });
    chmodSync(databaseDirectory, 0o755);

    const database = openAppDatabase(databasePath);
    database.close();

    expect(statSync(databaseDirectory).mode & 0o777).toBe(0o755);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  });

  it("升级任务 2 创建的旧 review_images 表并保留记录", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE reviews (
        id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL,
        config TEXT NOT NULL,
        report TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE review_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        page_index INTEGER NOT NULL,
        path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO reviews VALUES ('legacy', 'draft', '{}', NULL, 1, 1);
      INSERT INTO review_images(review_id, page_index, path, created_at)
      VALUES ('legacy', 2, 'images/legacy.jpg', 1);
    `);

    initializeSchema(sqlite);
    const row = sqlite.prepare("select * from review_images").get() as Record<string, unknown>;

    expect(row).toMatchObject({
      position: 2,
      original_path: "images/legacy.jpg",
      annotation_path: "images/legacy.jpg",
      ai_path: "images/legacy.jpg",
      rotation: 0,
    });
    const review = sqlite.prepare("select * from reviews where id = 'legacy'").get();
    expect(review).toMatchObject({ revision: 0, analysis_run_id: null });
    sqlite.close();
  });
});
