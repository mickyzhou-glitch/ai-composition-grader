// @vitest-environment node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openAppDatabase } from "../db/client";
import { ReviewRepository } from "../db/review-repository";
import { AnalysisJobRepository } from "../jobs/analysis-job-repository";
import { AnalysisWorker } from "../jobs/analysis-worker";
import {
  encodeReanalysisReadyMarker,
  parseAnalysisJobMetadata,
} from "../jobs/analysis-job-metadata";
import { ReviewService } from "../services/review-service";
import { ReviewFileStore } from "../storage/review-file-store";
import { formatRevisionTeacherGuidance, REANALYSIS_SKIP_REASONS } from "./contracts";
import { ReanalysisDomainError, ReanalysisRepository } from "./reanalysis-repository";
import { ReanalysisService } from "./reanalysis-service";

const OWNER = "teacher-a";
const OTHER_OWNER = "teacher-b";
const NOW = new Date("2026-08-22T02:00:00.000Z");

const config = {
  title: "  My  Essay  ",
  grade: "上海五四学制六年级",
  writingRequirements: "写一件亲身经历。",
  targetCharacters: 600,
  structureRequirements: "五段展开。",
  scoringFocus: "细节描写。",
  templateType: "custom" as const,
};

const checkpoint = {
  version: 1 as const,
  sourceRevision: 2,
  ocrRevision: 4,
  editedAt: null,
  pages: [{
    pageIndex: 0,
    text: "作文原文",
    readable: true,
    warnings: [],
    blocks: [],
  }],
};

const paragraphCheckpoint = {
  version: 2 as const,
  sourceRevision: 2,
  ocrRevision: 5,
  editedAt: null,
  pages: [{
    pageIndex: 0,
    text: "作文原文",
    readable: true,
    warnings: [],
    blocks: [{ text: "作文原文", x: 0.1, y: 0.1, width: 0.3, height: 0.1 }],
  }],
  paragraphs: [{
    id: "paragraph-1",
    paragraphIndex: 0,
    text: "作文原文",
    segments: [{ pageIndex: 0, text: "作文原文", x: 0.1, y: 0.1, width: 0.3, height: 0.1 }],
  }],
};

const report = {
  themeFit: "fits" as const,
  themeReason: "紧扣主题。",
  personalizedComment: "细节真实。",
  painPoints: ["结尾略快"],
  commonIssues: ["长句较多"],
  revisionSuggestions: ["补充感受"],
  grade: "A-" as const,
  diagnostics: {
    authenticityAndRelevance: { finding: "主题真实。", action: "保留亲身经历。" },
    materialAndDetails: { finding: "动作可展开。", action: "补写动作和心理。" },
    structure: { finding: "结构完整。", action: "加强转折承接。" },
    language: { finding: "表达自然。", action: "精简长句。" },
  },
  sampleParagraphs: Array.from({ length: 5 }, (_, index) => ({
    title: `示例${index + 1}`,
    text: "我为自己鼓掌。",
    suggestion: "补充细节。",
  })),
  parentFeedbacks: [],
};

const paragraphReport = {
  version: 2 as const,
  themeFit: "fits" as const,
  themeReason: "紧扣主题。",
  personalizedComment: "细节真实。",
  painPoints: ["结尾略快。"],
  commonIssues: [],
  revisionSuggestions: [],
  grade: "A-" as const,
  diagnostics: report.diagnostics,
  paragraphReviews: [{
    paragraphId: "paragraph-1",
    suggestions: [{ problem: "保留", advice: "保留原句。", example: "作文原文" }],
    revisedText: "作文原文",
  }],
  parentFeedbacks: [],
};

