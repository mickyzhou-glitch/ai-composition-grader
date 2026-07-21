import { openAppDatabase } from "../src/db/client";
import { pathToFileURL } from "node:url";
import { ReviewRepository } from "../src/db/review-repository";
import { RetentionService } from "../src/retention/retention-service";
import { ReviewFileStore } from "../src/storage/review-file-store";

function usage(): never {
  console.error("用法：npm run retention -- <run|inspect>");
  process.exitCode = 2;
  throw new Error("invalid retention command");
}

export async function runRetentionCommand(command: string): Promise<void> {
  if (command !== "run" && command !== "inspect") usage();
  const databasePath = process.env.APP_DATABASE_PATH;
  const opened = openAppDatabase(databasePath || undefined);
  try {
    const repository = new ReviewRepository(opened.db);
    const service = new RetentionService(repository, new ReviewFileStore());
    if (command === "inspect") {
      for (const item of service.inspect()) {
        console.log(JSON.stringify({
          id: item.id,
          ownerId: item.ownerId,
          expiresAt: item.expiresAt?.toISOString() ?? null,
          deletingAt: item.deletingAt?.toISOString() ?? null,
        }));
      }
      return;
    }
    const result = await service.run();
    console.log(JSON.stringify({
      inspected: result.inspected,
      claimed: result.claimed,
      deleted: result.deleted,
      failed: result.failed,
      errors: result.errors.map(({ id, ownerId, code }) => ({ id, ownerId, code })),
    }));
  } finally {
    opened.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const command = process.argv[2];
  if (!command) usage();
  await runRetentionCommand(command).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Retention command failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
