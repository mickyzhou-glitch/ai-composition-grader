// @vitest-environment node

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initializeSchema } from "../db/init";
import { ReviewRepository } from "../db/review-repository";
import * as schema from "../db/schema";
import {
  AnalysisJobLostClaimError,
  AnalysisJobNotFoundError,
  AnalysisJobRepository,
  AnalysisJobUnavailableReviewError,
} from "./analysis-job-repository";
import { AnalysisJobService } from "./analysis-job-service";
import {
  AnalysisWorker,
  type AnalysisExecutionService,
  type AnalysisJobQueue,
} from "./analysis-worker";

const ownerA = "teacher-a";
const ownerB = "teacher-b";
const config = {
  title: "为自己鼓掌",
  grade: "上海五四学制六年级",
  writingRequirements: "写一件亲身经历的事。",
  targetCharacters: 600,
  structureRequirements: "五段展开。",
  scoringFocus: "细节描写。",
  templateType: "custom" as const,
};

const readyEnvelope = {
  readable: true as const,
  pageWarnings: [],
  report: {
    themeFit: "fits" as const,
    themeReason: "切题。",
    personalizedComment: "继续努力。",
    painPoints: [],
    commonIssues: [],
    revisionSuggestions: [],
    scores: {
      themeIntent: 9,
      contentSelection: 9,
      structure: 7,
      languageExpression: 7,
      writingConventions: 4,
      total: 36,
      level: "优秀作文" as const,
    },
    sampleParagraphs: [{ title: "示范", text: "我为自己鼓掌。", suggestion: "补充细节。" }],
  },
  annotations: [],
};

