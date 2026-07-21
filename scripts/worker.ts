import { pathToFileURL } from "node:url";

import { OpenAIReviewAdapter } from "../src/ai/openai-review-adapter.ts";
import { openAppDatabase } from "../src/db/client.ts";
import { ReviewRepository } from "../src/db/review-repository.ts";
import { AnalysisJobRepository } from "../src/jobs/analysis-job-repository.ts";
import { AnalysisWorker } from "../src/jobs/analysis-worker.ts";
import { SettingsRepository } from "../src/settings/settings-repository.ts";
import { SettingsService } from "../src/settings/settings-service.ts";
import { MacOSKeychain } from "../src/settings/keychain.ts";
import { ReviewService } from "../src/services/review-service.ts";
import { ReviewFileStore } from "../src/storage/review-file-store.ts";

const POLL_INTERVAL_MS = 1_000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function writeSafeLog(event: Record<string, string | number | null>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

export async function runWorker(): Promise<void> {
  const opened = openAppDatabase(process.env.APP_DATABASE_PATH || undefined);
  const jobs = new AnalysisJobRepository(opened.db);
  const settings = new SettingsService(new SettingsRepository(opened.db), new MacOSKeychain());
  const reviews = new ReviewService(
    new ReviewRepository(opened.db),
    new ReviewFileStore(),
    new OpenAIReviewAdapter(settings),
  );
  const worker = new AnalysisWorker(jobs, {
    prepare: (ownerId, reviewId) => reviews.prepareAnalysis(ownerId, reviewId),
    analyze: (input) => reviews.analyzePrepared(input),
    save: (ownerId, reviewId, token, envelope, claim) =>
      reviews.savePreparedAnalysisAndCompleteJob(ownerId, reviewId, token, envelope, claim),
    fail: (ownerId, reviewId, token) => reviews.failPreparedAnalysis(ownerId, reviewId, token),
  });
  const stop = () => worker.stop();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!worker.isStopping()) {
      const startedAt = Date.now();
      const result = await worker.runOnce();
      if (!result) {
        if (!worker.isStopping()) await sleep(POLL_INTERVAL_MS);
        continue;
      }
      writeSafeLog({
        event: "analysis_job",
        jobId: result.jobId,
        outcome: result.outcome,
        errorCode: "errorCode" in result ? result.errorCode : null,
        durationMs: Date.now() - startedAt,
      });
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    opened.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runWorker().catch(() => {
    // Startup failures intentionally do not echo database, keychain, or model details.
    process.stderr.write("分析 Worker 启动失败\n");
    process.exitCode = 1;
  });
}
