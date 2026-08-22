// @vitest-environment node

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initializeSchema } from "../db/init";
import {
  AnalysisJobCompletionClaimLostError,
  ReviewRepository,
} from "../db/review-repository";
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

  it("将本次老师补充观点随任务保存，供 Worker 传给 AI", () => {
    service.enqueue(ownerA, "review-a", "请重点核对结尾主题是否由正文支撑。");

    expect(repository.findLatestByReview(ownerA, "review-a")).toMatchObject({
      teacherGuidance: "请重点核对结尾主题是否由正文支撑。",
    });
  });

  it("content_only 模式写入任务并传给 Worker", () => {
    sqlite.prepare(`
      UPDATE reviews SET ocr_checkpoint = ? WHERE id = ?
    `).run(JSON.stringify({
      version: 1,
      sourceRevision: 0,
      ocrRevision: 1,
      editedAt: null,
      pages: [{ pageIndex: 0, text: "作文原文", readable: true, warnings: [], blocks: [] }],
    }), "review-a");
    service.enqueue(ownerA, "review-a", undefined, "content_only");

    expect(repository.findLatestByReview(ownerA, "review-a")).toMatchObject({
      mode: "content_only",
    });
  });

  it.each([
    ["没有 OCR", null],
    ["OCR 已落后于图片版本", JSON.stringify({
      version: 1,
      sourceRevision: 0,
      ocrRevision: 1,
      editedAt: null,
      pages: [{ pageIndex: 0, text: "旧原文", readable: true, warnings: [], blocks: [] }],
    })],
  ])("content_only 在%s时拒绝入队", (_case, checkpoint) => {
    sqlite.prepare(`
      UPDATE reviews SET image_revision = 1, ocr_checkpoint = ? WHERE id = ?
    `).run(checkpoint, "review-a");

    expect(() => service.enqueue(ownerA, "review-a", undefined, "content_only")).toThrow(
      expect.objectContaining({ code: "OCR_NOT_FOUND", status: 409 }),
    );
    expect(repository.findLatestByReview(ownerA, "review-a")).toBeNull();
  });

  it("不同教师可以排队，但全局一次只领取一篇作文", () => {
    service.enqueue(ownerA, "review-a");
    service.enqueue(ownerB, "review-b");

    const first = repository.claimNext();
    const second = repository.claimNext();

    expect(first).toMatchObject({ status: "running", attempt: 1, progressStage: "reading_images" });
    expect(second).toBeNull();
    repository.transition(first!, "succeeded");
    const next = repository.claimNext();
    expect(next).toMatchObject({ status: "running", attempt: 1, progressStage: "reading_images" });
    expect(next?.id).not.toBe(first?.id);
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

  it("删除中的作文会取消活动任务，历史到期时间不再影响任务", () => {
    service.enqueue(ownerA, "review-a");
    sqlite.prepare("UPDATE reviews SET deleting_at = ? WHERE id = ?").run(now.valueOf(), "review-a");
    expect(repository.cancelUnavailable()).toBe(1);
    expect(service.get(ownerA, "job-1")).toMatchObject({ status: "canceled" });

    reviewRepository.create(ownerA, { id: "expiring", config });
    service.enqueue(ownerA, "expiring");
    sqlite.prepare("UPDATE reviews SET expires_at = ? WHERE id = ?").run(now.valueOf(), "expiring");
    expect(repository.cancelUnavailable()).toBe(0);
    expect(service.get(ownerA, "job-2")).toMatchObject({ status: "queued" });
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

  it("领取前自动取消删除中作文的活动任务", () => {
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
    const workerTwoOcr = repository.updateProgress(workerTwo!, "saving_ocr");
    expect(repository.updateProgress(workerTwoOcr, "generating_review")).toMatchObject({
      progressStage: "generating_review",
    });
    expect(repository.transition(workerTwo!, "succeeded")).toMatchObject({ status: "succeeded" });
  });

  it("进度只能从读取图片依次推进，不能倒退、重复或跳过", () => {
    service.enqueue(ownerA, "review-a");
    const job = repository.claimNext();
    expect(job).not.toBeNull();

    expect(() => repository.updateProgress(job!, "reading_images")).toThrow(/非法/);
    expect(() => repository.updateProgress(job!, "generating_review")).toThrow(/非法/);
    const savingOcr = repository.updateProgress(job!, "saving_ocr");
    const generating = repository.updateProgress(savingOcr, "generating_review");
    const mapping = repository.updateProgress(generating, "mapping_annotations");
    expect(() => repository.updateProgress(mapping, "reading_images")).toThrow(/非法/);
    expect(repository.updateProgress(mapping, "validating_result")).toMatchObject({
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
    let analyzeInput: Parameters<AnalysisExecutionService["analyze"]>[0] | undefined;
    const executor: AnalysisExecutionService = {
      prepare: async () => ({ token: { revision: 0, runId: "run-1" }, config, imageDataUrls: ["data:image/jpeg;base64,QQ=="], studentName: "艾绮" }),
      analyze: async (input) => {
        analyzeInput = input;
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
      retry: () => "at_limit",
    };
    const worker = new AnalysisWorker(queue, executor, { renewEveryMs: 60_000 });

    const first = worker.runOnce();
    await started.promise;
    expect(await worker.runOnce()).toBeNull();
    expect(calls).not.toContain("succeeded");
    release.resolve();
    await first;

    expect(analyzeInput).toMatchObject({ studentName: "艾绮" });
    expect(calls).toEqual([
      "saving_ocr",
      "generating_review",
      "analyze",
      "mapping_annotations",
      "validating_result",
      "saving_result",
      "save",
    ]);
  });

  it("本机 Worker 先保存 OCR，再只把识别文字交给内容模型", async () => {
    service.enqueue(ownerA, "review-a");
    const claimed = repository.claimNext()!;
    const calls: string[] = [];
    let contentInput: unknown;
    const checkpoint = {
      version: 1 as const,
      sourceRevision: 1,
      ocrRevision: 0,
      editedAt: null,
      pages: [{
        pageIndex: 0,
        text: "我为自己鼓掌。",
        readable: true,
        warnings: [],
        blocks: [{ text: "我为自己鼓掌。", x: 0.1, y: 0.2, width: 0.3, height: 0.1 }],
      }],
    };
    const worker = new AnalysisWorker({
      claimNext: () => claimed,
      updateProgress: (job, stage) => ({ ...job, progressStage: stage } as never),
      transition: () => ({} as never),
      renewLease: () => null,
      retry: () => "at_limit",
    }, {
      prepare: async () => ({
        token: { revision: 1, runId: "run-local" },
        config,
        imageRevision: 1,
        imageDataUrls: ["data:image/jpeg;base64,QQ=="],
        checkpoint: null,
      }),
      recognize: async () => {
        calls.push("vision");
        return { pages: checkpoint.pages };
      },
      saveOcr: async () => {
        calls.push("save-ocr");
        return checkpoint;
      },
      analyzeText: async (input: unknown) => {
        calls.push("content");
        contentInput = input;
        return { report: readyEnvelope.report, annotationAnchors: [] };
      },
      save: async () => calls.push("save-report"),
      fail: async () => { throw new Error("unreachable"); },
      analyze: async () => { throw new Error("旧的图片直批入口不应被调用"); },
    } as never);

    await expect(worker.runOnce()).resolves.toMatchObject({ outcome: "succeeded" });

    expect(calls).toEqual(["vision", "save-ocr", "content", "save-report"]);
    expect(contentInput).toMatchObject({
      pages: [{ pageIndex: 0, text: "我为自己鼓掌。" }],
    });
    expect(JSON.stringify(contentInput)).not.toContain("data:image");
  });

  it("本机 content_only 复用 OCR，不读取图片也不调用视觉模型", async () => {
    const checkpoint = {
      version: 1 as const,
      sourceRevision: 0,
      ocrRevision: 3,
      editedAt: "2026-07-21T00:00:00.000Z",
      pages: [{
        pageIndex: 0,
        text: "老师修正后的作文。",
        readable: true,
        warnings: [],
        blocks: [],
      }],
    };
    sqlite.prepare("UPDATE reviews SET ocr_checkpoint = ? WHERE id = ?")
      .run(JSON.stringify(checkpoint), "review-a");
    service.enqueue(ownerA, "review-a", undefined, "content_only");
    const claimed = repository.claimNext()!;
    const recognize = vi.fn();
    const analyzeText = vi.fn(async () => ({ report: readyEnvelope.report, annotationAnchors: [] }));
    const worker = new AnalysisWorker({
      claimNext: () => claimed,
      updateProgress: (job, stage) => ({ ...job, progressStage: stage } as never),
      transition: () => ({} as never),
      renewLease: () => null,
      retry: () => "at_limit",
    }, {
      prepare: async (_ownerId, _reviewId, mode) => {
        expect(mode).toBe("content_only");
        return {
          token: { revision: 2, runId: "run-content-only" },
          config,
          imageRevision: 0,
          imageDataUrls: [],
          checkpoint,
        };
      },
      recognize,
      saveOcr: async () => { throw new Error("不应重复保存 OCR"); },
      analyzeText,
      save: async () => undefined,
      fail: async () => { throw new Error("unreachable"); },
      analyze: async () => { throw new Error("旧入口不应被调用"); },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ outcome: "succeeded" });
    expect(recognize).not.toHaveBeenCalled();
    expect(analyzeText).toHaveBeenCalledWith(expect.objectContaining({
      pages: [{ pageIndex: 0, text: "老师修正后的作文。" }],
    }));
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
      retry: () => "at_limit",
    }, {
      prepare: async () => ({ token: { revision: 0, runId: "run-1" }, config, imageDataUrls: ["data:image/jpeg;base64,QQ=="] }),
      analyze: async () => ({ readable: false, pageWarnings: ["请重拍"], annotations: [] }),
      save: async (_ownerId, _reviewId, _token, envelope) => {
        expect(envelope.readable).toBe(false);
      },
      fail: async () => { throw new Error("unreachable"); },
    });

    await worker.runOnce();

    expect(transitions).toEqual([]);
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

  it("retry 到达上限而变为 failed 时，Worker 只清理作文状态而不重复转换任务", async () => {
    service.enqueue(ownerA, "review-a");
    const claimed = repository.claimNext()!;
    const transitions: string[] = [];
    let failCalls = 0;
    const worker = new AnalysisWorker({
      claimNext: () => claimed,
      updateProgress: (_job, stage) => ({ ...claimed, progressStage: stage } as never),
      transition: (_job, status) => {
        transitions.push(status);
        return {} as never;
      },
      renewLease: () => null,
      retry: () => "at_limit",
    }, {
      prepare: async () => ({ token: { revision: 0, runId: "run-1" }, config, imageDataUrls: ["data:image/jpeg;base64,QQ=="] }),
      analyze: async () => { throw Object.assign(new Error("request"), { code: "AI_REQUEST_FAILED" }); },
      save: async () => { throw new Error("unreachable"); },
      fail: async () => { failCalls += 1; },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ outcome: "failed", errorCode: "AI_REQUEST_FAILED" });
    expect(failCalls).toBe(1);
    expect(transitions).toEqual([]);
  });

  it("图片数量不符合要求时，Worker 安全结束任务且保留未开始分析的草稿", async () => {
    service.enqueue(ownerA, "review-a");
    const claimed = repository.claimNext()!;
    const transitions: Array<{ status: string; code: string | null | undefined }> = [];
    const worker = new AnalysisWorker({
      claimNext: () => claimed,
      updateProgress: (_job, stage) => ({ ...claimed, progressStage: stage } as never),
      transition: (_job, status, options) => {
        transitions.push({ status, code: options?.errorCode });
        return {} as never;
      },
      renewLease: () => null,
      retry: () => "at_limit",
    }, {
      prepare: async () => { throw Object.assign(new Error("no images"), { code: "IMAGES_REQUIRED" }); },
      analyze: async () => { throw new Error("unreachable"); },
      save: async () => { throw new Error("unreachable"); },
      fail: async () => { throw new Error("unreachable"); },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ outcome: "failed", errorCode: "IMAGES_REQUIRED" });
    expect(transitions).toEqual([{ status: "failed", code: "IMAGES_REQUIRED" }]);
  });

  it("教师编辑导致保存冲突时取消旧任务，保留编辑并继续处理下一项", async () => {
    service.enqueue(ownerA, "review-a");
    service.enqueue(ownerB, "review-b");
    let firstSave = true;
    const worker = new AnalysisWorker(repository, {
      prepare: async (ownerId, reviewId) => {
        const review = reviewRepository.getById(ownerId, reviewId)!;
        return {
          token: reviewRepository.beginAnalysis(ownerId, reviewId, `run-${reviewId}`, review.revision),
          config: review.config,
          imageDataUrls: ["data:image/jpeg;base64,QQ=="],
        };
      },
      analyze: async () => readyEnvelope,
      save: async (ownerId, reviewId, token, envelope, claim) => {
        if (firstSave) {
          firstSave = false;
          reviewRepository.updateConfig(ownerId, reviewId, { ...config, title: "教师刚修改的题目" });
          throw Object.assign(new Error("stale"), { code: "ANALYSIS_CONFLICT" });
        }
        reviewRepository.saveAnalysisAndCompleteJob(ownerId, reviewId, token, envelope, claim);
      },
      fail: async () => { throw new Error("不应触发失败保存"); },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({ outcome: "canceled", errorCode: "ANALYSIS_CONFLICT" });
    expect(reviewRepository.getById(ownerA, "review-a")).toMatchObject({
      config: { title: "教师刚修改的题目" },
      status: "draft",
    });
    expect(repository.getById(ownerA, "job-1")).toMatchObject({ status: "canceled" });

    await expect(worker.runOnce()).resolves.toMatchObject({ outcome: "succeeded" });
    expect(repository.getById(ownerB, "job-2")).toMatchObject({ status: "succeeded" });
  });

  it("保存批改结果和任务成功在同一事务中落库，恢复轮询不会重复调用模型", async () => {
    service.enqueue(ownerA, "review-a");
    const claimed = repository.claimNext()!;
    const token = reviewRepository.beginAnalysis(ownerA, "review-a", "run-saved", 0);
    reviewRepository.saveAnalysisAndCompleteJob(ownerA, "review-a", token, readyEnvelope, claimed);
    expect(repository.getById(ownerA, claimed.id)).toMatchObject({ status: "succeeded" });
    expect(reviewRepository.getById(ownerA, "review-a")).toMatchObject({
      status: "ready_for_review",
      analysisRunId: null,
    });
    let analyzed = 0;
    const worker = new AnalysisWorker(repository, {
      prepare: async () => { throw new Error("不应再次读取图片"); },
      analyze: async () => { analyzed += 1; return readyEnvelope; },
      save: async () => { throw new Error("不应再次保存"); },
      fail: async () => { throw new Error("不应失败"); },
    });

    now = new Date(now.valueOf() + 60_001);
    await expect(worker.runOnce()).resolves.toBeNull();
    expect(analyzed).toBe(0);
  });

  it("任务 claim CAS 失败时回滚已准备写入的报告", () => {
    service.enqueue(ownerA, "review-a");
    const claimed = repository.claimNext()!;
    const token = reviewRepository.beginAnalysis(ownerA, "review-a", "run-rollback", 0);

    expect(() => reviewRepository.saveAnalysisAndCompleteJob(ownerA, "review-a", token, readyEnvelope, {
      ...claimed,
      leaseExpiresAt: new Date(claimed.leaseExpiresAt.valueOf() - 1),
    })).toThrow(AnalysisJobCompletionClaimLostError);
    expect(reviewRepository.getById(ownerA, "review-a")).toMatchObject({
      status: "analyzing",
      analysisRunId: "run-rollback",
      report: null,
    });
    expect(repository.getById(ownerA, claimed.id)).toMatchObject({ status: "running" });
  });

  it("终态失败时作文和任务在同一事务中落库，claim 失败会整体回滚", () => {
    service.enqueue(ownerA, "review-a");
    const claimed = repository.claimNext()!;
    const token = reviewRepository.beginAnalysis(ownerA, "review-a", "run-fail", 0);

    reviewRepository.failAnalysisAndFailJob(ownerA, "review-a", token, claimed, "AI_REQUEST_FAILED");
    expect(reviewRepository.getById(ownerA, "review-a")).toMatchObject({
      status: "failed",
      analysisRunId: null,
    });
    expect(repository.getById(ownerA, claimed.id)).toMatchObject({
      status: "failed",
      errorCode: "AI_REQUEST_FAILED",
    });

    reviewRepository.create(ownerA, { id: "review-rollback-fail", config });
    service.enqueue(ownerA, "review-rollback-fail");
    const nextClaim = repository.claimNext()!;
    const nextToken = reviewRepository.beginAnalysis(ownerA, "review-rollback-fail", "run-fail-rollback", 0);
    expect(() => reviewRepository.failAnalysisAndFailJob(ownerA, "review-rollback-fail", nextToken, {
      ...nextClaim,
      leaseExpiresAt: new Date(nextClaim.leaseExpiresAt.valueOf() - 1),
    }, "AI_REQUEST_FAILED")).toThrow(AnalysisJobCompletionClaimLostError);
    expect(reviewRepository.getById(ownerA, "review-rollback-fail")).toMatchObject({
      status: "analyzing",
      analysisRunId: "run-fail-rollback",
    });
    expect(repository.getById(ownerA, nextClaim.id)).toMatchObject({ status: "running" });
  });

  it("耗时模型调用期间 Worker 定期续租并使用最新租约完成任务", async () => {
    service.enqueue(ownerA, "review-a");
    const claimed = repository.claimNext()!;
    const release = deferred<void>();
    let renewals = 0;
    const savedLeases: Date[] = [];
    const worker = new AnalysisWorker({
      claimNext: () => claimed,
      updateProgress: (job, stage) => ({ ...claimed, ...job, progressStage: stage } as never),
      transition: () => ({} as never),
      renewLease: (id, priorLease) => {
        renewals += 1;
        return { ...claimed, id, leaseExpiresAt: new Date(priorLease.valueOf() + 60_000) };
      },
      retry: () => "at_limit",
    }, {
      prepare: async () => ({ token: { revision: 0, runId: "run-1" }, config, imageDataUrls: ["data:image/jpeg;base64,QQ=="] }),
      analyze: async () => {
        await release.promise;
        return readyEnvelope;
      },
      save: async (_ownerId, _reviewId, _token, _envelope, claim) => {
        savedLeases.push(claim.leaseExpiresAt);
      },
      fail: async () => undefined,
    }, { renewEveryMs: 5 });

    const pending = worker.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 25));
    release.resolve();
    await pending;

    expect(renewals).toBeGreaterThan(0);
    expect(savedLeases.at(-1)?.valueOf()).toBeGreaterThan(claimed.leaseExpiresAt.valueOf());
  });
});
