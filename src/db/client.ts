import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { initializeSchema } from "./init";
import * as schema from "./schema";

export const DEFAULT_DATABASE_PATH = path.resolve(process.cwd(), ".data/app.db");

interface OpenAppDatabaseOptions {
  initialize?: typeof initializeSchema;
}

export function openAppDatabase(
  filename = DEFAULT_DATABASE_PATH,
  options: OpenAppDatabaseOptions = {},
) {
  if (filename !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  }

  const sqlite = new Database(filename);
  try {
    (options.initialize ?? initializeSchema)(sqlite);
  } catch (error) {
    sqlite.close();
    throw error;
  }

  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
    close: () => sqlite.close(),
  };
}

export type AppDatabase = ReturnType<typeof openAppDatabase>["db"];
