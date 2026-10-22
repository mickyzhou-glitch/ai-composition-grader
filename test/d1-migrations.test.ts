import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATIONS = path.resolve(__dirname, "../migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
}

/** D1 runs with foreign keys on and ignores PRAGMA foreign_keys = OFF; simulate that. */
function openLikeD1() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const exec = db.exec.bind(db);
  return {
    db,
    apply(name: string) {
      const sql = readFileSync(path.join(MIGRATIONS, name), "utf8")
        .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*(OFF|ON)\s*;/gimu, "");
      exec("BEGIN");
      exec(sql);
      exec("COMMIT");
    },
  };
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("D1 迁移不丢数据", () => {
  it("0009 重建 reviews 时保留图片、批注和分析任务（外键开着也不级联删除）", () => {
    const { db, apply } = openLikeD1();
    const files = migrationFiles();
    const before = files.filter((name) => name < "0009");
    const after = files.filter((name) => name >= "0009");
    before.forEach(apply);

    db.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES ('u1', 'teacher', 'x', 'teacher', 0, 1, 1)").run();
    db.prepare("INSERT INTO reviews (id, owner_id, status, config, created_at, updated_at, teacher_reviewed_at) VALUES ('r1', 'u1', 'exported', '{}', 1, 1, 2)").run();
    db.prepare(`INSERT INTO review_images (review_id, page_index, path, position, original_name, mime_type, original_path, annotation_path, ai_path, width, height, rotation, created_at)
      VALUES ('r1', 0, 'images/a.jpg', 0, 'a.jpg', 'image/jpeg', 'images/a-original.jpg', 'images/a.jpg', 'images/a-ai.jpg', 10, 10, 0, 1)`).run();
    db.prepare("INSERT INTO annotations (review_id, position, page_index, x, y, category, anchor_text, comment, is_highlight) VALUES ('r1', 0, 0, 0.1, 0.1, 'typo', '字', '错字', 0)").run();
    db.prepare("INSERT INTO analysis_jobs (id, review_id, owner_id, status, available_at, progress_stage, teacher_guidance, created_at) VALUES ('j1', 'r1', 'u1', 'succeeded', 1, 'saving_result', '[不合适原因]\n结构乱\n[修改要求]\n分五段', 1)").run();

    after.forEach(apply);

    expect(count(db, "reviews")).toBe(1);
    expect(count(db, "review_images")).toBe(1);
    expect(count(db, "annotations")).toBe(1);
    expect(count(db, "analysis_jobs")).toBe(1);
    expect(db.prepare("SELECT teacher_guidance FROM analysis_jobs WHERE id = 'j1'").pluck().get()).toContain("分五段");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'keep_0009_%'").all()).toEqual([]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.prepare("UPDATE reviews SET status = 'rejected' WHERE id = 'r1'").run();
  });

  it("重建被引用的表时必须先保存子表", () => {
    const referenced = new Map<string, string[]>();
    const sources = migrationFiles().map((name) => [name, readFileSync(path.join(MIGRATIONS, name), "utf8")] as const);
    for (const [, sql] of sources) {
      for (const match of sql.matchAll(/CREATE TABLE\s+"?(\w+)"?\s*\(([\s\S]*?)\n\);/gu)) {
        for (const ref of match[2]!.matchAll(/REFERENCES\s+(\w+)\s*\([^)]*\)\s+ON DELETE CASCADE/gu)) {
          referenced.set(ref[1]!, [...(referenced.get(ref[1]!) ?? []), match[1]!]);
        }
      }
    }
    for (const [, sql] of sources) {
      for (const rename of sql.matchAll(/ALTER TABLE\s+"?(\w+)"?\s+RENAME TO\s+"?(\w+)"?/gu)) {
        for (const [parent, children] of referenced) {
          referenced.set(parent, children.map((child) => (child === rename[1] ? rename[2]! : child)));
        }
      }
    }
    for (const [name, sql] of sources) {
      for (const drop of sql.matchAll(/DROP TABLE\s+(?:IF EXISTS\s+)?"?(\w+)"?/gu)) {
        const children = [...new Set(referenced.get(drop[1]!) ?? [])].filter((child) => child !== drop[1]);
        for (const child of children) {
          expect(sql, `${name} 删除 ${drop[1]} 前没有保存 ${child}`).toMatch(new RegExp(`INSERT OR IGNORE INTO ${child}\\b`, "u"));
        }
      }
    }
  });
});
