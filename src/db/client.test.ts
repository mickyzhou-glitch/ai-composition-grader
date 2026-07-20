// @vitest-environment node

import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { openAppDatabase } from "./client";
import { initializeSchema } from "./init";

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