function addTeacher(sqlite: Database.Database, id: string): void {
  sqlite.prepare(
    `INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at)
     VALUES (?, ?, '!test', 'teacher', 0, 1, 1)`,
  ).run(id, id);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("AnalysisJobService", () => {
  let sqlite: Database.Database;
  let now: Date;
  let reviewRepository: ReviewRepository;
  let repository: AnalysisJobRepository;
  let service: AnalysisJobService;
  let nextId = 0;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    initializeSchema(sqlite);
    addTeacher(sqlite, ownerA);
    addTeacher(sqlite, ownerB);
    now = new Date("2026-07-21T00:00:00.000Z");
    nextId = 0;
    const database = drizzle(sqlite, { schema });
    reviewRepository = new ReviewRepository(database, { now: () => now });
    repository = new AnalysisJobRepository(database, {
      now: () => now,
      createId: () => `job-${++nextId}`,
      maxAttempts: 2,
      leaseMs: 60_000,
    });
    service = new AnalysisJobService(repository);
    reviewRepository.create(ownerA, { id: "review-a", config });
    reviewRepository.create(ownerB, { id: "review-b", config });
  });

  afterEach(() => sqlite.close());

  it("创建 queued 任务且对同一作文重复点击返回活动任务", () => {
    const first = service.enqueue(ownerA, "review-a");
    const duplicate = service.enqueue(ownerA, "review-a");

    expect(first).toMatchObject({
      id: "job-1",
      reviewId: "review-a",
      status: "queued",
      progressStage: "queued",
      message: null,
      createdAt: now.toISOString(),
      finishedAt: null,
    });
    expect(duplicate).toEqual(first);
    expect(sqlite.prepare("SELECT count(*) AS count FROM analysis_jobs").get()).toEqual({ count: 1 });
  });

  it("不同教师可以排队，而同一时刻只有一个领取者取得每个任务", () => {
    service.enqueue(ownerA, "review-a");
    service.enqueue(ownerB, "review-b");

    const first = repository.claimNext();
    const second = repository.claimNext();
    const third = repository.claimNext();

    expect(first).toMatchObject({ status: "running", attempt: 1, progressStage: "reading_images" });
    expect(second).toMatchObject({ status: "running", attempt: 1, progressStage: "reading_images" });
    expect(first?.id).not.toBe(second?.id);
    expect(third).toBeNull();
  });

  it("领取原子写入运行状态、租约、尝试次数和读取阶段", () => {
    service.enqueue(ownerA, "review-a");

    const claimed = repository.claimNext();

    expect(claimed).toMatchObject({
      status: "running",
      attempt: 1,
      progressStage: "reading_images",
      startedAt: now,
      leaseExpiresAt: new Date(now.valueOf() + 60_000),
    });
  });

  it("有效租约不能被重复领取，过期后可以回收再领取", () => {
    service.enqueue(ownerA, "review-a");
    const first = repository.claimNext();
    expect(repository.claimNext()).toBeNull();

    now = new Date(now.valueOf() + 60_001);
    const recovered = repository.claimNext();

    expect(recovered).toMatchObject({ id: first?.id, status: "running", attempt: 2 });
  });

  it("到达尝试上限的过期任务会失败且不会无限重试", () => {
    service.enqueue(ownerA, "review-a");
    repository.claimNext();
    now = new Date(now.valueOf() + 60_001);
    repository.claimNext();
    now = new Date(now.valueOf() + 60_001);

    expect(repository.claimNext()).toBeNull();
    expect(service.get(ownerA, "job-1")).toMatchObject({ status: "failed", finishedAt: now.toISOString() });
  });

  it("仅允许合法的状态转换", () => {
    service.enqueue(ownerA, "review-a");
    const job = repository.claimNext();
    expect(job).not.toBeNull();

    expect(() => repository.transition(job!, "queued")).toThrow(/非法/);
    repository.transition(job!, "succeeded");
    expect(() => repository.transition(job!, "failed")).toThrow(/非法/);
  });

  it("删除中或到期的作文会取消活动任务", () => {
    service.enqueue(ownerA, "review-a");
    sqlite.prepare("UPDATE reviews SET deleting_at = ? WHERE id = ?").run(now.valueOf(), "review-a");
    expect(repository.cancelUnavailable()).toBe(1);
    expect(service.get(ownerA, "job-1")).toMatchObject({ status: "canceled" });

    reviewRepository.create(ownerA, { id: "expiring", config });
    service.enqueue(ownerA, "expiring");
    sqlite.prepare("UPDATE reviews SET expires_at = ? WHERE id = ?").run(now.valueOf(), "expiring");
    expect(repository.cancelUnavailable()).toBe(1);
    expect(service.get(ownerA, "job-2")).toMatchObject({ status: "canceled" });
  });

  it("按 jobId 和 ownerId 查询，其他教师只得到 NOT_FOUND", () => {
    service.enqueue(ownerA, "review-a");

    expect(() => service.get(ownerB, "job-1")).toThrow(AnalysisJobNotFoundError);
    try {
      service.get(ownerB, "job-1");
    } catch (error) {
      expect(error).toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("对页面公开的任务视图不泄露租约、尝试或内部错误", () => {
    service.enqueue(ownerA, "review-a");
    const claimed = repository.claimNext();
    repository.transition(claimed!, "failed", { errorCode: "UPSTREAM_500", message: "请稍后重试" });

    const view = service.get(ownerA, claimed!.id);

    expect(view).toEqual({
      id: claimed!.id,
      reviewId: "review-a",
      status: "failed",
      progressStage: "reading_images",
      message: "分析暂未完成，请稍后重试",
      createdAt: now.toISOString(),
      finishedAt: now.toISOString(),
    });
    expect(view).not.toHaveProperty("attempt");
    expect(view).not.toHaveProperty("leaseExpiresAt");
    expect(view).not.toHaveProperty("errorCode");
  });

  it("尝试为删除中的作文重复排队时，会提交取消状态再返回不可用错误", () => {
    service.enqueue(ownerA, "review-a");
    sqlite.prepare("UPDATE reviews SET deleting_at = ? WHERE id = ?").run(now.valueOf(), "review-a");

    expect(() => service.enqueue(ownerA, "review-a")).toThrow(AnalysisJobUnavailableReviewError);
    try {
      service.enqueue(ownerA, "review-a");
    } catch (error) {
      expect(error).toMatchObject({ code: "REVIEW_UNAVAILABLE" });
    }
    expect(repository.getById(ownerA, "job-1")).toMatchObject({
      status: "canceled",
      errorCode: "REVIEW_UNAVAILABLE",
    });
  });

  it("领取前自动取消删除或到期作文的活动任务", () => {
    service.enqueue(ownerA, "review-a");
    sqlite.prepare("UPDATE reviews SET deleting_at = ? WHERE id = ?").run(now.valueOf(), "review-a");

    expect(repository.claimNext()).toBeNull();
    expect(repository.getById(ownerA, "job-1")).toMatchObject({ status: "canceled" });
  });

  it("租约过期并被第二个 Worker 重领后，第一个 Worker 不能更新进度或完成任务", () => {
    service.enqueue(ownerA, "review-a");
    const workerOne = repository.claimNext();
    expect(workerOne).not.toBeNull();
    now = new Date(now.valueOf() + 60_001);
    const workerTwo = repository.claimNext();
    expect(workerTwo).toMatchObject({ id: workerOne?.id, attempt: 2 });

    expect(() => repository.updateProgress(workerOne!, "generating_review")).toThrow(
      AnalysisJobLostClaimError,
    );
    expect(() => repository.transition(workerOne!, "succeeded")).toThrow(
      AnalysisJobLostClaimError,
    );
    expect(repository.updateProgress(workerTwo!, "generating_review")).toMatchObject({
      progressStage: "generating_review",
    });
    expect(repository.transition(workerTwo!, "succeeded")).toMatchObject({ status: "succeeded" });
  });

  it("进度只能从读取图片依次推进，不能倒退、重复或跳过", () => {
    service.enqueue(ownerA, "review-a");
    const job = repository.claimNext();
    expect(job).not.toBeNull();

    expect(() => repository.updateProgress(job!, "reading_images")).toThrow(/非法/);
    expect(() => repository.updateProgress(job!, "validating_result")).toThrow(/非法/);
    const generating = repository.updateProgress(job!, "generating_review");
    expect(() => repository.updateProgress(generating, "reading_images")).toThrow(/非法/);
    expect(repository.updateProgress(generating, "validating_result")).toMatchObject({
      progressStage: "validating_result",
    });
  });

  it("两个任务仓储共享数据库时，第二个领取者不会取得同一任务", () => {
    service.enqueue(ownerA, "review-a");
    const secondRepository = new AnalysisJobRepository(
      drizzle(sqlite, { schema }),
      { now: () => now, maxAttempts: 2, leaseMs: 60_000 },
    );

    const first = repository.claimNext();
    const second = secondRepository.claimNext();

    expect(first?.id).toBe("job-1");
    expect(second).toBeNull();
  });

  it("Worker 单并发按阶段保存成功结果后才结束任务", async () => {
    service.enqueue(ownerA, "review-a");
    const claimed = repository.claimNext();
    expect(claimed).not.toBeNull();
    const started = deferred<void>();
    const release = deferred<void>();
    const calls: string[] = [];
    const executor: AnalysisExecutionService = {
      prepare: async () => ({ token: { revision: 0, runId: "run-1" }, config, imageDataUrls: ["data:image/jpeg;base64,QQ=="] }),
      analyze: async () => {
        calls.push("analyze");
        started.resolve();
        await release.promise;
        return readyEnvelope;
      },
      save: async () => calls.push("save"),
      fail: async () => calls.push("fail"),
    };
    const queue: AnalysisJobQueue = {
      claimNext: (() => {
        let next = claimed;
        return () => {
          const result = next;
          next = null;
          return result;
        };
      })(),
      updateProgress: (job, stage) => {
        calls.push(stage);
        return { ...claimed!, progressStage: stage } as never;
      },
      transition: (job, status) => {
        calls.push(status);
        return { ...job, status, leaseExpiresAt: null } as never;
      },
      renewLease: () => null,
      retry: () => "failed",
    };
    const worker = new AnalysisWorker(queue, executor, { renewEveryMs: 60_000 });

    const first = worker.runOnce();
    await started.promise;
    expect(await worker.runOnce()).toBeNull();
    expect(calls).not.toContain("succeeded");
    release.resolve();
    await first;

    expect(calls).toEqual([
      "generating_review",
      "analyze",
      "validating_result",
      "saving_result",
      "save",
      "succeeded",
    ]);
  });

  it("图片不可辨认时 Worker 保存 needs_better_images 并正常结束任务", async () => {
    service.enqueue(ownerA, "review-a");
    const claimed = repository.claimNext()!;
    const transitions: string[] = [];
    const worker = new AnalysisWorker({
      claimNext: () => claimed,
      updateProgress: (_job, stage) => ({ ...claimed, progressStage: stage } as never),
      transition: (_job, status) => {
        transitions.push(status);
        return {} as never;
      },
      renewLease: () => null,
      retry: () => "failed",
    }, {
      prepare: async () => ({ token: { revision: 0, runId: "run-1" }, config, imageDataUrls: ["data:image/jpeg;base64,QQ=="] }),
      analyze: async () => ({ readable: false, pageWarnings: ["请重拍"], annotations: [] }),
      save: async (_ownerId, _reviewId, _token, envelope) => {
        expect(envelope.readable).toBe(false);
      },
      fail: async () => { throw new Error("unreachable"); },
    });

    await worker.runOnce();

    expect(transitions).toEqual(["succeeded"]);
  });

  it("模型错误只按尝试上限重试，并使用安全错误码", async () => {
    service.enqueue(ownerA, "review-a");
    const claimed = repository.claimNext()!;
    const retries: string[] = [];
    const worker = new AnalysisWorker({
      claimNext: () => claimed,
      updateProgress: (_job, stage) => ({ ...claimed, progressStage: stage } as never),
      transition: () => ({} as never),
      renewLease: () => null,
      retry: (_job, code) => {
        retries.push(code);
        return "queued";
      },
    }, {
      prepare: async () => ({ token: { revision: 0, runId: "run-1" }, config, imageDataUrls: ["data:image/jpeg;base64,QQ=="] }),
      analyze: async () => { throw Object.assign(new Error("upstream response secret"), { code: "AI_REQUEST_FAILED" }); },
      save: async () => { throw new Error("unreachable"); },
      fail: async () => { throw new Error("unreachable"); },
    });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ outcome: "retrying", errorCode: "AI_REQUEST_FAILED" });
    expect(retries).toEqual(["AI_REQUEST_FAILED"]);
  });
});
