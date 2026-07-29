import Database from "better-sqlite3";
import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const databasePath = path.resolve(process.env.APP_DATABASE_PATH ?? ".data/app.db");
const storageRoot = path.resolve(process.env.APP_STORAGE_ROOT ?? ".data/users");
const bucket = "ai-composition-grader-files";

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", "r2", "object", "put", ...args, "--remote"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`R2 upload failed with exit code ${code}: ${stderr}`)));
  });
}

const database = new Database(databasePath, { readonly: true, fileMustExist: true });
try {
  const rows = database.prepare(`
    SELECT reviews.owner_id AS ownerId, review_images.review_id AS reviewId,
           review_images.original_path AS originalPath, review_images.annotation_path AS annotationPath, review_images.ai_path AS aiPath
    FROM review_images INNER JOIN reviews ON reviews.id = review_images.review_id
  `).all() as Array<{ ownerId: string; reviewId: string; originalPath: string; annotationPath: string; aiPath: string }>;
  const objects = new Map<string, string>();
  for (const row of rows) {
    const reviewRoot = path.resolve(storageRoot, row.ownerId, "reviews", row.reviewId);
    for (const storedPath of [row.originalPath, row.annotationPath, row.aiPath]) {
      const source = path.resolve(reviewRoot, storedPath);
      if (!source.startsWith(`${reviewRoot}${path.sep}`)) throw new Error("Unsafe stored file path");
      await access(source);
      objects.set(`users/${row.ownerId}/reviews/${row.reviewId}/${storedPath}`, source);
    }
  }
  let completed = 0;
  for (const [key, source] of objects) {
    await run([`${bucket}/${key}`, `--file=${source}`]);
    completed += 1;
    if (completed % 25 === 0 || completed === objects.size) process.stdout.write(`Uploaded ${completed}/${objects.size}\n`);
  }
} finally {
  database.close();
}
