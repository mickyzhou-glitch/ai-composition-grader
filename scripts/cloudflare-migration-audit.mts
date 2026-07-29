import Database from "better-sqlite3";
import { access } from "node:fs/promises";
import path from "node:path";

import { summarizeMigrationAudit } from "../src/cloudflare/migration-audit.ts";

const databasePath = path.resolve(process.env.APP_DATABASE_PATH ?? ".data/app.db");
const storageRoot = path.resolve(process.env.APP_STORAGE_ROOT ?? ".data/users");
const database = new Database(databasePath, { readonly: true, fileMustExist: true });

try {
  const tableNames = ["users", "sessions", "saved_assignments", "reviews", "review_images", "annotations", "analysis_jobs"];
  const counts = tableNames.map((table) => [table, Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)] as const);
  const images = database.prepare(`
    SELECT reviews.owner_id AS ownerId, review_images.review_id AS reviewId,
           review_images.original_path AS originalPath, review_images.annotation_path AS annotationPath, review_images.ai_path AS aiPath
    FROM review_images INNER JOIN reviews ON reviews.id = review_images.review_id
  `).all() as Array<{ ownerId: string; reviewId: string; originalPath: string; annotationPath: string; aiPath: string }>;
  const fileStates = await Promise.all(images.flatMap((image) => [image.originalPath, image.annotationPath, image.aiPath].map(async (storedPath) => {
    const reviewRoot = path.resolve(storageRoot, image.ownerId, "reviews", image.reviewId);
    const candidate = path.resolve(reviewRoot, storedPath);
    if (!candidate.startsWith(`${reviewRoot}${path.sep}`)) return false;
    try { await access(candidate); return true; } catch { return false; }
  })));
  process.stdout.write(`${JSON.stringify(summarizeMigrationAudit(counts, fileStates), null, 2)}\n`);
} finally {
  database.close();
}
