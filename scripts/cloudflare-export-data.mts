import Database from "better-sqlite3";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const tables = ["users", "settings", "sessions", "login_attempts", "security_events", "reviews", "saved_assignments", "review_images", "annotations", "analysis_jobs"] as const;
const databasePath = path.resolve(process.env.APP_DATABASE_PATH ?? ".data/app.db");
const outputPath = path.resolve(process.env.CLOUDFLARE_DATA_SQL ?? ".migration/cloudflare-data.sql");

function literal(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `X'${value.toString("hex")}'`;
  return `'${String(value).replace(/'/gu, "''")}'`;
}

const database = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  const statements: string[] = [];
  for (const table of tables) {
    const columns = (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name);
    const rows = database.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      statements.push(`INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((column) => literal(row[column])).join(", ")});`);
    }
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${statements.join("\n")}\n`, { mode: 0o600 });
  process.stdout.write(JSON.stringify({ outputPath, statements: statements.length }, null, 2) + "\n");
} finally {
  database.close();
}
