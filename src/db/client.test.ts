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
