import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

const MIGRATIONS = path.resolve(__dirname, "../migrations");

/** 按 D1 的方式（外键开启、忽略 PRAGMA foreign_keys）依次执行全部迁移。 */
export function migratedDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATIONS).filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(path.join(MIGRATIONS, name), "utf8").replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*(OFF|ON)\s*;/gimu, ""));
  }
  db.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES ('u1', 'teacher', 'x', 'teacher', 0, 1, 1)").run();
  return db;
}

/** 用 better-sqlite3 模拟 D1Database 的 prepare/bind/all/first/run/batch。 */
export function d1Shim(db: Database.Database): D1Database {
  const statement = (sql: string, params: unknown[] = []) => {
    const stmt = db.prepare(sql);
    const returns = stmt.reader;
    return {
      bind: (...values: unknown[]) => statement(sql, values),
      all: async () => ({ results: returns ? stmt.all(...params) : [] }),
      first: async () => (returns ? stmt.get(...params) ?? null : null),
      run: async () => {
        if (returns) { const rows = stmt.all(...params); return { results: rows, meta: { changes: rows.length } }; }
        const info = stmt.run(...params);
        return { meta: { changes: info.changes } };
      },
    };
  };
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: Array<{ run(): Promise<unknown> }>) => {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}
