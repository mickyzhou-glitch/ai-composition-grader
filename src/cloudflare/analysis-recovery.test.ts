// @vitest-environment node
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeSchema } from "../db/init";
import { D1AnalysisJobs, MAX_CLOUD_ANALYSIS_RUN_MS } from "./d1-analysis-jobs";
import { D1OcrCheckpointRepository } from "./d1-ocr-checkpoint";
import { CompositionReviewAdapter } from "../ai/composition-review-adapter";
import worker, { savePipelineResult } from "../../worker/index";

const NOW = 1_790_000_000_000;
const TIMEOUT = MAX_CLOUD_ANALYSIS_RUN_MS;
const config = { title: "春天", grade: "六年级", writingRequirements: "叙事", targetCharacters: 600, structureRequirements: "完整", scoringFocus: "细节", templateType: "custom" };
const recognized = {
  pages: [{ pageIndex: 0, text: "原文", readable: true, warnings: [], blocks: [] }],
  paragraphs: [{ paragraphIndex: 0, text: "原文", segments: [{ pageIndex: 0, text: "原文", x: 0, y: 0, width: 1, height: 1 }] }],
};

function fixture() {
  const sqlite = new Database(":memory:");
  initializeSchema(sqlite);
  for (const owner of ["owner-1", "owner-2"]) {
    sqlite.prepare("INSERT INTO users VALUES (?, ?, 'hash', 'teacher', 0, NULL, 1, 1)").run(owner, owner);
  }
  function prepare(sql: string) {
    const statement = sqlite.prepare(sql);
    let args: unknown[] = [];
    return {
      bind(...bindings: unknown[]) { args = bindings; return this; },
      async first() { return statement.get(...args) ?? null; },
      async all() { return { results: statement.all(...args) }; },
      execute() { return { meta: { changes: statement.run(...args).changes } }; },
      async run() { return this.execute(); },
    };
  }
  const database = {
    prepare,
    async batch(statements: Array<ReturnType<typeof prepare>>) {
      return sqlite.transaction(() => statements.map((statement) => statement.execute()))();
    },
  } as unknown as D1Database;
  function seed(id: string, options: { owner?: string; status?: string; startedAt?: number | null; createdAt?: number } = {}) {
    const owner = options.owner ?? "owner-1";
    const status = options.status ?? "running";
    const started = options.startedAt === undefined ? NOW - TIMEOUT - 1 : options.startedAt;
    const created = options.createdAt ?? NOW - TIMEOUT - 10_000;
    sqlite.prepare(`INSERT INTO reviews (id, owner_id, status, config, report, revision,
      image_revision, ocr_checkpoint, report_ocr_revision, analysis_run_id, created_at, updated_at)
      VALUES (?, ?, 'analyzing', ?, '{"saved":"teacher edits"}', 5, 1, '{"saved":"ocr"}', 2, ?, ?, ?)`)
      .run(id, owner, JSON.stringify(config), `job-${id}`, created, created);
    sqlite.prepare(`INSERT INTO analysis_jobs (id, review_id, owner_id, mode, status, attempt,
      available_at, progress_stage, created_at, started_at) VALUES (?, ?, ?, 'full', ?, 0, ?, 'generating_review', ?, ?)`)
      .run(`job-${id}`, id, owner, status, created, created, started);
    sqlite.prepare(`INSERT INTO review_images (review_id, page_index, path, position, original_name, original_path, ai_path, annotation_path,
      mime_type, width, height, rotation, created_at) VALUES (?, 0, 'original', 0, 'page.jpg', 'original', 'ai', 'annotation', 'image/jpeg', 10, 10, 0, ?)`)
      .run(id, created);
  }
  const job = (id: string) => sqlite.prepare("SELECT * FROM analysis_jobs WHERE id = ?").get(`job-${id}`) as Record<string, unknown>;
  const review = (id: string) => sqlite.prepare("SELECT * FROM reviews WHERE id = ?").get(id) as Record<string, unknown>;
  return { sqlite, database, seed, job, review };
}

