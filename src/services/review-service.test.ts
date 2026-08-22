// @vitest-environment node

import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiReviewEnvelope, AssignmentConfig } from "../domain/contracts";
import { initializeSchema } from "../db/init";
import { ReviewRepository, type ReviewImageInput } from "../db/review-repository";
import * as schema from "../db/schema";
import { AnalysisJobRepository } from "../jobs/analysis-job-repository";
import { AnalysisJobService } from "../jobs/analysis-job-service";
import { encodeOrdinaryBoundMarker } from "../jobs/analysis-job-metadata";
import { AnalysisWorker } from "../jobs/analysis-worker";
import { ReviewFileStore } from "../storage/review-file-store";
import { PdfService } from "../pdf/pdf-service";
import { InMemoryReviewLock } from "./review-lock";
import { ReviewService } from "./review-service";

const OWNER_ID = "local-admin";

const config: AssignmentConfig = {
  title: "为自己喝彩",
  grade: "上海五四学制六年级",
  writingRequirements: "写一件亲身经历的事。",
  targetCharacters: 600,
  structureRequirements: "开头点题，结尾升华。",
  scoringFocus: "细节描写。",
  templateType: "preset_self_applause",
};

const readyEnvelope: AiReviewEnvelope = {
  readable: true,
  pageWarnings: [],
  report: {
    themeFit: "fits",
    themeReason: "切题。",
    personalizedComment: "继续努力。",
    painPoints: [],
    commonIssues: [],
    revisionSuggestions: [],
    grade: "A-",
    diagnostics: {
      authenticityAndRelevance: { finding: "主题紧扣真实事件。", action: "保留这件亲身经历。" },
      materialAndDetails: { finding: "关键动作还可展开。", action: "补写一个动作和心理。" },
      structure: { finding: "五段结构完整。", action: "让转折段承接前文。" },
      language: { finding: "段首衔接自然。", action: "继续用动作承接段落。" },
    },
    sampleParagraphs: Array.from({ length: 5 }, (_, index) => ({
      title: `第 ${index + 1} 段`,
      text: "我".repeat(120),
      suggestion: "补充细节。",
    })),
  },
  annotations: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("ReviewService analysis CAS", () => {
  let sqlite: Database.Database;
  let temporaryDirectory: string;
  let repository: ReviewRepository;
  let fileStore: ReviewFileStore;
  let image: ReviewImageInput;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    initializeSchema(sqlite);
    repository = new ReviewRepository(drizzle(sqlite, { schema }));
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "grader-cas-"));
    fileStore = new ReviewFileStore(path.join(temporaryDirectory, "reviews"));
    repository.create(OWNER_ID, { id: "review-1", config });
    await fileStore.writeFile(OWNER_ID, "review-1", "images", "page-original.jpg", "original");
    await fileStore.writeFile(OWNER_ID, "review-1", "images", "page-annotation.jpg", "annotation");
    await fileStore.writeFile(OWNER_ID, "review-1", "images", "page-ai.jpg", "ai");
    image = {
      position: 0,
      originalName: "page.jpg",
      mimeType: "image/jpeg",
      originalPath: "images/page-original.jpg",
      annotationPath: "images/page-annotation.jpg",
      aiPath: "images/page-ai.jpg",
      width: 1,
      height: 1,
      rotation: 0,
      crop: null,
    };
    repository.replaceImages(OWNER_ID, "review-1", 0, [image]);
  });

  afterEach(async () => {
    sqlite.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  function serviceFor(analyze: (input: unknown) => Promise<AiReviewEnvelope>) {
    let run = 0;
    return new ReviewService(repository, fileStore, { analyze } as never, {
      createId: () => "unused",
      createRunId: () => `run-${++run}`,
    } as never);
  }

  function workerFor(reviews: ReviewService, jobs: AnalysisJobRepository): AnalysisWorker {
    return new AnalysisWorker(jobs, {
      prepare: (ownerId, reviewId, mode, claim, prebound) =>
        prebound
          ? reviews.prepareQueuedAnalysis(ownerId, reviewId, mode, claim)
          : reviews.prepareAnalysis(ownerId, reviewId, mode, claim),
      analyze: (input) => reviews.analyzePrepared(input),
      save: (ownerId, reviewId, token, envelope, claim) =>
        reviews.savePreparedAnalysisAndCompleteJob(ownerId, reviewId, token, envelope, claim),
      fail: (ownerId, reviewId, token, claim, errorCode) =>
        reviews.failPreparedAnalysisAndFailJob(ownerId, reviewId, token, claim, errorCode),
      finishUnprepared: (ownerId, reviewId, runId, claim, target, errorCode) =>
        reviews.finishQueuedAnalysisBeforeToken(
          ownerId,
          reviewId,
          runId,
          claim,
          target,
          errorCode,
        ),
    });
  }

  it("将已保存的学生姓名传给 AI 分析", async () => {
    const analyze = vi.fn(async () => readyEnvelope);
    const service = serviceFor(analyze);
    await service.update(OWNER_ID, "review-1", {
      expectedRevision: 1,
      studentName: "艾绮",
    });

    await service.analyze(OWNER_ID, "review-1");

    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({
      studentName: "艾绮",
    }));
  });

  it("准备后台任务时原样使用预先入队的 job ID 作为 run ID", async () => {
    const service = serviceFor(async () => readyEnvelope);

    const prepared = await service.prepareAnalysis(
      OWNER_ID,
      "review-1",
      "full",
      "queued-job-1",
    );

    expect(prepared.token).toEqual({ revision: 1, runId: "queued-job-1" });
    expect(repository.getById(OWNER_ID, "review-1")).toMatchObject({
      status: "analyzing",
      analysisRunId: "queued-job-1",
    });
  });

  it("普通 full job 通过生产 Worker 准备路径调用 AI 并成功", async () => {
    const analyze = vi.fn(async () => readyEnvelope);
    const reviews = serviceFor(analyze);
    const jobs = new AnalysisJobRepository(drizzle(sqlite, { schema }), {
      createId: () => "ordinary-full-job",
      leaseMs: 60_000,
    });
    new AnalysisJobService(jobs).enqueue(OWNER_ID, "review-1");
    const worker = workerFor(reviews, jobs);

    await expect(worker.runOnce()).resolves.toEqual({
      jobId: "ordinary-full-job",
      outcome: "succeeded",
    });
    expect(analyze).toHaveBeenCalledOnce();
    expect(jobs.getById(OWNER_ID, "ordinary-full-job")).toMatchObject({ status: "succeeded" });
    expect(repository.getById(OWNER_ID, "review-1")).toMatchObject({
      status: "ready_for_review",
      analysisRunId: null,
    });
  });

  it("普通 content_only job 通过生产 Worker 准备路径调用 AI 并成功", async () => {
    const review = sqlite.prepare(
      "SELECT image_revision AS imageRevision FROM reviews WHERE id = ?",
    ).get("review-1") as { imageRevision: number };
    sqlite.prepare("UPDATE reviews SET ocr_checkpoint = ? WHERE id = ?").run(JSON.stringify({
      version: 1,
      sourceRevision: review.imageRevision,
      ocrRevision: 1,
      editedAt: null,
      pages: [{ pageIndex: 0, text: "作文原文", readable: true, warnings: [], blocks: [] }],
    }), "review-1");
    const analyze = vi.fn(async () => readyEnvelope);
    const reviews = serviceFor(analyze);
    const jobs = new AnalysisJobRepository(drizzle(sqlite, { schema }), {
      createId: () => "ordinary-content-job",
      leaseMs: 60_000,
    });
    new AnalysisJobService(jobs).enqueue(OWNER_ID, "review-1", undefined, "content_only");

    await expect(workerFor(reviews, jobs).runOnce()).resolves.toEqual({
      jobId: "ordinary-content-job",
      outcome: "succeeded",
    });
    expect(analyze).toHaveBeenCalledOnce();
    expect(jobs.getById(OWNER_ID, "ordinary-content-job")).toMatchObject({ status: "succeeded" });
  });

  it("普通任务首次准备写入 bound marker，retry 后按 prebound 路径成功", async () => {
    const analyze = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("temporary"), { code: "AI_REQUEST_FAILED" }))
      .mockResolvedValueOnce(readyEnvelope);
    const reviews = serviceFor(analyze);
    const jobs = new AnalysisJobRepository(drizzle(sqlite, { schema }), {
      createId: () => "ordinary-retry-job",
      leaseMs: 60_000,
    });
    new AnalysisJobService(jobs).enqueue(OWNER_ID, "review-1");
    const worker = workerFor(reviews, jobs);

    await expect(worker.runOnce()).resolves.toEqual({
      jobId: "ordinary-retry-job",
      outcome: "retrying",
      errorCode: "AI_REQUEST_FAILED",
    });
    expect(jobs.getById(OWNER_ID, "ordinary-retry-job")).toMatchObject({
      status: "queued",
      message: encodeOrdinaryBoundMarker(),
      prebound: true,
    });
    expect(repository.getById(OWNER_ID, "review-1")).toMatchObject({
      status: "analyzing",
      analysisRunId: "ordinary-retry-job",
    });

    await expect(worker.runOnce()).resolves.toEqual({
      jobId: "ordinary-retry-job",
      outcome: "succeeded",
    });
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(jobs.getById(OWNER_ID, "ordinary-retry-job")).toMatchObject({
      status: "succeeded",
      message: null,
      prebound: false,
    });
  });

  it("旧 Worker 的过期 claim 不能在新 Worker 重领后绑定 review 或调用 AI", async () => {
    let now = new Date("2026-08-22T06:00:00.000Z");
    const database = drizzle(sqlite, { schema });
    const claimedRepository = new ReviewRepository(database, { now: () => now });
    const analyze = vi.fn(async () => readyEnvelope);
    const reviews = new ReviewService(claimedRepository, fileStore, { analyze } as never);
    const jobs = new AnalysisJobRepository(database, {
      now: () => now,
      createId: () => "lease-race-job",
      leaseMs: 1_000,
      maxAttempts: 3,
    });
    new AnalysisJobService(jobs).enqueue(OWNER_ID, "review-1");
    const enteredPrepare = deferred<void>();
    const releasePrepare = deferred<void>();
    const prepareWithClaim = (
      ownerId: string,
      reviewId: string,
      mode: "full" | "content_only",
      claim: { id: string; attempt: number; leaseExpiresAt: Date },
      prebound: boolean,
    ) => {
      return prebound
        ? reviews.prepareQueuedAnalysis(ownerId, reviewId, mode, claim)
        : reviews.prepareAnalysis(ownerId, reviewId, mode, claim);
    };
    const execution = {
      analyze: (input: Parameters<ReviewService["analyzePrepared"]>[0]) =>
        reviews.analyzePrepared(input),
      save: (
        ownerId: string,
        reviewId: string,
        token: Parameters<ReviewService["savePreparedAnalysisAndCompleteJob"]>[2],
        envelope: Parameters<ReviewService["savePreparedAnalysisAndCompleteJob"]>[3],
        claim: Parameters<ReviewService["savePreparedAnalysisAndCompleteJob"]>[4],
      ) => reviews.savePreparedAnalysisAndCompleteJob(ownerId, reviewId, token, envelope, claim),
      fail: (
        ownerId: string,
        reviewId: string,
        token: Parameters<ReviewService["failPreparedAnalysisAndFailJob"]>[2],
        claim: Parameters<ReviewService["failPreparedAnalysisAndFailJob"]>[3],
        errorCode: string,
      ) => reviews.failPreparedAnalysisAndFailJob(ownerId, reviewId, token, claim, errorCode),
    };
    const workerOne = new AnalysisWorker(jobs, {
      prepare: async (ownerId, reviewId, mode, claim, prebound) => {
        enteredPrepare.resolve();
        await releasePrepare.promise;
        return prepareWithClaim(ownerId, reviewId, mode, claim, prebound);
      },
      ...execution,
    }, { renewEveryMs: 60_000 });

    const firstRun = workerOne.runOnce();
    await enteredPrepare.promise;
    now = new Date(now.valueOf() + 1_001);
    const secondClaim = jobs.claimNext()!;
    expect(secondClaim).toMatchObject({ id: "lease-race-job", attempt: 2, prebound: false });
    releasePrepare.resolve();

    await expect(firstRun).resolves.toEqual({ jobId: "lease-race-job", outcome: "claim_lost" });
    expect(analyze).not.toHaveBeenCalled();
    expect(claimedRepository.getById(OWNER_ID, "review-1")).toMatchObject({
      status: "draft",
      analysisRunId: null,
    });

    let secondAvailable = true;
    const workerTwo = new AnalysisWorker({
      claimNext: () => {
        if (!secondAvailable) return null;
        secondAvailable = false;
        return secondClaim;
      },
      updateProgress: (claim, stage) => jobs.updateProgress(claim, stage),
      transition: (claim, status, options) => jobs.transition(claim, status, options),
      renewLease: (id, expectedLeaseExpiresAt) => jobs.renewLease(id, expectedLeaseExpiresAt),
      retry: (claim, errorCode) => jobs.retry(claim, errorCode),
    }, {
      prepare: prepareWithClaim,
      ...execution,
    }, { renewEveryMs: 60_000 });
    await expect(workerTwo.runOnce()).resolves.toEqual({
      jobId: "lease-race-job",
      outcome: "succeeded",
    });
    expect(analyze).toHaveBeenCalledOnce();
  });

  it("分析期间改配置时丢弃旧结果且保持新配置的 draft", async () => {
    const ai = deferred<AiReviewEnvelope>();
    const analyze = vi.fn(() => ai.promise);
    const service = serviceFor(analyze);

    const pending = service.analyze(OWNER_ID, "review-1");
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    await service.update(OWNER_ID, "review-1", {
      expectedRevision: 1,
      config: { ...config, title: "新题目" },
    });
    ai.resolve(readyEnvelope);

    await expect(pending).rejects.toMatchObject({ code: "ANALYSIS_CONFLICT" });
    expect(repository.getById(OWNER_ID, "review-1")).toMatchObject({
      status: "draft",
      revision: 2,
      analysisRunId: null,
      report: null,
      config: { title: "新题目" },
    });
  });

  it.each([
    ["report", { report: readyEnvelope.report }, { report: readyEnvelope.report }],
    [
      "annotations",
      {
        annotations: [{
          pageIndex: 0,
          x: 0.2,
          y: 0.3,
          category: "sentence" as const,
          anchorText: "我跑得很快",
          comment: "补充动作细节。",
          isHighlight: false,
        }],
      },
      { annotations: [{ category: "sentence" }] },
    ],
  ])("分析期间教师修改 %s 时使旧分析 CAS 失效", async (_field, edits, saved) => {
    const ai = deferred<AiReviewEnvelope>();
    const analyze = vi.fn(() => ai.promise);
    const service = serviceFor(analyze);

    const pending = service.analyze(OWNER_ID, "review-1");
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    const edited = await service.update(OWNER_ID, "review-1", { ...edits, expectedRevision: 1 });
    ai.resolve(readyEnvelope);

    expect(edited).toMatchObject({
      revision: 2,
      analysisRunId: null,
      ...saved,
    });
    await expect(pending).rejects.toMatchObject({ code: "ANALYSIS_CONFLICT" });
    expect(repository.getById(OWNER_ID, "review-1")).toMatchObject({
      revision: 2,
      analysisRunId: null,
      ...saved,
    });
  });

  it("分析期间换图时旧结果不能覆盖新图片状态", async () => {
    const ai = deferred<AiReviewEnvelope>();
    const analyze = vi.fn(() => ai.promise);
    const service = serviceFor(analyze);

    const pending = service.analyze(OWNER_ID, "review-1");
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    repository.replaceImages(OWNER_ID, "review-1", 1, [{ ...image, originalName: "new.jpg" }]);
    ai.resolve(readyEnvelope);

    await expect(pending).rejects.toMatchObject({ code: "ANALYSIS_CONFLICT" });
    expect(repository.getById(OWNER_ID, "review-1")).toMatchObject({
      status: "draft",
      revision: 2,
      analysisRunId: null,
      report: null,
      images: [{ originalName: "new.jpg" }],
    });
  });

  it("第二次分析使第一次失效，只有第二次结果可落库", async () => {
    const first = deferred<AiReviewEnvelope>();
    const second = deferred<AiReviewEnvelope>();
    const analyze = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const service = serviceFor(analyze);

    const firstPending = service.analyze(OWNER_ID, "review-1");
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    const secondPending = service.analyze(OWNER_ID, "review-1");
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));
    first.resolve(readyEnvelope);

    await expect(firstPending).rejects.toMatchObject({ code: "ANALYSIS_CONFLICT" });
    expect(repository.getById(OWNER_ID, "review-1")).toMatchObject({
      status: "analyzing",
      analysisRunId: "run-2",
    });
    second.resolve(readyEnvelope);
    await expect(secondPending).resolves.toMatchObject({
      review: { status: "ready_for_review", analysisRunId: null },
    });
  });

  it("教师修改内容时将旧 PDF 加入 best-effort 清理队列", async () => {
    const service = serviceFor(async () => readyEnvelope);
    const ready = repository.updateReport(OWNER_ID, "review-1", readyEnvelope.report);
    const exported = repository.markExported(OWNER_ID, "review-1", ready.revision, {
      pdfFilename: "old.pdf",
      pdfPath: "pdf/old.pdf",
      exportedAt: new Date("2026-07-21T06:00:00.000Z"),
    });
    const cleanup = vi.spyOn(fileStore, "queuePdfCleanup");

    const saved = await service.update(OWNER_ID, "review-1", {
      expectedRevision: exported.revision,
      report: { ...readyEnvelope.report, personalizedComment: "教师新总评" },
    });

    expect(saved).toMatchObject({
      status: "ready_for_review",
      pdfFilename: null,
    });
    expect(cleanup).toHaveBeenCalledWith(OWNER_ID, "review-1", ["old.pdf"]);
    await cleanup.mock.results[0]?.value;
  });

  it("教师审核在作文锁内保存并清理旧 PDF，随后移出待审核队列", async () => {
    const service = serviceFor(async () => readyEnvelope);
    const ready = repository.updateReport(OWNER_ID, "review-1", readyEnvelope.report);
    const exported = repository.markExported(OWNER_ID, "review-1", ready.revision, {
      pdfFilename: "old-review.pdf",
      pdfPath: "pdf/old-review.pdf",
      exportedAt: new Date("2026-07-21T06:00:00.000Z"),
    });
    const cleanup = vi.spyOn(fileStore, "queuePdfCleanup");

    expect(service.listTeacherReviewQueue(OWNER_ID).map(({ id }) => id)).toEqual(["review-1"]);
    const saved = await service.completeTeacherReview(OWNER_ID, "review-1", {
      expectedRevision: exported.revision,
      studentName: "张小明",
      report: readyEnvelope.report,
      annotations: [],
    });

    expect(saved).toMatchObject({
      studentName: "张小明",
      teacherReviewedAt: expect.any(Date),
      pdfFilename: null,
    });
    expect(service.listTeacherReviewQueue(OWNER_ID)).toEqual([]);
    expect(cleanup).toHaveBeenCalledWith(OWNER_ID, "review-1", ["old-review.pdf"]);
  });

  it("缓存 PDF 读取期间教师编辑等待同一把锁，读取结束后缓存失效", async () => {
    const lock = new InMemoryReviewLock();
    const service = new ReviewService(
      repository,
      fileStore,
      { analyze: async () => readyEnvelope },
      { lock },
    );
    const ready = repository.updateReport(OWNER_ID, "review-1", readyEnvelope.report);
    const reviewed = repository.completeTeacherReview(OWNER_ID, "review-1", {
      expectedRevision: ready.revision,
      report: readyEnvelope.report,
    });
    const exported = repository.markExported(OWNER_ID, "review-1", reviewed.revision, {
      pdfFilename: "作文批改-为自己喝彩-未填写.pdf",
      pdfPath: "pdf/作文批改-为自己喝彩-未填写.pdf",
      exportedAt: new Date("2026-08-08T07:00:00.000Z"),
    });
    const cachedRead = deferred<Buffer>();
    const originalRead = fileStore.readFile.bind(fileStore);
    vi.spyOn(fileStore, "readFile").mockImplementation(
      (ownerId, id, kind, filename) =>
        kind === "pdf" && filename === "作文批改-为自己喝彩-未填写.pdf"
          ? cachedRead.promise
          : originalRead(ownerId, id, kind, filename),
    );
    const browserFactory = { launch: vi.fn() };
    const pdfService = new PdfService(
      repository,
      fileStore,
      browserFactory as never,
      { lock },
    );

    const downloading = pdfService.getOrCreate(OWNER_ID, "review-1");
    await vi.waitFor(() => expect(fileStore.readFile).toHaveBeenCalledWith(
      OWNER_ID,
      "review-1",
      "pdf",
      "作文批改-为自己喝彩-未填写.pdf",
    ));
    let editSettled = false;
    const editing = service.update(OWNER_ID, "review-1", {
      expectedRevision: exported.revision,
      report: {
        ...readyEnvelope.report,
        personalizedComment: "缓存读取后的教师修改",
      },
    }).then((value) => {
      editSettled = true;
      return value;
    });
    await Promise.resolve();

    expect(editSettled).toBe(false);
    expect(repository.getById(OWNER_ID, "review-1")).toMatchObject({
      status: "exported",
      pdfFilename: "作文批改-为自己喝彩-未填写.pdf",
    });
    cachedRead.resolve(Buffer.from("cached"));
    await expect(downloading).resolves.toMatchObject({ cached: true });
    await expect(editing).resolves.toMatchObject({
      status: "ready_for_review",
      pdfFilename: null,
    });
    expect(browserFactory.launch).not.toHaveBeenCalled();
  });

  it("分析中拒绝导出且不改变 revision，AI 结果仍可提交", async () => {
    const lock = new InMemoryReviewLock();
    const ai = deferred<AiReviewEnvelope>();
    const analyze = vi.fn(() => ai.promise);
    const service = new ReviewService(repository, fileStore, { analyze }, { lock });
    const browserFactory = { launch: vi.fn() };
    const pdfService = new PdfService(
      repository,
      fileStore,
      browserFactory as never,
      { lock },
    );

    const pendingAnalysis = service.analyze(OWNER_ID, "review-1");
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    const analyzingRevision = repository.getById(OWNER_ID, "review-1")!.revision;

    await expect(
      pdfService.getOrCreate(OWNER_ID, "review-1"),
    ).rejects.toMatchObject({
      code: "PDF_ANALYSIS_IN_PROGRESS",
      status: 409,
    });
    expect(repository.getById(OWNER_ID, "review-1")).toMatchObject({
      status: "analyzing",
      revision: analyzingRevision,
    });
    expect(browserFactory.launch).not.toHaveBeenCalled();

    ai.resolve(readyEnvelope);
    await expect(pendingAnalysis).resolves.toMatchObject({
      review: { status: "ready_for_review", report: readyEnvelope.report },
    });
  });

  it("DELETE 的数据库步骤失败时恢复已暂存的 review 目录", async () => {
    const service = serviceFor(async () => readyEnvelope);
    vi.spyOn(repository, "delete").mockImplementation(() => {
      throw new Error("database delete failed");
    });

    await expect(service.delete(OWNER_ID, "review-1")).rejects.toThrow(
      "database delete failed",
    );

    expect(repository.getById(OWNER_ID, "review-1")).not.toBeNull();
    await expect(
      fileStore.readFile(OWNER_ID, "review-1", "images", "page-ai.jpg"),
    ).resolves.toEqual(Buffer.from("ai"));
  });

  it("首次异步操作等待启动恢复后再读取仍存在于 DB 的 review 文件", async () => {
    await fileStore.stageDelete(OWNER_ID, "review-1");
    const analyze = vi.fn(async () => readyEnvelope);
    const service = serviceFor(analyze);

    await expect(service.analyze(OWNER_ID, "review-1")).resolves.toMatchObject({
      review: { status: "ready_for_review" },
    });

    expect(analyze).toHaveBeenCalledOnce();
  });

  it("DB 删除成功后 trash 清理失败仍返回成功并留给下一次启动恢复", async () => {
    const stageDelete = fileStore.stageDelete.bind(fileStore);
    vi.spyOn(fileStore, "stageDelete").mockImplementation(async (ownerId, reviewId) => {
      const staged = await stageDelete(ownerId, reviewId);
      return {
        rollback: staged.rollback,
        commit: async () => {
          throw new Error("trash cleanup failed");
        },
      };
    });
    const service = serviceFor(async () => readyEnvelope);

    await expect(service.delete(OWNER_ID, "review-1")).resolves.toBeUndefined();

    expect(repository.getById(OWNER_ID, "review-1")).toBeNull();
    await expect(
      readdir(path.join(fileStore.rootDirectory, ".trash")),
    ).resolves.toHaveLength(1);

    const restarted = serviceFor(async () => readyEnvelope);
    await restarted.create(OWNER_ID, config);
    await expect(
      readdir(path.join(fileStore.rootDirectory, ".trash")),
    ).resolves.toEqual([]);
  });
});
