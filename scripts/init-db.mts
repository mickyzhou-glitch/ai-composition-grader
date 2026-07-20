import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { initializeSchema } from "../src/db/init.ts";

const databasePath = path.resolve(
  process.env.APP_DATABASE_PATH ?? ".data/app.db",
);
mkdirSync(path.dirname(databasePath), { recursive: true });

const database = new Database(databasePath);
try {
  initializeSchema(database);
} finally {
  database.close();
}

console.log(`Initialized SQLite database at ${databasePath}`);

