import { pathToFileURL } from "node:url";

import { CompositionReviewAdapter } from "../src/ai/composition-review-adapter.ts";
import { VisionOcrAdapter } from "../src/ai/vision-ocr-adapter.ts";
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
    { analyze: async () => { throw new Error("LEGACY_IMAGE_ANALYSIS_DISABLED"); } },
  );
  const vision = new VisionOcrAdapter(settings);
  const content = new CompositionReviewAdapter(settings);
  const worker = new AnalysisWorker(jobs, {
    prepare: (ownerId, reviewId, mode) => reviews.prepareAnalysis(ownerId, reviewId, mode),
    analyze: (input) => reviews.analyzePrepared(input),
    recognize: (imageDataUrls) => vision.recognize({ imageUrls: imageDataUrls }),
    saveOcr: (ownerId, reviewId, token, imageRevision, pages) =>
      reviews.savePreparedOcr(ownerId, reviewId, token, imageRevision, pages),
    analyzeText: (input) => content.analyzeText(input),
    save: (ownerId, reviewId, token, envelope, claim, expectedOcrRevision) =>
      reviews.savePreparedAnalysisAndCompleteJob(
        ownerId,
        reviewId,
        token,
        envelope,
        claim,
        expectedOcrRevision,
      ),
    fail: (ownerId, reviewId, token, claim, errorCode) =>
      reviews.failPreparedAnalysisAndFailJob(ownerId, reviewId, token, claim, errorCode),
  });
  const stop = () => worker.stop();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    while (!worker.isStopping()) {
      const startedAt = Date.now();
      let result;
      try {
        result = await worker.runOnce();
      } catch {
        // A malformed single job must not kill an otherwise healthy queue.
        // Startup is outside this loop and remains a hard failure.
        writeSafeLog({ event: "analysis_job", jobId: "unknown", outcome: "worker_step_failed", errorCode: "WORKER_STEP_FAILED", durationMs: Date.now() - startedAt });
        if (!worker.isStopping()) await sleep(POLL_INTERVAL_MS);
        continue;
      }
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