describe("ReanalysisRepository requestRevision", () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let opened: ReturnType<typeof openAppDatabase>;
  let repository: ReanalysisRepository;
  let service: ReanalysisService;
  let reviewRepository: ReviewRepository;
  let nextId: number;

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "grader-reanalysis-"));
    databasePath = path.join(temporaryDirectory, "app.db");
    opened = openAppDatabase(databasePath);
    for (const ownerId of [OWNER, OTHER_OWNER]) {
      opened.sqlite.prepare(`
        INSERT INTO users (
          id, username, password_hash, role, must_change_password, created_at, updated_at
        ) VALUES (?, ?, '!test', 'teacher', 0, ?, ?)
      `).run(ownerId, ownerId, NOW.valueOf(), NOW.valueOf());
    }
    nextId = 0;
    repository = new ReanalysisRepository(opened.db, {
      now: () => NOW,
      createId: () => `reanalysis-job-${++nextId}`,
    });
    service = new ReanalysisService(repository);
    reviewRepository = new ReviewRepository(opened.db, { now: () => NOW });
    insertReview();
  });

  afterEach(() => {
    opened.close();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  function insertReview(overrides: Record<string, unknown> = {}): void {
    const values = {
      id: "review-1",
      ownerId: OWNER,
      status: "ready_for_review",
      studentName: "艾绮",
      config: JSON.stringify(config),
      revision: 3,
      imageRevision: 2,
      ocrCheckpoint: JSON.stringify(checkpoint),
      analysisRunId: null,
      pdfFilename: "old.pdf",
      pdfPath: "pdf/old.pdf",
      pdfRevision: 3,
      exportedAt: NOW.valueOf() - 1_000,
      teacherReviewedAt: NOW.valueOf() - 2_000,
      deletingAt: null,
      createdAt: NOW.valueOf() - 10_000,
      updatedAt: NOW.valueOf() - 5_000,
      ...overrides,
    };
    opened.sqlite.prepare(`
      INSERT INTO reviews (
        id, owner_id, status, student_name, config, revision, image_revision,
        ocr_checkpoint, analysis_run_id, pdf_filename, pdf_path, pdf_revision,
        exported_at, teacher_reviewed_at, deleting_at, created_at, updated_at
      ) VALUES (
        @id, @ownerId, @status, @studentName, @config, @revision, @imageRevision,
        @ocrCheckpoint, @analysisRunId, @pdfFilename, @pdfPath, @pdfRevision,
        @exportedAt, @teacherReviewedAt, @deletingAt, @createdAt, @updatedAt
      )
    `).run(values);
    opened.sqlite.prepare(`
      INSERT INTO review_images (
        review_id, page_index, path, position, original_name, mime_type,
        original_path, annotation_path, ai_path, width, height, rotation, created_at
      ) VALUES (?, 0, 'images/page.jpg', 0, 'page.jpg', 'image/jpeg',
        'images/original.jpg', 'images/annotation.jpg', 'images/ai.jpg', 100, 200, 0, ?)
    `).run(values.id, NOW.valueOf());
  }

  function revisionInput(expectedRevision = 3) {
    return {
      expectedRevision,
      reason: "人物关系混乱",
      changeRequest: "按原文称呼重排事件",
    };
  }

  function insertCurrentAssignment(): void {
    opened.sqlite.prepare(`
      INSERT INTO saved_assignments (id, owner_id, title, config, created_at, updated_at)
      VALUES ('assignment-current', ?, 'My  Essay', ?, ?, ?)
    `).run(
      OWNER,
      JSON.stringify({ ...config, title: "My  Essay", scoringFocus: "使用最新框架" }),
      NOW.valueOf() - 1_000,
      NOW.valueOf(),
    );
  }

  function commitItem(reviewId: string, expectedRevision = 3) {
    return {
      reviewId,
      expectedRevision,
      assignmentId: "assignment-current",
      expectedAssignmentUpdatedAt: NOW.toISOString(),
    };
  }

  function injectActiveJobAtInsert(reviewId: string): void {
    opened.sqlite.exec(`
      CREATE TRIGGER inject_active_job_at_insert
      BEFORE INSERT ON analysis_jobs
      WHEN NEW.review_id = '${reviewId}' AND NEW.id NOT LIKE 'trigger-active-%'
      BEGIN
        INSERT INTO analysis_jobs (
          id, review_id, owner_id, mode, status, attempt, available_at,
          progress_stage, created_at
        ) VALUES (
          'trigger-active-' || NEW.id, NEW.review_id, NEW.owner_id,
          'content_only', 'queued', 0, NEW.available_at, 'queued', NEW.created_at
        );
      END;
    `);
  }

  function injectConcurrentWriterDuringRead(): { close: () => void; wasBlocked: () => boolean } {
    const concurrent = new Database(databasePath);
    opened.sqlite.pragma("journal_mode = WAL");
    concurrent.pragma("journal_mode = WAL");
    concurrent.pragma("busy_timeout = 0");
    let blocked = false;
    opened.sqlite.function("attempt_concurrent_write", () => {
      try {
        concurrent.prepare("UPDATE users SET updated_at = updated_at + 1 WHERE id = ?").run(OTHER_OWNER);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") {
          blocked = true;
          return 0;
        }
        throw error;
      }
      return 1;
    });
    opened.sqlite.exec(`
      ALTER TABLE review_images RENAME TO review_images_backing;
      CREATE VIEW review_images AS
      SELECT
        CASE attempt_concurrent_write() WHEN -1 THEN NULL ELSE id END AS id,
        review_id, page_index, path, position, original_name, mime_type,
        original_path, annotation_path, ai_path, width, height, rotation, created_at
      FROM review_images_backing;
    `);
    return {
      close: () => concurrent.close(),
      wasBlocked: () => blocked,
    };
  }

  it("旧报告与 OCR v1 在同一事务中入队 full 升级任务", () => {
    opened.sqlite.prepare("UPDATE reviews SET report = ? WHERE id = 'review-1'")
      .run(JSON.stringify(report));
    opened.sqlite.prepare(`
      INSERT INTO annotations (
        review_id, position, page_index, x, y, category, anchor_text, comment, is_highlight
      ) VALUES ('review-1', 0, 0, 0.2, 0.3, 'sentence', '原句', '保留的旧批注', 0)
    `).run();

    const result = service.requestRevision(OWNER, "review-1", revisionInput());

    expect(result).toEqual({
      newlyQueued: true,
      job: {
        id: "reanalysis-job-1",
        reviewId: "review-1",
        mode: "full",
        status: "queued",
        progressStage: "queued",
        message: null,
        createdAt: NOW.toISOString(),
        finishedAt: null,
      },
    });
    expect(result.job).not.toHaveProperty("attempt");
    expect(result.job).not.toHaveProperty("teacherGuidance");
    const storedJob = opened.sqlite.prepare(
      "SELECT message FROM analysis_jobs WHERE id = ?",
    ).get(result.job.id) as { message: string | null };
    expect(parseAnalysisJobMetadata(storedJob.message)).toEqual({
      kind: "reanalysis",
      prebound: true,
      pdfCleanup: { filename: "old.pdf" },
    });
    expect(result.job.message).toBeNull();
    expect(reviewRepository.getById(OWNER, "review-1")).toMatchObject({
      status: "analyzing",
      revision: 3,
      analysisRunId: result.job.id,
      teacherReviewedAt: null,
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
      report,
      annotations: [{
        category: "sentence",
        anchorText: "原句",
        comment: "保留的旧批注",
      }],
    });
    expect(opened.sqlite.prepare(`
      SELECT image_revision AS imageRevision, ocr_checkpoint AS ocrCheckpoint
      FROM reviews WHERE id = ?
    `).get("review-1")).toEqual({
      imageRevision: 2,
      ocrCheckpoint: JSON.stringify(checkpoint),
    });
    expect(opened.sqlite.prepare(`
      SELECT mode, status, teacher_guidance AS teacherGuidance
      FROM analysis_jobs WHERE id = ?
    `).get(result.job.id)).toEqual({
      mode: "full",
      status: "queued",
      teacherGuidance: formatRevisionTeacherGuidance(
        revisionInput().reason,
        revisionInput().changeRequest,
      ),
    });
  });

  it("逐段报告与当前 OCR v2 退回时仍排 content_only", () => {
    opened.sqlite.prepare("UPDATE reviews SET ocr_checkpoint = ?, report = ? WHERE id = ?")
      .run(JSON.stringify(paragraphCheckpoint), JSON.stringify(paragraphReport), "review-1");

    const result = service.requestRevision(OWNER, "review-1", revisionInput());

    expect(result.job).toMatchObject({ mode: "content_only", status: "queued" });
    expect(opened.sqlite.prepare("SELECT mode FROM analysis_jobs WHERE id = ?")
      .get(result.job.id)).toEqual({ mode: "content_only" });
  });

  it("PDF cleanup marker 被 CAS 确认前任务不可领取，确认后才进入分析", () => {
    const queued = service.requestRevision(OWNER, "review-1", revisionInput());
    const jobs = new AnalysisJobRepository(opened.db, { now: () => NOW, leaseMs: 60_000 });
    const pending = jobs.findPendingPdfCleanup();

    expect(pending).toMatchObject({
      jobId: queued.job.id,
      ownerId: OWNER,
      reviewId: "review-1",
      filename: "old.pdf",
    });
    expect(jobs.claimNext()).toBeNull();
    expect(jobs.ackPdfCleanup(queued.job.id, `${pending!.marker}-stale`)).toBe(false);
    expect(jobs.claimNext()).toBeNull();
    expect(jobs.ackPdfCleanup(queued.job.id, pending!.marker)).toBe(true);
    expect(jobs.getById(OWNER, queued.job.id)).toMatchObject({
      message: encodeReanalysisReadyMarker(),
      prebound: true,
    });
    expect(jobs.claimNext()).toMatchObject({
      id: queued.job.id,
      status: "running",
      attempt: 1,
      message: encodeReanalysisReadyMarker(),
      prebound: true,
    });
  });

  it("无旧 PDF 的 reanalysis job 同事务写 ready marker 并可按 prebound 领取", () => {
    opened.sqlite.prepare(`
      UPDATE reviews
      SET pdf_filename = NULL, pdf_path = NULL, pdf_revision = NULL, exported_at = NULL
      WHERE id = 'review-1'
    `).run();

    const queued = service.requestRevision(OWNER, "review-1", revisionInput());
    const jobs = new AnalysisJobRepository(opened.db, { now: () => NOW, leaseMs: 60_000 });

    expect(jobs.findPendingPdfCleanup()).toBeNull();
    expect(jobs.getById(OWNER, queued.job.id)).toMatchObject({
      message: encodeReanalysisReadyMarker(),
      prebound: true,
    });
    expect(jobs.claimNext()).toMatchObject({
      id: queued.job.id,
      message: encodeReanalysisReadyMarker(),
      prebound: true,
    });
  });

  it("Worker 重启后先 durable 清理旧 PDF 并确认 marker，再领取任务", async () => {
    const storageRoot = path.join(temporaryDirectory, "users");
    const initialStore = new ReviewFileStore(storageRoot);
    await initialStore.writeFile(OWNER, "review-1", "pdf", "old.pdf", "old-pdf");
    const queued = service.requestRevision(OWNER, "review-1", revisionInput());

    const jobs = new AnalysisJobRepository(opened.db, { now: () => NOW, leaseMs: 60_000 });
    const restartedStore = new ReviewFileStore(storageRoot);
    const prepare = vi.fn(async () => ({
      token: { revision: 3, runId: queued.job.id },
      config,
      imageDataUrls: ["data:image/jpeg;base64,QQ=="],
    }));
    const analyze = vi.fn(async () => ({
      readable: true as const,
      pageWarnings: [],
      report,
      annotations: [],
    }));
    const worker = new AnalysisWorker(jobs, {
      cleanupPdf: (ownerId, reviewId, filename) =>
        restartedStore.queuePdfCleanupDurably(ownerId, reviewId, [filename]),
      prepare,
      analyze,
      save: async (_ownerId, _reviewId, _token, _envelope, claim) => {
        jobs.transition(claim, "succeeded");
      },
      fail: async () => { throw new Error("unreachable"); },
    });

    await expect(worker.runOnce()).resolves.toEqual({ jobId: queued.job.id, outcome: "succeeded" });
    await expect(restartedStore.readFile(OWNER, "review-1", "pdf", "old.pdf"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(jobs.findPendingPdfCleanup()).toBeNull();
    expect(jobs.getById(OWNER, queued.job.id)).toMatchObject({ status: "succeeded", attempt: 1 });
    expect(prepare).toHaveBeenCalledWith(
      OWNER,
      "review-1",
      "full",
      expect.objectContaining({ id: queued.job.id, attempt: 1 }),
      true,
    );
    expect(analyze).toHaveBeenCalledOnce();
  });

  it("每次运行只确认一个 pending marker，并在同轮继续领取已就绪任务", async () => {
    insertReview({
      id: "review-2",
      studentName: "陈新",
      pdfFilename: "second.pdf",
      pdfPath: "pdf/second.pdf",
    });
    const first = service.requestRevision(OWNER, "review-1", revisionInput());
    const second = service.requestRevision(OWNER, "review-2", revisionInput());
    const jobs = new AnalysisJobRepository(opened.db, { now: () => NOW, leaseMs: 60_000 });
    const cleanupPdf = vi.fn(async () => undefined);
    const worker = new AnalysisWorker(jobs, {
      cleanupPdf,
      prepare: async (_ownerId, _reviewId, _mode, claim, prebound) => {
        expect(prebound).toBe(true);
        return { token: { revision: 3, runId: claim.id }, config, imageDataUrls: [] };
      },
      analyze: async () => ({
        readable: true,
        pageWarnings: [],
        report,
        annotations: [],
      }),
      save: async (_ownerId, _reviewId, _token, _envelope, claim) => {
        jobs.transition(claim, "succeeded");
      },
      fail: async () => { throw new Error("unreachable"); },
    });

    await expect(worker.runOnce()).resolves.toEqual({ jobId: first.job.id, outcome: "succeeded" });
    expect(cleanupPdf).toHaveBeenCalledTimes(1);
    expect(jobs.findPendingPdfCleanup()).toMatchObject({
      jobId: second.job.id,
      filename: "second.pdf",
    });

    await expect(worker.runOnce()).resolves.toEqual({ jobId: second.job.id, outcome: "succeeded" });
    expect(cleanupPdf).toHaveBeenCalledTimes(2);
    expect(jobs.findPendingPdfCleanup()).toBeNull();
  });

  it("durable cleanup 持久化失败时保留 marker 且不领取或调用 AI", async () => {
    const queued = service.requestRevision(OWNER, "review-1", revisionInput());
    const jobs = new AnalysisJobRepository(opened.db, { now: () => NOW, leaseMs: 60_000 });
    const blockedRoot = path.join(temporaryDirectory, "blocked-storage-root");
    writeFileSync(blockedRoot, "not-a-directory");
    const blockedStore = new ReviewFileStore(blockedRoot);
    const cleanupPdf = vi.fn((ownerId: string, reviewId: string, filename: string) =>
      blockedStore.queuePdfCleanupDurably(ownerId, reviewId, [filename]));
    const prepare = vi.fn(async () => { throw new Error("prepare must not run"); });
    const analyze = vi.fn(async () => { throw new Error("AI must not run"); });
    const worker = new AnalysisWorker(jobs, {
      cleanupPdf,
      prepare,
      analyze,
      save: async () => { throw new Error("save must not run"); },
      fail: async () => { throw new Error("fail must not run"); },
    });

    await expect(worker.runOnce()).resolves.toBeNull();
    expect(cleanupPdf).toHaveBeenCalledOnce();
    expect(prepare).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
    expect(jobs.getById(OWNER, queued.job.id)).toMatchObject({ status: "queued", attempt: 0 });
    expect(jobs.findPendingPdfCleanup()).toMatchObject({ jobId: queued.job.id, filename: "old.pdf" });
  });

  it("版本冲突返回稳定业务错误并回滚全部写入", () => {
    const before = opened.sqlite.prepare("SELECT * FROM reviews WHERE id = ?").get("review-1");

    expect(() => service.requestRevision(OWNER, "review-1", revisionInput(2))).toThrow(
      expect.objectContaining({ code: "REVISION_CONFLICT", status: 409 }),
    );

    expect(opened.sqlite.prepare("SELECT * FROM reviews WHERE id = ?").get("review-1")).toEqual(before);
    expect(opened.sqlite.prepare("SELECT count(*) AS count FROM analysis_jobs").get()).toEqual({ count: 0 });
  });

  it.each([
    ["other owner", OTHER_OWNER],
    ["missing review", OWNER, "missing-review"],
  ])("对%s只返回安全 REVIEW_NOT_FOUND", (_case, ownerId, reviewId = "review-1") => {
    expect(() => service.requestRevision(ownerId, reviewId, revisionInput())).toThrow(
      expect.objectContaining({ code: "REVIEW_NOT_FOUND", status: 404 }),
    );
    expect(opened.sqlite.prepare("SELECT count(*) AS count FROM analysis_jobs").get()).toEqual({ count: 0 });
  });

  it.each([
    ["missing checkpoint", null, 2],
    ["stale checkpoint", JSON.stringify(checkpoint), 3],
  ])("%s 时返回 OCR_NOT_CURRENT 且不留半状态", (_case, ocrCheckpoint, imageRevision) => {
    opened.sqlite.prepare(`
      UPDATE reviews SET ocr_checkpoint = ?, image_revision = ? WHERE id = 'review-1'
    `).run(ocrCheckpoint, imageRevision);

    expect(() => service.requestRevision(OWNER, "review-1", revisionInput())).toThrow(
      expect.objectContaining({ code: "OCR_NOT_CURRENT", status: 409 }),
    );
    expect(reviewRepository.getById(OWNER, "review-1")).toMatchObject({
      status: "ready_for_review",
      analysisRunId: null,
      pdfFilename: "old.pdf",
    });
    expect(opened.sqlite.prepare("SELECT count(*) AS count FROM analysis_jobs").get()).toEqual({ count: 0 });
  });

  it("有活动任务时返回 ANALYSIS_ACTIVE 且不覆盖原任务", () => {
    opened.sqlite.prepare(`
      INSERT INTO analysis_jobs (
        id, review_id, owner_id, mode, status, attempt, available_at,
        progress_stage, created_at
      ) VALUES ('active-job', 'review-1', ?, 'content_only', 'queued', 0, ?, 'queued', ?)
    `).run(OWNER, NOW.valueOf(), NOW.valueOf());

    expect(() => service.requestRevision(OWNER, "review-1", revisionInput())).toThrow(
      expect.objectContaining({ code: "ANALYSIS_ACTIVE", status: 409 }),
    );
    expect(reviewRepository.getById(OWNER, "review-1")).toMatchObject({
      status: "ready_for_review",
      analysisRunId: null,
    });
    expect(opened.sqlite.prepare("SELECT count(*) AS count FROM analysis_jobs").get()).toEqual({ count: 1 });
  });

  it("活动任务在查询后竞态插入时映射 ANALYSIS_ACTIVE 并回滚", () => {
    const before = opened.sqlite.prepare("SELECT * FROM reviews WHERE id = 'review-1'").get();
    injectActiveJobAtInsert("review-1");

    expect(() => service.requestRevision(OWNER, "review-1", revisionInput())).toThrow(
      expect.objectContaining({ code: "ANALYSIS_ACTIVE", status: 409 }),
    );
    expect(opened.sqlite.prepare("SELECT * FROM reviews WHERE id = 'review-1'").get()).toEqual(before);
    expect(opened.sqlite.prepare("SELECT count(*) AS count FROM analysis_jobs").get()).toEqual({ count: 0 });
  });

  it("requestRevision 在读后并发写入时先取得写锁，避免 SQLITE_BUSY_SNAPSHOT", () => {
    const concurrent = injectConcurrentWriterDuringRead();
    try {
      expect(service.requestRevision(OWNER, "review-1", revisionInput())).toMatchObject({
        newlyQueued: true,
        job: { id: "reanalysis-job-1" },
      });
      expect(concurrent.wasBlocked()).toBe(true);
    } finally {
      concurrent.close();
    }
  });

  it("requestRevision 遇到已占用写锁时返回稳定的 REVISION_CONFLICT", () => {
    const concurrent = new Database(databasePath);
    opened.sqlite.pragma("journal_mode = WAL");
    concurrent.pragma("journal_mode = WAL");
    opened.sqlite.pragma("busy_timeout = 0");
    concurrent.exec("BEGIN IMMEDIATE");
    try {
      expect(() => service.requestRevision(OWNER, "review-1", revisionInput())).toThrow(
        expect.objectContaining({ code: "REVISION_CONFLICT", status: 409 }),
      );
    } finally {
      concurrent.exec("ROLLBACK");
      concurrent.close();
    }
  });

  it("job 主键冲突仍抛原始 SQLite 错误而不映射 ANALYSIS_ACTIVE", () => {
    const before = opened.sqlite.prepare("SELECT * FROM reviews WHERE id = 'review-1'").get();
    opened.sqlite.prepare(`
      INSERT INTO analysis_jobs (
        id, review_id, owner_id, mode, status, attempt, available_at,
        progress_stage, created_at, finished_at
      ) VALUES ('reanalysis-job-1', 'review-1', ?, 'content_only', 'succeeded', 1, ?, 'saving_result', ?, ?)
    `).run(OWNER, NOW.valueOf(), NOW.valueOf() - 1_000, NOW.valueOf());

    let thrown: unknown;
    try {
      service.requestRevision(OWNER, "review-1", revisionInput());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(ReanalysisDomainError);
    expect(thrown).toMatchObject({ code: "SQLITE_CONSTRAINT_PRIMARYKEY" });
    expect(opened.sqlite.prepare("SELECT * FROM reviews WHERE id = 'review-1'").get()).toEqual(before);
    expect(opened.sqlite.prepare("SELECT count(*) AS count FROM analysis_jobs").get()).toEqual({ count: 1 });
  });

  it("队列等待期教师编辑使旧 job 取消且不复活或覆盖编辑", async () => {
    const queued = service.requestRevision(OWNER, "review-1", revisionInput());
    const teacherReport = { ...report, personalizedComment: "教师等待期的新编辑" };
    const teacherAnnotation = {
      pageIndex: 0,
      x: 0.25,
      y: 0.35,
      category: "sentence" as const,
      anchorText: "教师新批注句",
      comment: "这是教师新批注",
      isHighlight: false,
    };
    reviewRepository.updateTeacherEdits(OWNER, "review-1", {
      expectedRevision: 3,
      report: teacherReport,
      annotations: [teacherAnnotation],
    });
    const jobs = new AnalysisJobRepository(opened.db, {
      now: () => NOW,
      leaseMs: 60_000,
    });
    const reviewService = new ReviewService(
      reviewRepository,
      new ReviewFileStore(path.join(temporaryDirectory, "users")),
      { analyze: async () => { throw new Error("AI must not run"); } },
    );
    const analyze = vi.fn(async () => { throw new Error("AI must not run"); });
    const worker = new AnalysisWorker(jobs, {
      cleanupPdf: async () => undefined,
      prepare: (ownerId, reviewId, mode, claim, prebound) =>
        prebound
          ? reviewService.prepareQueuedAnalysis(ownerId, reviewId, mode, claim)
          : reviewService.prepareAnalysis(ownerId, reviewId, mode, claim),
      analyze,
      save: async () => { throw new Error("save must not run"); },
      fail: async () => { throw new Error("fail must not run for stale job"); },
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      jobId: queued.job.id,
      outcome: "canceled",
      errorCode: "ANALYSIS_CONFLICT",
    });
    expect(analyze).not.toHaveBeenCalled();
    expect(jobs.getById(OWNER, queued.job.id)).toMatchObject({ status: "canceled" });
    expect(reviewRepository.getById(OWNER, "review-1")).toMatchObject({
      status: "ready_for_review",
      revision: 4,
      analysisRunId: null,
      report: teacherReport,
      annotations: [teacherAnnotation],
    });
  });

  it("reanalysis retry 保持 ready marker，并继续按 prebound 路径成功", async () => {
    opened.sqlite.prepare(`
      UPDATE reviews
      SET pdf_filename = NULL, pdf_path = NULL, pdf_revision = NULL, exported_at = NULL
      WHERE id = 'review-1'
    `).run();
    const queued = service.requestRevision(OWNER, "review-1", revisionInput());
    const jobs = new AnalysisJobRepository(opened.db, {
      now: () => NOW,
      leaseMs: 60_000,
    });
    const analyze = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("temporary"), { code: "AI_REQUEST_FAILED" }))
      .mockResolvedValueOnce({
        readable: true,
        pageWarnings: [],
        report,
        annotations: [],
      });
    const reviewService = new ReviewService(
      reviewRepository,
      new ReviewFileStore(path.join(temporaryDirectory, "users")),
      { analyze },
    );
    await new ReviewFileStore(path.join(temporaryDirectory, "users"))
      .writeFile(OWNER, "review-1", "images", "ai.jpg", "image");
    const worker = new AnalysisWorker(jobs, {
      prepare: (ownerId, reviewId, mode, claim, prebound) => {
        expect(prebound).toBe(true);
        return reviewService.prepareQueuedAnalysis(ownerId, reviewId, mode, claim);
      },
      analyze: (input) => reviewService.analyzePrepared(input),
      save: (ownerId, reviewId, token, envelope, claim) =>
        reviewService.savePreparedAnalysisAndCompleteJob(ownerId, reviewId, token, envelope, claim),
      fail: (ownerId, reviewId, token, claim, errorCode) =>
        reviewService.failPreparedAnalysisAndFailJob(ownerId, reviewId, token, claim, errorCode),
      finishUnprepared: (ownerId, reviewId, runId, claim, target, errorCode) =>
        reviewService.finishQueuedAnalysisBeforeToken(
          ownerId,
          reviewId,
          runId,
          claim,
          target,
          errorCode,
        ),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      jobId: queued.job.id,
      outcome: "retrying",
      errorCode: "AI_REQUEST_FAILED",
    });
    expect(jobs.getById(OWNER, queued.job.id)).toMatchObject({
      status: "queued",
      message: encodeReanalysisReadyMarker(),
      prebound: true,
    });

    await expect(worker.runOnce()).resolves.toEqual({
      jobId: queued.job.id,
      outcome: "succeeded",
    });
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(jobs.getById(OWNER, queued.job.id)).toMatchObject({
      status: "succeeded",
      message: null,
      prebound: false,
    });
  });

  it("reanalysis 的旧 claim 在租约重领后不能刷新 prebound review", async () => {
    opened.sqlite.prepare(`
      UPDATE reviews
      SET pdf_filename = NULL, pdf_path = NULL, pdf_revision = NULL, exported_at = NULL
      WHERE id = 'review-1'
    `).run();
    const queued = service.requestRevision(OWNER, "review-1", revisionInput());
    let now = NOW;
    const jobs = new AnalysisJobRepository(opened.db, {
      now: () => now,
      leaseMs: 1_000,
      maxAttempts: 3,
    });
    const firstClaim = jobs.claimNext()!;
    now = new Date(now.valueOf() + 1_001);
    const secondClaim = jobs.claimNext()!;
    const claimedReviewRepository = new ReviewRepository(opened.db, { now: () => now });
    const reviewService = new ReviewService(
      claimedReviewRepository,
      new ReviewFileStore(path.join(temporaryDirectory, "users")),
      { analyze: async () => { throw new Error("AI must not run during prepare"); } },
    );
    await new ReviewFileStore(path.join(temporaryDirectory, "users"))
      .writeFile(OWNER, "review-1", "images", "ai.jpg", "image");
    const before = opened.sqlite.prepare(
      "SELECT status, revision, analysis_run_id AS analysisRunId, updated_at AS updatedAt FROM reviews WHERE id = ?",
    ).get("review-1");

    await expect(reviewService.prepareQueuedAnalysis(
      OWNER,
      "review-1",
      "full",
      firstClaim,
    )).rejects.toMatchObject({ code: "JOB_CLAIM_LOST" });
    expect(opened.sqlite.prepare(
      "SELECT status, revision, analysis_run_id AS analysisRunId, updated_at AS updatedAt FROM reviews WHERE id = ?",
    ).get("review-1")).toEqual(before);

    await expect(reviewService.prepareQueuedAnalysis(
      OWNER,
      "review-1",
      "full",
      secondClaim,
    )).resolves.toMatchObject({
      token: { runId: queued.job.id, revision: 3 },
    });
  });

  it("prepare 取得 token 前失败时原子终结 job 并仅释放它绑定的 review", async () => {
    const queued = service.requestRevision(OWNER, "review-1", revisionInput());
    const jobs = new AnalysisJobRepository(opened.db, {
      now: () => NOW,
      leaseMs: 60_000,
    });
    const fileStore = new ReviewFileStore(path.join(temporaryDirectory, "users"));
    vi.spyOn(fileStore, "migrateLegacyReview").mockRejectedValue(new Error("migration failed"));
    const reviewService = new ReviewService(
      reviewRepository,
      fileStore,
      { analyze: async () => { throw new Error("AI must not run"); } },
    );
    const worker = new AnalysisWorker(jobs, {
      cleanupPdf: async () => undefined,
      prepare: (ownerId, reviewId, mode, claim, prebound) =>
        prebound
          ? reviewService.prepareQueuedAnalysis(ownerId, reviewId, mode, claim)
          : reviewService.prepareAnalysis(ownerId, reviewId, mode, claim),
      analyze: async () => { throw new Error("AI must not run"); },
      save: async () => { throw new Error("save must not run"); },
      fail: async () => { throw new Error("token failure path must not run"); },
      finishUnprepared: (ownerId, reviewId, runId, claim, target, errorCode) =>
        reviewService.finishQueuedAnalysisBeforeToken(
          ownerId,
          reviewId,
          runId,
          claim,
          target,
          errorCode,
        ),
    });

    await expect(worker.runOnce()).resolves.toMatchObject({
      jobId: queued.job.id,
      outcome: "failed",
      errorCode: "ANALYSIS_FAILED",
    });
    expect(jobs.getById(OWNER, queued.job.id)).toMatchObject({
      status: "failed",
      errorCode: "ANALYSIS_FAILED",
    });
    expect(reviewRepository.getById(OWNER, "review-1")).toMatchObject({
      status: "failed",
      revision: 3,
      analysisRunId: null,
    });
  });

  it("pre-token 补偿不清理已被教师编辑改变的 review", () => {
    const queued = service.requestRevision(OWNER, "review-1", revisionInput());
    const jobs = new AnalysisJobRepository(opened.db, {
      now: () => NOW,
      leaseMs: 60_000,
    });
    const pendingCleanup = jobs.findPendingPdfCleanup();
    if (pendingCleanup) jobs.ackPdfCleanup(pendingCleanup.jobId, pendingCleanup.marker);
    const claim = jobs.claimNext()!;
    const teacherReport = { ...report, personalizedComment: "补偿前的教师编辑" };
    reviewRepository.updateTeacherEdits(OWNER, "review-1", {
      expectedRevision: 3,
      report: teacherReport,
      annotations: [],
    });

    reviewRepository.finishQueuedAnalysisBeforeToken(
      OWNER,
      "review-1",
      queued.job.id,
      claim,
      "failed",
      "ANALYSIS_FAILED",
    );

    expect(jobs.getById(OWNER, queued.job.id)).toMatchObject({ status: "failed" });
    expect(reviewRepository.getById(OWNER, "review-1")).toMatchObject({
      status: "ready_for_review",
      revision: 4,
      analysisRunId: null,
      report: teacherReport,
      annotations: [],
    });
  });

  it("图片记录缺失时返回 REVIEW_UNAVAILABLE 且不入队", () => {
    opened.sqlite.prepare("DELETE FROM review_images WHERE review_id = 'review-1'").run();

    expect(() => service.requestRevision(OWNER, "review-1", revisionInput())).toThrow(
      expect.objectContaining({ code: "REVIEW_UNAVAILABLE", status: 409 }),
    );
    expect(opened.sqlite.prepare("SELECT count(*) AS count FROM analysis_jobs").get()).toEqual({ count: 0 });
    expect(reviewRepository.getById(OWNER, "review-1")).toMatchObject({
      status: "ready_for_review",
      analysisRunId: null,
      pdfFilename: "old.pdf",
    });
  });

  it.each([
    ["deleting", { deletingAt: NOW.valueOf() }],
    ["needs better images", { status: "needs_better_images" }],
  ])("%s 的作文不可用且不创建任务", (_case, updates) => {
    const assignments = Object.keys(updates).map((key) => `${key === "deletingAt" ? "deleting_at" : "status"} = @${key}`).join(", ");
    opened.sqlite.prepare(`UPDATE reviews SET ${assignments} WHERE id = 'review-1'`).run(updates);

    expect(() => service.requestRevision(OWNER, "review-1", revisionInput())).toThrow(
      expect.objectContaining({ code: "REVIEW_UNAVAILABLE", status: 409 }),
    );
    expect(opened.sqlite.prepare("SELECT count(*) AS count FROM analysis_jobs").get()).toEqual({ count: 0 });
  });

  it("批量读取时按输入顺序分组并严格校验 owner、OCR、状态与同名框架", () => {
    insertReview({
      id: "review-latest-tie",
      studentName: "陈新",
      revision: 7,
      config: JSON.stringify({ ...config, title: "My  Essay" }),
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
      teacherReviewedAt: null,
    });
    insertReview({
      id: "review-case-mismatch",
      config: JSON.stringify({ ...config, title: "my  essay" }),
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
      teacherReviewedAt: null,
    });
    insertReview({
      id: "review-stale-ocr",
      imageRevision: 3,
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
      teacherReviewedAt: null,
    });
    insertReview({
      id: "review-active",
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
      teacherReviewedAt: null,
    });
    insertReview({
      id: "review-deleting",
      deletingAt: NOW.valueOf(),
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
      teacherReviewedAt: null,
    });
    insertReview({
      id: "review-no-images",
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
      teacherReviewedAt: null,
    });
    opened.sqlite.prepare("DELETE FROM review_images WHERE review_id = 'review-no-images'").run();
    opened.sqlite.prepare(`
      INSERT INTO analysis_jobs (
        id, review_id, owner_id, mode, status, attempt, available_at,
        progress_stage, created_at
      ) VALUES ('active-preview-job', 'review-active', ?, 'content_only', 'running', 1, ?, 'generating_review', ?)
    `).run(OWNER, NOW.valueOf(), NOW.valueOf());
    const assignmentConfig = { ...config, title: "My  Essay", scoringFocus: "最新细节要求" };
    opened.sqlite.prepare(`
      INSERT INTO saved_assignments (id, owner_id, title, config, created_at, updated_at)
      VALUES
        ('assignment-old', ?, 'My  Essay', ?, ?, ?),
        ('assignment-a', ?, ' My  Essay ', ?, ?, ?),
        ('assignment-z', ?, '  My  Essay  ', ?, ?, ?)
    `).run(
      OWNER, JSON.stringify({ ...assignmentConfig, scoringFocus: "旧要求" }), NOW.valueOf() - 3_000, NOW.valueOf() - 2_000,
      OWNER, JSON.stringify(assignmentConfig), NOW.valueOf() - 1_000, NOW.valueOf(),
      OWNER, JSON.stringify(assignmentConfig), NOW.valueOf() - 1_000, NOW.valueOf(),
    );
    const reviewIds = [
      "review-latest-tie",
      "review-case-mismatch",
      "missing-review",
      "review-stale-ocr",
      "review-active",
      "review-1",
      "review-deleting",
      "review-no-images",
    ];
    const before = opened.sqlite.prepare(`
      SELECT
        (SELECT count(*) FROM reviews) AS reviews,
        (SELECT count(*) FROM analysis_jobs) AS jobs,
        (SELECT count(*) FROM saved_assignments) AS assignments
    `).get();

    const result = repository.preview(OWNER, reviewIds);

    expect(result.matched).toEqual([
      {
        reviewId: "review-latest-tie",
        studentName: "陈新",
        title: "My  Essay",
        expectedRevision: 7,
        assignmentId: "assignment-z",
        assignmentUpdatedAt: NOW.toISOString(),
      },
      {
        reviewId: "review-1",
        studentName: "艾绮",
        title: "My  Essay",
        expectedRevision: 3,
        assignmentId: "assignment-z",
        assignmentUpdatedAt: NOW.toISOString(),
      },
    ]);
    expect(result.matched[0]).not.toHaveProperty("config");
    expect(result.skipped).toEqual([
      {
        reviewId: "review-case-mismatch",
        studentName: "艾绮",
        title: "my  essay",
        code: "FRAMEWORK_NOT_FOUND",
        reason: REANALYSIS_SKIP_REASONS.FRAMEWORK_NOT_FOUND,
      },
      {
        reviewId: "missing-review",
        code: "REVIEW_NOT_FOUND",
        reason: REANALYSIS_SKIP_REASONS.REVIEW_NOT_FOUND,
      },
      {
        reviewId: "review-stale-ocr",
        studentName: "艾绮",
        title: "My  Essay",
        code: "OCR_NOT_CURRENT",
        reason: REANALYSIS_SKIP_REASONS.OCR_NOT_CURRENT,
      },
      {
        reviewId: "review-active",
        studentName: "艾绮",
        title: "My  Essay",
        code: "ANALYSIS_ACTIVE",
        reason: REANALYSIS_SKIP_REASONS.ANALYSIS_ACTIVE,
      },
      {
        reviewId: "review-deleting",
        studentName: "艾绮",
        title: "My  Essay",
        code: "REVIEW_UNAVAILABLE",
        reason: REANALYSIS_SKIP_REASONS.REVIEW_UNAVAILABLE,
      },
      {
        reviewId: "review-no-images",
        studentName: "艾绮",
        title: "My  Essay",
        code: "REVIEW_UNAVAILABLE",
        reason: REANALYSIS_SKIP_REASONS.REVIEW_UNAVAILABLE,
      },
    ]);
    expect(opened.sqlite.prepare(`
      SELECT
        (SELECT count(*) FROM reviews) AS reviews,
        (SELECT count(*) FROM analysis_jobs) AS jobs,
        (SELECT count(*) FROM saved_assignments) AS assignments
    `).get()).toEqual(before);
  });

  it("preview 对跨 owner 作文不泄露元数据，并跳过不可用状态", () => {
    insertReview({
      id: "review-other-owner",
      ownerId: OTHER_OWNER,
      studentName: "不可泄露的姓名",
      config: JSON.stringify({ ...config, title: "不可泄露的题目" }),
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
      teacherReviewedAt: null,
    });
    insertReview({
      id: "review-unavailable-status",
      status: "needs_better_images",
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
      teacherReviewedAt: null,
    });
    insertCurrentAssignment();

    expect(repository.preview(OWNER, [
      "review-other-owner",
      "review-unavailable-status",
    ])).toEqual({
      matched: [],
      skipped: [
        {
          reviewId: "review-other-owner",
          code: "REVIEW_NOT_FOUND",
          reason: REANALYSIS_SKIP_REASONS.REVIEW_NOT_FOUND,
        },
        {
          reviewId: "review-unavailable-status",
          studentName: "艾绮",
          title: "My  Essay",
          code: "REVIEW_UNAVAILABLE",
          reason: REANALYSIS_SKIP_REASONS.REVIEW_UNAVAILABLE,
        },
      ],
    });
  });

  it("批量确认按篇事务提交，一篇冲突不回滚另一篇成功", () => {
    insertReview({
      id: "review-conflict",
      revision: 5,
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
      teacherReviewedAt: null,
    });
    const latestConfig = { ...config, title: "My  Essay", scoringFocus: "使用最新框架" };
    opened.sqlite.prepare(`
      INSERT INTO saved_assignments (id, owner_id, title, config, created_at, updated_at)
      VALUES ('assignment-current', ?, 'My  Essay', ?, ?, ?)
    `).run(OWNER, JSON.stringify(latestConfig), NOW.valueOf() - 1_000, NOW.valueOf());
    const oldReport = JSON.stringify({ legacy: "keep-until-new-result" });
    opened.sqlite.prepare("UPDATE reviews SET report = ? WHERE id = 'review-1'").run(oldReport);
    opened.sqlite.prepare(`
      INSERT INTO annotations (
        review_id, position, page_index, x, y, category, anchor_text, comment, is_highlight
      ) VALUES ('review-1', 0, 0, 0.2, 0.3, 'sentence', '原句', '旧批注', 0)
    `).run();
    const preview = repository.preview(OWNER, ["review-1", "review-conflict"]);
    const successPreview = preview.matched.find(({ reviewId }) => reviewId === "review-1")!;
    const successItem = {
      reviewId: successPreview.reviewId,
      expectedRevision: successPreview.expectedRevision,
      assignmentId: successPreview.assignmentId,
      expectedAssignmentUpdatedAt: successPreview.assignmentUpdatedAt,
    };
    const conflictPreview = preview.matched.find(({ reviewId }) => reviewId === "review-conflict")!;
    const conflictItem = {
      reviewId: conflictPreview.reviewId,
      expectedRevision: 4,
      assignmentId: conflictPreview.assignmentId,
      expectedAssignmentUpdatedAt: conflictPreview.assignmentUpdatedAt,
    };

    const result = repository.commitBatch(OWNER, [successItem, conflictItem]);

    expect(result).toEqual({
      submitted: [{ reviewId: "review-1", jobId: "reanalysis-job-1", revision: 4 }],
      skipped: [{
        reviewId: "review-conflict",
        studentName: "艾绮",
        title: "My  Essay",
        code: "REVISION_CONFLICT",
        reason: REANALYSIS_SKIP_REASONS.REVISION_CONFLICT,
      }],
    });
    expect(opened.sqlite.prepare(`
      SELECT status, config, report, revision, image_revision AS imageRevision,
        ocr_checkpoint AS ocrCheckpoint, analysis_run_id AS analysisRunId,
        teacher_reviewed_at AS teacherReviewedAt, pdf_filename AS pdfFilename,
        pdf_path AS pdfPath, pdf_revision AS pdfRevision, exported_at AS exportedAt
      FROM reviews WHERE id = 'review-1'
    `).get()).toEqual({
      status: "analyzing",
      config: JSON.stringify(latestConfig),
      report: oldReport,
      revision: 4,
      imageRevision: 2,
      ocrCheckpoint: JSON.stringify(checkpoint),
      analysisRunId: "reanalysis-job-1",
      teacherReviewedAt: null,
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
    });
    expect(opened.sqlite.prepare(`
      SELECT count(*) AS count FROM annotations WHERE review_id = 'review-1'
    `).get()).toEqual({ count: 1 });
    const job = opened.sqlite.prepare(`
      SELECT mode, status, message, teacher_guidance AS teacherGuidance
      FROM analysis_jobs WHERE id = 'reanalysis-job-1'
    `).get() as { mode: string; status: string; message: string | null; teacherGuidance: string | null };
    expect(job).toMatchObject({ mode: "full", status: "queued", teacherGuidance: null });
    expect(parseAnalysisJobMetadata(job.message)).toEqual({
      kind: "reanalysis",
      prebound: true,
      pdfCleanup: { filename: "old.pdf" },
    });
    expect(opened.sqlite.prepare(`
      SELECT revision, status, analysis_run_id AS analysisRunId
      FROM reviews WHERE id = 'review-conflict'
    `).get()).toEqual({ revision: 5, status: "ready_for_review", analysisRunId: null });
  });

  it("批量单篇提交在读后并发写入时先取得写锁，避免泄露 SQLite 锁错误", () => {
    insertCurrentAssignment();
    const concurrent = injectConcurrentWriterDuringRead();
    try {
      expect(repository.commitBatch(OWNER, [commitItem("review-1")])).toEqual({
        submitted: [{ reviewId: "review-1", jobId: "reanalysis-job-1", revision: 4 }],
        skipped: [],
      });
      expect(concurrent.wasBlocked()).toBe(true);
    } finally {
      concurrent.close();
    }
  });

  it("批量提交遇到已占用写锁时将该项稳定标记为 REVISION_CONFLICT", () => {
    insertCurrentAssignment();
    const concurrent = new Database(databasePath);
    opened.sqlite.pragma("journal_mode = WAL");
    concurrent.pragma("journal_mode = WAL");
    opened.sqlite.pragma("busy_timeout = 0");
    concurrent.exec("BEGIN IMMEDIATE");
    try {
      expect(repository.commitBatch(OWNER, [commitItem("review-1")])).toEqual({
        submitted: [],
        skipped: [{
          reviewId: "review-1",
          code: "REVISION_CONFLICT",
          reason: REANALYSIS_SKIP_REASONS.REVISION_CONFLICT,
        }],
      });
    } finally {
      concurrent.exec("ROLLBACK");
      concurrent.close();
    }
  });

  it("partial unique 竞态项跳过后继续提交后续有效项", () => {
    insertReview({
      id: "review-race",
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
      teacherReviewedAt: null,
    });
    insertReview({
      id: "review-after-race",
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
      teacherReviewedAt: null,
    });
    insertCurrentAssignment();
    injectActiveJobAtInsert("review-race");

    const result = repository.commitBatch(OWNER, [
      commitItem("review-race"),
      commitItem("review-after-race"),
    ]);

    expect(result).toEqual({
      submitted: [{
        reviewId: "review-after-race",
        jobId: "reanalysis-job-2",
        revision: 4,
      }],
      skipped: [{
        reviewId: "review-race",
        studentName: "艾绮",
        title: "My  Essay",
        code: "ANALYSIS_ACTIVE",
        reason: REANALYSIS_SKIP_REASONS.ANALYSIS_ACTIVE,
      }],
    });
    expect(opened.sqlite.prepare(`
      SELECT id, status, revision, analysis_run_id AS analysisRunId
      FROM reviews WHERE id IN ('review-race', 'review-after-race') ORDER BY id
    `).all()).toEqual([
      {
        id: "review-after-race",
        status: "analyzing",
        revision: 4,
        analysisRunId: "reanalysis-job-2",
      },
      {
        id: "review-race",
        status: "ready_for_review",
        revision: 3,
        analysisRunId: null,
      },
    ]);
    expect(opened.sqlite.prepare(`
      SELECT id, review_id AS reviewId FROM analysis_jobs ORDER BY id
    `).all()).toEqual([{
      id: "reanalysis-job-2",
      reviewId: "review-after-race",
    }]);
  });

  it("批量确认在每篇事务内重新校验 owner、状态、图片、OCR 和活动任务", () => {
    insertReview({
      id: "commit-other-owner",
      ownerId: OTHER_OWNER,
      studentName: "不可泄露的姓名",
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
      teacherReviewedAt: null,
    });
    insertReview({ id: "commit-deleting", deletingAt: NOW.valueOf() });
    insertReview({ id: "commit-unavailable", status: "needs_better_images" });
    insertReview({ id: "commit-no-images" });
    insertReview({ id: "commit-no-ocr", ocrCheckpoint: null });
    insertReview({ id: "commit-stale-ocr", imageRevision: 3 });
    insertReview({ id: "commit-active" });
    opened.sqlite.prepare("DELETE FROM review_images WHERE review_id = 'commit-no-images'").run();
    opened.sqlite.prepare(`
      INSERT INTO analysis_jobs (
        id, review_id, owner_id, mode, status, attempt, available_at,
        progress_stage, created_at
      ) VALUES ('commit-active-job', 'commit-active', ?, 'content_only', 'queued', 0, ?, 'queued', ?)
    `).run(OWNER, NOW.valueOf(), NOW.valueOf());
    insertCurrentAssignment();
    const reviewIds = [
      "commit-other-owner",
      "commit-deleting",
      "commit-unavailable",
      "commit-no-images",
      "commit-no-ocr",
      "commit-stale-ocr",
      "commit-active",
    ];

    const result = repository.commitBatch(OWNER, reviewIds.map((reviewId) => commitItem(reviewId)));

    expect(result.submitted).toEqual([]);
    expect(result.skipped).toEqual([
      {
        reviewId: "commit-other-owner",
        code: "REVIEW_NOT_FOUND",
        reason: REANALYSIS_SKIP_REASONS.REVIEW_NOT_FOUND,
      },
      ...["commit-deleting", "commit-unavailable", "commit-no-images"].map((reviewId) => ({
        reviewId,
        studentName: "艾绮",
        title: "My  Essay",
        code: "REVIEW_UNAVAILABLE" as const,
        reason: REANALYSIS_SKIP_REASONS.REVIEW_UNAVAILABLE,
      })),
      ...["commit-no-ocr", "commit-stale-ocr"].map((reviewId) => ({
        reviewId,
        studentName: "艾绮",
        title: "My  Essay",
        code: "OCR_NOT_CURRENT" as const,
        reason: REANALYSIS_SKIP_REASONS.OCR_NOT_CURRENT,
      })),
      {
        reviewId: "commit-active",
        studentName: "艾绮",
        title: "My  Essay",
        code: "ANALYSIS_ACTIVE",
        reason: REANALYSIS_SKIP_REASONS.ANALYSIS_ACTIVE,
      },
    ]);
    expect(opened.sqlite.prepare(`
      SELECT id, revision, analysis_run_id AS analysisRunId
      FROM reviews WHERE id LIKE 'commit-%' ORDER BY id
    `).all()).toEqual(reviewIds.slice().sort().map((id) => ({
      id,
      revision: 3,
      analysisRunId: null,
    })));
    expect(opened.sqlite.prepare("SELECT count(*) AS count FROM analysis_jobs").get()).toEqual({ count: 1 });
  });

  it("预览后框架变化时跳过，不信任客户端的旧版本", () => {
    opened.sqlite.prepare(`
      INSERT INTO saved_assignments (id, owner_id, title, config, created_at, updated_at)
      VALUES ('assignment-current', ?, 'My  Essay', ?, ?, ?)
    `).run(OWNER, JSON.stringify({ ...config, title: "My  Essay" }), NOW.valueOf() - 1_000, NOW.valueOf());
    const preview = repository.preview(OWNER, ["review-1"]).matched[0]!;
    const item = {
      reviewId: preview.reviewId,
      expectedRevision: preview.expectedRevision,
      assignmentId: preview.assignmentId,
      expectedAssignmentUpdatedAt: preview.assignmentUpdatedAt,
    };
    opened.sqlite.prepare(`
      UPDATE saved_assignments SET config = ?, updated_at = ? WHERE id = 'assignment-current'
    `).run(JSON.stringify({ ...config, title: "My  Essay", scoringFocus: "预览后变更" }), NOW.valueOf() + 1_000);

    expect(repository.commitBatch(OWNER, [item])).toEqual({
      submitted: [],
      skipped: [{
        reviewId: "review-1",
        studentName: "艾绮",
        title: "My  Essay",
        code: "FRAMEWORK_CHANGED",
        reason: REANALYSIS_SKIP_REASONS.FRAMEWORK_CHANGED,
      }],
    });
    expect(opened.sqlite.prepare("SELECT count(*) AS count FROM analysis_jobs").get()).toEqual({ count: 0 });
    expect(reviewRepository.getById(OWNER, "review-1")).toMatchObject({
      revision: 3,
      status: "ready_for_review",
      analysisRunId: null,
    });
  });

  it("未知的框架数据损坏必须继续抛出而不是被转成 skipped", () => {
    opened.sqlite.prepare(`
      INSERT INTO saved_assignments (id, owner_id, title, config, created_at, updated_at)
      VALUES ('assignment-current', ?, 'My  Essay', ?, ?, ?)
    `).run(OWNER, JSON.stringify({ ...config, title: "My  Essay" }), NOW.valueOf() - 1_000, NOW.valueOf());
    const preview = repository.preview(OWNER, ["review-1"]).matched[0]!;
    const item = {
      reviewId: preview.reviewId,
      expectedRevision: preview.expectedRevision,
      assignmentId: preview.assignmentId,
      expectedAssignmentUpdatedAt: preview.assignmentUpdatedAt,
    };
    opened.sqlite.prepare(`
      UPDATE saved_assignments SET config = '{broken-json' WHERE id = 'assignment-current'
    `).run();

    expect(() => repository.commitBatch(OWNER, [item])).toThrow();
    expect(opened.sqlite.prepare("SELECT count(*) AS count FROM analysis_jobs").get()).toEqual({ count: 0 });
    expect(reviewRepository.getById(OWNER, "review-1")).toMatchObject({
      revision: 3,
      status: "ready_for_review",
    });
  });
});