describe("abandoned cloud analysis recovery", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(NOW); f = fixture(); });
  afterEach(() => { f.sqlite.close(); vi.restoreAllMocks(); });

  it("scheduled recovery ends abandoned jobs without changing saved reports or healthy/queued jobs", async () => {
    f.seed("stale");
    f.seed("healthy", { startedAt: NOW - TIMEOUT + 1 });
    f.seed("queued", { status: "queued", startedAt: null });
    f.seed("done", { status: "succeeded" });
    const before = f.review("stale");
    await worker.scheduled({} as ScheduledController, { DB: f.database } as never);
    expect(f.job("stale")).toMatchObject({ status: "failed", error_code: "ANALYSIS_TIMEOUT", finished_at: NOW });
    expect(f.review("stale")).toEqual({ ...before, status: "failed", analysis_run_id: null, updated_at: NOW });
    expect(f.job("healthy").status).toBe("running");
    expect(f.job("queued").status).toBe("queued");
    expect(f.job("done").status).toBe("succeeded");
    await worker.scheduled({} as ScheduledController, { DB: f.database } as never);
    expect(f.review("stale").revision).toBe(5);
  });

  it("polling recovers legacy jobs with no start timestamp, scoped to the owning teacher", async () => {
    f.seed("stale", { startedAt: null, createdAt: NOW - TIMEOUT });
    f.seed("other", { owner: "owner-2" });
    const jobs = new D1AnalysisJobs(f.database);
    expect(await jobs.latest("owner-2", "stale")).toBeNull();
    expect(f.job("stale").status).toBe("running");
    await expect(jobs.latest("owner-1", "stale")).resolves.toMatchObject({
      status: "failed", message: "分析在「生成批改」步骤超时或被中止，请重新分析", finishedAt: new Date(NOW).toISOString(),
    });
    expect(f.job("other").status).toBe("running");
  });

  it("a retry creates a fresh job instead of reusing the abandoned running job", async () => {
    f.seed("stale");
    const result = await new D1AnalysisJobs(f.database).enqueue("owner-1", "stale");
    expect(result.newlyQueued).toBe(true);
    expect(result.job).toMatchObject({ status: "queued" });
    expect(f.job("stale").status).toBe("failed");
    expect(f.review("stale").analysis_run_id).not.toBe("job-stale");
    expect(f.review("stale").report).toBe('{"saved":"teacher edits"}');
  });

  it("a duplicate delivery waits for a healthy running job instead of discarding its recovery message", async () => {
    f.seed("healthy", { startedAt: NOW - 60_000 });
    const ack = vi.fn();
    const retry = vi.fn();
    await worker.queue({ messages: [{ body: { jobId: "job-healthy" }, ack, retry }] } as never, { DB: f.database } as never);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(ack).not.toHaveBeenCalled();
    expect(f.job("healthy").status).toBe("running");
  });

  it("a redelivery releases an abandoned job without starting another AI request", async () => {
    f.seed("stale");
    const ack = vi.fn();
    const retry = vi.fn();
    await worker.queue({ messages: [{ body: { jobId: "job-stale" }, ack, retry }] } as never, { DB: f.database } as never);
    expect(f.job("stale")).toMatchObject({ status: "failed", error_code: "ANALYSIS_TIMEOUT" });
    expect(f.review("stale")).toMatchObject({ status: "failed", analysis_run_id: null });
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });

  it("recovery cannot release a newer job's ownership", async () => {
    f.seed("stale");
    f.sqlite.prepare("UPDATE reviews SET analysis_run_id = 'new-job' WHERE id = 'stale'").run();
    const before = f.review("stale");
    await new D1AnalysisJobs(f.database).latest("owner-1", "stale");
    expect(f.job("stale").status).toBe("failed");
    expect(f.review("stale")).toEqual(before);
  });

  it("a storage failure rolls back both the review release and the job failure", async () => {
    f.seed("stale");
    const before = f.review("stale");
    f.sqlite.exec(`CREATE TRIGGER fail_recovery BEFORE UPDATE ON analysis_jobs
      WHEN NEW.error_code = 'ANALYSIS_TIMEOUT' BEGIN SELECT RAISE(ABORT, 'storage failure'); END`);
    await expect(new D1AnalysisJobs(f.database).latest("owner-1", "stale")).rejects.toThrow("storage failure");
    expect(f.job("stale").status).toBe("running");
    expect(f.review("stale")).toEqual(before);
  });

  it("a normal content-only analysis still saves its report and successful job state together", async () => {
    f.seed("fresh", { status: "queued", startedAt: null, createdAt: NOW });
    f.sqlite.prepare("UPDATE analysis_jobs SET mode = 'content_only' WHERE id = 'job-fresh'").run();
    const diagnostic = { finding: "观察具体", action: "保留细节" };
    const report: Awaited<ReturnType<CompositionReviewAdapter["analyzeText"]>>["report"] = {
      version: 2 as const, themeFit: "fits" as const, themeReason: "切题", personalizedComment: "真实",
      painPoints: [], commonIssues: [], revisionSuggestions: [], grade: "A" as const,
      diagnostics: { authenticityAndRelevance: diagnostic, materialAndDetails: diagnostic, structure: diagnostic, language: diagnostic },
      paragraphReviews: [{ paragraphId: "paragraph-1", suggestions: [{ problem: "保留", advice: "保留细节", example: "原文" }], revisedText: "原文" }],
      parentFeedbacks: [],
    };
    vi.spyOn(CompositionReviewAdapter.prototype, "analyzeText").mockResolvedValue({ report, annotationAnchors: [] });
    await new D1OcrCheckpointRepository(f.database).saveRecognized("owner-1", "fresh", 1, recognized);
    const ack = vi.fn();
    await worker.queue({ messages: [{ body: { jobId: "job-fresh" }, ack, retry: vi.fn() }] } as never, { DB: f.database } as never);
    expect(f.job("fresh").status).toBe("succeeded");
    expect(f.review("fresh")).toMatchObject({ status: "ready_for_review", analysis_run_id: null, revision: 6 });
    expect(JSON.parse(String(f.review("fresh").report))).toEqual(report);
    expect(ack).toHaveBeenCalledOnce();
  });

  it("late OCR and report responses from the expired job cannot overwrite a retry", async () => {
    f.seed("stale");
    await new D1AnalysisJobs(f.database).enqueue("owner-1", "stale");
    const before = f.review("stale");
    await expect(new D1OcrCheckpointRepository(f.database).saveRecognized(
      "owner-1", "stale", 1, recognized, "job-stale",
    )).rejects.toMatchObject({ code: "IMAGE_REVISION_CONFLICT" });
    await expect(savePipelineResult(f.database, {
      id: "job-stale", ownerId: "owner-1", reviewId: "stale", mode: "full", imageRevision: 1, config: config as never,
    }, { report: { overwritten: true }, annotations: [], ocrRevision: 2 })).rejects.toMatchObject({ code: "ANALYSIS_CONFLICT" });
    expect(f.review("stale")).toEqual(before);
  });
});
