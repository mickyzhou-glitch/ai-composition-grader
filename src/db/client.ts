import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { initializeSchema } from "./init.ts";
import * as schema from "./schema.ts";

export const DEFAULT_DATABASE_PATH = path.resolve(process.cwd(), ".data/app.db");
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

interface OpenAppDatabaseOptions {
  initialize?: typeof initializeSchema;
}

function isDefaultDatabase(filename: string): boolean {
  return path.resolve(filename) === DEFAULT_DATABASE_PATH;
}

function chmodIfPresent(filename: string, mode: number): void {
  try {
    chmodSync(filename, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function prepareDatabaseDirectory(filename: string): void {
  const directory = path.dirname(path.resolve(filename));
  if (isDefaultDatabase(filename)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    return;
  }
  mkdirSync(directory, { recursive: true });
}

function secureDatabaseFiles(filename: string): void {
  chmodIfPresent(filename, 0o600);
  if (isDefaultDatabase(filename)) {
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      chmodIfPresent(`${filename}${suffix}`, 0o600);
    }
  }
}

export function openAppDatabase(
  filename = DEFAULT_DATABASE_PATH,
  options: OpenAppDatabaseOptions = {},
) {
  if (filename !== ":memory:") {
    prepareDatabaseDirectory(filename);
  }

  const sqlite = new Database(filename);
  try {
    if (filename !== ":memory:") secureDatabaseFiles(filename);
    (options.initialize ?? initializeSchema)(sqlite);
    if (filename !== ":memory:") secureDatabaseFiles(filename);
  } catch (error) {
    try {
      if (filename !== ":memory:") secureDatabaseFiles(filename);
    } finally {
      sqlite.close();
    }
    throw error;
  }

  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
    close: () => {
      try {
        if (filename !== ":memory:") secureDatabaseFiles(filename);
      } finally {
        sqlite.close();
      }
    },
  };
}

export type AppDatabase = ReturnType<typeof openAppDatabase>["db"];
