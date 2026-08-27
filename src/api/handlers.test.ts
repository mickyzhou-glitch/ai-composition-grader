// @vitest-environment node

const OWNER_ID = "local-admin";

import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { AiReviewEnvelope } from "../domain/contracts";
import { initializeSchema } from "../db/init";
import { ReviewRepository } from "../db/review-repository";
import * as schema from "../db/schema";
import { ImageService, MAX_IMAGE_BYTES } from "../images/image-service";
import { AnalysisJobRepository } from "../jobs/analysis-job-repository";
import { AnalysisJobService } from "../jobs/analysis-job-service";
import { ReviewService, type AiReviewer } from "../services/review-service";
import { ReviewFileStore } from "../storage/review-file-store";
import {
  createAssignmentGuidanceRouteHandlers,
  createAnalyzeRouteHandlers,
  createBatchReanalysisPreviewRouteHandlers,
  createBatchReanalysisRouteHandlers,
  createReviewImagesRouteHandlers,
  createReviewOcrRouteHandlers,
  createReviewExportCheckRouteHandlers,
  createRevisionRequestRouteHandlers,
  createTeacherReviewQueueRouteHandlers,
  createTeacherReviewRouteHandlers,
  createReviewRouteHandlers,
  createReviewsRouteHandlers,
  createSettingsRouteHandlers,
} from "./handlers";

const config = {
  title: "为自己喝彩",
  grade: "上海五四学制六年级",
  writingRequirements: "写一件亲身经历的事。",
  targetCharacters: 600,
  structureRequirements: "开头点题，结尾升华。",
  scoringFocus: "细节描写。",
  templateType: "preset_self_applause" as const,
};

const report = {
  themeFit: "fits" as const,
  themeReason: "紧扣主题。",
  personalizedComment: "写得真诚。",
  painPoints: ["结尾略快"],
  commonIssues: ["长句较多"],
  revisionSuggestions: ["补充感受"],
  grade: "A-" as const,
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
};

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

function jsonRequest(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function expectNoStore(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
}

describe("settings route handlers", () => {
  it("GET 只返回脱敏视图，绝不读取或回显 API key", async () => {
    const settingsService = {
      get: vi.fn(async () => ({
        baseUrl: "https://ai.example.test/v1",
        model: "vision-model",
        keyConfigured: true,
      })),
      getSecret: vi.fn(async () => "must-not-leak"),
      testCandidate: vi.fn(),
    };
    const handlers = createSettingsRouteHandlers({
      settingsService,
      testConnection: vi.fn(),
    });

    const response = await handlers.GET();

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      ok: true,
      data: {
        baseUrl: "https://ai.example.test/v1",
        model: "vision-model",
        keyConfigured: true,
      },
    });
    expect(settingsService.getSecret).not.toHaveBeenCalled();
    expect(JSON.stringify(await json(await handlers.GET()))).not.toContain("must-not-leak");
  });

  it("PUT 先测试候选连接，成功后才保存", async () => {
    const calls: string[] = [];
    const testConnection = vi.fn(async () => calls.push("test"));
    const settingsService = {
      get: vi.fn(),
      testCandidate: vi.fn(async (input, tester, save) => {
        await tester({ ...input, apiKey: input.apiKey ?? "stored-key" });
        expect(save).toBe(true);
        calls.push("save");
        return { baseUrl: "https://ai.test/v1", model: "m", keyConfigured: true };
      }),
    };
    const handlers = createSettingsRouteHandlers({
      settingsService,
      testConnection,
    });

    const response = await handlers.PUT(
      jsonRequest("http://localhost/api/settings", "PUT", {
        baseUrl: "https://ai.test/v1/",
        model: "m",
        apiKey: "new-key",
      }),
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual(["test", "save"]);
    expect(settingsService.testCandidate).toHaveBeenCalledWith({
      baseUrl: "https://ai.test/v1",
      model: "m",
      apiKey: "new-key",
    }, testConnection, true);
  });

  it("PUT 连接测试失败时不保存候选设置", async () => {
    const settingsService = {
      get: vi.fn(),
      testCandidate: vi.fn(async (_input, tester) => tester({
        baseUrl: "https://ai.test/v1",
        model: "m",
        apiKey: "bad-key",
      })),
    };
    const testConnection = vi.fn(async () => {
      throw Object.assign(new Error("provider failed"), {
        code: "AI_REQUEST_FAILED",
        status: 502,
      });
    });
    const handlers = createSettingsRouteHandlers({
      settingsService,
      testConnection,
    });

    const response = await handlers.PUT(
      jsonRequest("http://localhost/api/settings", "PUT", {
        baseUrl: "https://ai.test/v1",
        model: "m",
        apiKey: "bad-key",
      }),
    );

    expect(response.status).toBe(502);
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: "AI_REQUEST_FAILED" },
    });
    expect(settingsService.testCandidate).toHaveBeenCalledWith({
      baseUrl: "https://ai.test/v1",
      model: "m",
      apiKey: "bad-key",
    }, testConnection, true);
  });

  it("POST /test 测试失败不保存并返回 502", async () => {
    const settingsService = {
      get: vi.fn(),
      testCandidate: vi.fn(async (_input, tester) => tester({
        baseUrl: "https://ai.test/v1",
        model: "m",
        apiKey: "bad-key",
      })),
    };
    const testConnection = vi.fn(async () => {
      throw Object.assign(new Error("provider failed"), {
        code: "AI_REQUEST_FAILED",
        status: 502,
      });
    });
    const handlers = createSettingsRouteHandlers({
      settingsService,
      testConnection,
    });

    const response = await handlers.POST_TEST(
      jsonRequest("http://localhost/api/settings/test", "POST", {
        baseUrl: "https://ai.test/v1",
        model: "m",
        apiKey: "bad-key",
      }),
    );

    expect(response.status).toBe(502);
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: "AI_REQUEST_FAILED" },
    });
    expect(settingsService.testCandidate).toHaveBeenCalledWith({
      baseUrl: "https://ai.test/v1",
      model: "m",
      apiKey: "bad-key",
    }, testConnection, false);
  });
});

describe("assignment guidance route handlers", () => {
  it("校验输入并返回 AI 生成的可编辑要求", async () => {
    const generate = vi.fn(async () => ({
      writingRequirements: "写清一件具体的事。",
      structureRequirements: "开头点题，中间展开，结尾回扣题目。",
      scoringFocus: "内容具体，感受真实。",
    }));
    const handlers = createAssignmentGuidanceRouteHandlers({ generate });

    const response = await handlers.POST(
      jsonRequest("http://localhost/api/assignment-guidance", "POST", {
        title: "我学会了等待",
        grade: "上海五四学制六年级",
        targetCharacters: 600,
      }),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      ok: true,
      data: { writingRequirements: "写清一件具体的事。" },
    });
    expect(generate).toHaveBeenCalledWith({
      title: "我学会了等待",
      grade: "上海五四学制六年级",
      targetCharacters: 600,
    });
  });
});

describe("review route handlers", () => {
  let sqlite: Database.Database;
  let temporaryDirectory: string;
  let repository: ReviewRepository;
  let fileStore: ReviewFileStore;
  let imageService: ImageService;
  let reviewService: ReviewService;
  let aiResult: AiReviewEnvelope;
  let analyze: Mock<AiReviewer["analyze"]>;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    initializeSchema(sqlite);
    repository = new ReviewRepository(drizzle(sqlite, { schema }));
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "grader-api-"));
    fileStore = new ReviewFileStore(path.join(temporaryDirectory, "reviews"));
    imageService = new ImageService(fileStore, repository, {
      createId: (() => {
        let index = 0;
        return () => `image-${++index}`;
      })(),
    });
    aiResult = { readable: true, pageWarnings: [], report, annotations: [] };
    analyze = vi.fn(async (input) => {
      void input;
      return aiResult;
    });
    reviewService = new ReviewService(repository, fileStore, { analyze }, {
      createId: () => "review-1",
    });
  });

  afterEach(async () => {
    sqlite.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("完成 review CRUD 并以统一信封返回 404/400", async () => {
    const collection = createReviewsRouteHandlers({ reviewService, ownerId: OWNER_ID });
    const item = createReviewRouteHandlers({ reviewService, ownerId: OWNER_ID });

    const invalid = await collection.POST(
      jsonRequest("http://localhost/api/reviews", "POST", { title: "missing" }),
    );
    expect(invalid.status).toBe(400);

    const created = await collection.POST(
      jsonRequest("http://localhost/api/reviews", "POST", {
        config,
        studentName: "李羿辰",
      }),
    );
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({
      ok: true,
      data: { id: "review-1", status: "draft", studentName: "李羿辰" },
    });

    const listed = await collection.GET();
    expect(await json(listed)).toMatchObject({ ok: true, data: [{ id: "review-1" }] });

    const patched = await item.PATCH(
      jsonRequest("http://localhost/api/reviews/review-1", "PATCH", {
        expectedRevision: 0,
        config: { ...config, title: "我为自己喝彩" },
      }),
      { params: Promise.resolve({ id: "review-1" }) },
    );
    expect(await json(patched)).toMatchObject({
      ok: true,
      data: { config: { title: "我为自己喝彩" } },
    });

    const illegalStatus = await item.PATCH(
      jsonRequest("http://localhost/api/reviews/review-1", "PATCH", {
        expectedRevision: 1,
        config: { ...config, title: "不应保存" },
        status: "ready_for_review",
      }),
      { params: Promise.resolve({ id: "review-1" }) },
    );
    expect(illegalStatus.status).toBe(400);
    expect(repository.getById(OWNER_ID, "review-1")).toMatchObject({
      status: "draft",
      config: { title: "我为自己喝彩" },
    });

    const teacherReview = await item.PATCH(
      jsonRequest("http://localhost/api/reviews/review-1", "PATCH", {
        expectedRevision: 1,
        studentName: "张小明",
        report,
        annotations: [
          {
            pageIndex: 0,
            x: 0.2,
            y: 0.3,
            category: "sentence",
            anchorText: "我跑得很快",
            comment: "补充动作细节。",
            isHighlight: false,
          },
        ],
      }),
      { params: Promise.resolve({ id: "review-1" }) },
    );
    expect(teacherReview.status).toBe(200);
    expect(repository.getById(OWNER_ID, "review-1")).toMatchObject({
      studentName: "张小明",
      status: "ready_for_review",
      report,
      annotations: [{ category: "sentence" }],
    });

    const reviewDirectory = fileStore.getReviewPaths(OWNER_ID, "review-1").reviewDirectory;
    await expect(stat(reviewDirectory)).resolves.toMatchObject({});

    const deleted = await item.DELETE(new Request("http://localhost"), {
      params: Promise.resolve({ id: "review-1" }),
    });
    expect(deleted.status).toBe(200);
    await expect(stat(reviewDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    const missing = await item.GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: "review-1" }),
    });
    expect(missing.status).toBe(404);
  });

  it("教师 PATCH 要求版本号，并拒绝跨页提交的过期版本", async () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    const item = createReviewRouteHandlers({ reviewService, ownerId: OWNER_ID });

    const missingRevision = await item.PATCH(
      jsonRequest("http://localhost/api/reviews/review-1", "PATCH", {
        config: { ...config, title: "缺少版本号" },
      }),
      { params: Promise.resolve({ id: "review-1" }) },
    );
    expect(missingRevision.status).toBe(400);

    const firstPageSave = await item.PATCH(
      jsonRequest("http://localhost/api/reviews/review-1", "PATCH", {
        expectedRevision: 0,
        config: { ...config, title: "第一页已保存" },
      }),
      { params: Promise.resolve({ id: "review-1" }) },
    );
    expect(firstPageSave.status).toBe(200);
    expect(await json(firstPageSave)).toMatchObject({
      ok: true,
      data: { revision: 1, config: { title: "第一页已保存" } },
    });

    const staleSecondPageSave = await item.PATCH(
      jsonRequest("http://localhost/api/reviews/review-1", "PATCH", {
        expectedRevision: 0,
        config: { ...config, title: "过期的第二页保存" },
      }),
      { params: Promise.resolve({ id: "review-1" }) },
    );
    expect(staleSecondPageSave.status).toBe(409);
    expect(await json(staleSecondPageSave)).toMatchObject({
      ok: false,
      error: { code: "REVISION_CONFLICT" },
    });
    expect(repository.getById(OWNER_ID, "review-1")).toMatchObject({
      revision: 1,
      config: { title: "第一页已保存" },
    });
  });

  it("OCR PATCH 严格要求当前全部自然段并返回安全视图", async () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    sqlite.prepare("UPDATE reviews SET ocr_checkpoint = ? WHERE id = ?").run(JSON.stringify({
      version: 2,
      sourceRevision: 0,
      ocrRevision: 0,
      editedAt: null,
      pages: [{
        pageIndex: 0,
        text: "第一段。第二段。",
        readable: true,
        warnings: [],
        blocks: [{ text: "内部分块", x: 0.1, y: 0.2, width: 0.5, height: 0.08 }],
      }],
      paragraphs: [
        {
          id: "paragraph-1",
          paragraphIndex: 0,
          text: "第一段。",
          segments: [{ pageIndex: 0, text: "第一段。", x: 0.1, y: 0.2, width: 0.5, height: 0.08 }],
        },
        {
          id: "paragraph-2",
          paragraphIndex: 1,
          text: "第二段。",
          segments: [{ pageIndex: 0, text: "第二段。", x: 0.1, y: 0.5, width: 0.5, height: 0.08 }],
        },
      ],
    }), "review-1");
    const handlers = createReviewOcrRouteHandlers({ reviewService, ownerId: OWNER_ID });
    const context = { params: Promise.resolve({ id: "review-1" }) };

    const legacy = await handlers.PATCH(jsonRequest(
      "http://localhost/api/reviews/review-1/ocr",
      "PATCH",
      { expectedOcrRevision: 0, pages: [{ pageIndex: 0, text: "伪装的逐页编辑" }] },
    ), context);
    expect(legacy.status).toBe(400);

    const response = await handlers.PATCH(jsonRequest(
      "http://localhost/api/reviews/review-1/ocr",
      "PATCH",
      {
        expectedOcrRevision: 0,
        paragraphs: [
          { paragraphId: "paragraph-1", text: "老师修正的第一段。" },
          { paragraphId: "paragraph-2", text: "老师修正的第二段。" },
        ],
      },
    ), context);

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({
      ok: true,
      data: {
        ocr: {
          version: 2,
          ocrRevision: 1,
          paragraphs: [
            { id: "paragraph-1", text: "老师修正的第一段。" },
            { id: "paragraph-2", text: "老师修正的第二段。" },
          ],
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain("blocks");
  });

  it("OCR PATCH 对 v1 检查点返回稳定 OCR_V2_REQUIRED 冲突", async () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    sqlite.prepare("UPDATE reviews SET ocr_checkpoint = ? WHERE id = ?").run(JSON.stringify({
      version: 1,
      sourceRevision: 0,
      ocrRevision: 0,
      editedAt: null,
      pages: [{ pageIndex: 0, text: "旧正文", readable: true, warnings: [], blocks: [] }],
    }), "review-1");
    const handlers = createReviewOcrRouteHandlers({ reviewService, ownerId: OWNER_ID });

    const response = await handlers.PATCH(jsonRequest(
      "http://localhost/api/reviews/review-1/ocr",
      "PATCH",
      {
        expectedOcrRevision: 0,
        paragraphs: [{ paragraphId: "paragraph-1", text: "修正" }],
      },
    ), { params: Promise.resolve({ id: "review-1" }) });

    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: "OCR_V2_REQUIRED" },
    });
  });

  it("教师 PATCH 可保存不再符合 AI 生成字数的草稿", async () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    const ready = repository.updateReport(OWNER_ID, "review-1", report);
    const item = createReviewRouteHandlers({ reviewService, ownerId: OWNER_ID });

    const response = await item.PATCH(
      jsonRequest("http://localhost/api/reviews/review-1", "PATCH", {
        expectedRevision: ready.revision,
        report: { ...report, sampleParagraphs: report.sampleParagraphs.slice(0, 1) },
      }),
      { params: Promise.resolve({ id: "review-1" }) },
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      ok: true,
      data: { report: { sampleParagraphs: [report.sampleParagraphs[0]] } },
    });
  });

  it("提供待审核队列、原子教师确认和整批导出预检", async () => {
    repository.create(OWNER_ID, { id: "review-1", config, studentName: "张小明" });
    repository.updateReport(OWNER_ID, "review-1", report);
    const queue = createTeacherReviewQueueRouteHandlers({ reviewService, ownerId: OWNER_ID });
    const teacherReview = createTeacherReviewRouteHandlers({ reviewService, ownerId: OWNER_ID });
    const exportCheck = createReviewExportCheckRouteHandlers({ reviewService, ownerId: OWNER_ID });

    expect(await json(await queue.GET())).toMatchObject({
      ok: true,
      data: [{ id: "review-1", studentName: "张小明", revision: 1 }],
    });
    const completed = await teacherReview.POST(jsonRequest("http://localhost/api/reviews/review-1/teacher-review", "POST", {
      expectedRevision: 1,
      studentName: "张小明",
      report,
      annotations: [],
    }), { params: Promise.resolve({ id: "review-1" }) });
    expect(await json(completed)).toMatchObject({
      ok: true,
      data: { id: "review-1", revision: 2, teacherReviewedAt: expect.any(String) },
    });
    const checkpoint = {
      version: 2, sourceRevision: 0, ocrRevision: 0, editedAt: null,
      pages: [{
        pageIndex: 0, text: "原文。", readable: true, warnings: [],
        blocks: [{ text: "原文。", x: 0.1, y: 0.2, width: 0.5, height: 0.2 }],
      }],
      paragraphs: [{
        id: "paragraph-1", paragraphIndex: 0, text: "原文。",
        segments: [{ pageIndex: 0, text: "原文。", x: 0.1, y: 0.2, width: 0.5, height: 0.2 }],
      }],
    };
    const paragraphReport = {
      version: 2,
      themeFit: report.themeFit,
      themeReason: report.themeReason,
      personalizedComment: report.personalizedComment,
      painPoints: report.painPoints,
      commonIssues: report.commonIssues,
      revisionSuggestions: report.revisionSuggestions,
      grade: report.grade,
      diagnostics: report.diagnostics,
      paragraphReviews: [{
        paragraphId: "paragraph-1",
        suggestions: [{ problem: "保留", advice: "保留", example: "自然。" }],
        revisedText: "原文。",
      }],
      parentFeedbacks: [],
    };
    sqlite.prepare(`
      INSERT INTO review_images (
        review_id, page_index, path, position, original_name, mime_type,
        original_path, annotation_path, ai_path, width, height, rotation, crop, created_at
      ) VALUES (?, 0, ?, 0, ?, 'image/jpeg', ?, ?, ?, 1000, 1500, 0, NULL, ?)
    `).run(
      "review-1", "images/page-ai.jpg", "page.jpg", "images/page-original.jpg",
      "images/page-annotation.jpg", "images/page-ai.jpg", Date.now(),
    );
    sqlite.prepare(`
      UPDATE reviews SET report = ?, ocr_checkpoint = ?, report_ocr_revision = 0
      WHERE id = ? AND owner_id = ?
    `).run(JSON.stringify(paragraphReport), JSON.stringify(checkpoint), "review-1", OWNER_ID);
    const eligible = await exportCheck.POST(jsonRequest("http://localhost/api/reviews/export-check", "POST", {
      reviews: [{ id: "review-1", revision: 2 }],
    }));
    expect(await json(eligible)).toEqual({ ok: true, data: { exportable: true } });

    repository.create(OWNER_ID, { id: "review-2", config });
    repository.updateReport(OWNER_ID, "review-2", report);
    const rejected = await exportCheck.POST(jsonRequest("http://localhost/api/reviews/export-check", "POST", {
      reviews: [{ id: "review-1", revision: 2 }, { id: "review-2", revision: 1 }],
    }));
    expect(rejected.status).toBe(422);
    expect(await json(rejected)).toMatchObject({ ok: false, error: { code: "EXPORT_NOT_AVAILABLE" } });
  });

  it("列表和详情 DTO 只暴露 PDF 状态与文件名，不泄漏内部存储路径", async () => {
    const internalImage = {
      id: 3,
      position: 0,
      originalName: "作文.jpg",
      mimeType: "image/jpeg",
      originalPath: "images/internal-original.jpg",
      annotationPath: "images/internal-annotation.jpg",
      aiPath: "images/internal-ai.jpg",
      width: 60,
      height: 80,
      rotation: 0 as const,
      crop: null,
    };
    const internalReview = {
      id: "review-safe",
      status: "draft" as const,
      config,
      report: null,
      revision: 4,
      analysisRunId: null,
      pdfFilename: "作文批改-安全.pdf",
      pdfPath: "pdf/作文批改-安全.pdf",
      pdfRevision: 4,
      exportedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      images: [internalImage],
      annotations: [],
    };
    const collection = createReviewsRouteHandlers({
      ownerId: OWNER_ID,
      reviewService: { list: () => [internalReview] } as never,
    });
    const detail = createReviewRouteHandlers({
      ownerId: OWNER_ID,
      reviewService: { get: () => internalReview } as never,
    });

    const listed = await collection.GET();
    const shown = await detail.GET(new Request("http://localhost"), {
      params: Promise.resolve({ id: "review-safe" }),
    });

    for (const response of [listed, shown]) {
      const serialized = JSON.stringify(await json(response));
      expect(serialized).not.toContain("images/internal-original.jpg");
      expect(serialized).not.toContain("images/internal-annotation.jpg");
      expect(serialized).not.toContain("images/internal-ai.jpg");
      expect(serialized).not.toContain('"pdfPath"');
      expect(serialized).toContain('"hasPdf":true');
      expect(serialized).toContain('"pdfFilename":"作文批改-安全.pdf"');
    }
  });

  it("教师提交不符合业务评分约束的报告时返回 400", async () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    const item = createReviewRouteHandlers({ reviewService, ownerId: OWNER_ID });

    const response = await item.PATCH(
      jsonRequest("http://localhost/api/reviews/review-1", "PATCH", {
        expectedRevision: 0,
        report: { ...report, themeFit: "off_topic" },
      }),
      { params: Promise.resolve({ id: "review-1" }) },
    );

    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
  });

  it("multipart 一次上传四图并保存处理后的字段", async () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    const pixels = await sharp({
      create: { width: 60, height: 80, channels: 3, background: "white" },
    }).jpeg().toBuffer();
    const form = new FormData();
    form.append("expectedRevision", "0");
    form.append("privacyConfirmed", "true");
    form.append("privacyNoticeVersion", "2026-07-22");
    for (let index = 0; index < 4; index += 1) {
      form.append("images", new File([pixels], `page-${index + 1}.jpg`, { type: "image/jpeg" }));
    }
    const handlers = createReviewImagesRouteHandlers({ imageService, ownerId: OWNER_ID });

    const response = await handlers.POST(
      new Request("http://localhost/api/reviews/review-1/images", {
        method: "POST",
        body: form,
      }),
      { params: Promise.resolve({ id: "review-1" }) },
    );

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({ ok: true });
    expect((body.data as { images: unknown[] }).images).toHaveLength(4);
    expect(repository.getById(OWNER_ID, "review-1")?.images[3]).toMatchObject({
      position: 3,
      originalName: "page-4.jpg",
      width: 60,
      height: 80,
    });

    const current = repository.getById(OWNER_ID, "review-1")?.images ?? [];
    const patched = await handlers.PATCH(
      jsonRequest("http://localhost/api/reviews/review-1/images", "PATCH", {
        expectedRevision: 1,
        images: current.map((image, index) => ({
          id: image.id,
          position: current.length - index - 1,
          ...(index === 0
            ? {
                rotation: 90,
                crop: { x: 0, y: 0, width: 0.5, height: 1 },
              }
            : {}),
        })),
      }),
      { params: Promise.resolve({ id: "review-1" }) },
    );

    expect(patched.status).toBe(200);
    expect(repository.getById(OWNER_ID, "review-1")?.images).toMatchObject([
      { originalName: "page-4.jpg", position: 0 },
      { originalName: "page-3.jpg", position: 1 },
      { originalName: "page-2.jpg", position: 2 },
      {
        originalName: "page-1.jpg",
        position: 3,
        rotation: 90,
        crop: { x: 0, y: 0, width: 0.5, height: 1 },
        width: 40,
        height: 60,
      },
    ]);
  });

  it("首次上传必须由服务端验证隐私确认，且不设置作文到期时间", async () => {
    repository.create(OWNER_ID, { id: "review-privacy", config });
    const pixels = await sharp({
      create: { width: 60, height: 80, channels: 3, background: "white" },
    }).jpeg().toBuffer();
    const handlers = createReviewImagesRouteHandlers({ imageService, ownerId: OWNER_ID });
    const missing = new FormData();
    missing.append("expectedRevision", "0");
    missing.append("images", new File([pixels], "page.jpg", { type: "image/jpeg" }));

    const rejected = await handlers.POST(
      new Request("http://localhost/api/reviews/review-privacy/images", { method: "POST", body: missing }),
      { params: Promise.resolve({ id: "review-privacy" }) },
    );
    expect(rejected.status).toBe(422);
    expect(await json(rejected)).toMatchObject({ error: { code: "PRIVACY_CONFIRMATION_REQUIRED" } });

    const accepted = new FormData();
    accepted.append("expectedRevision", "0");
    accepted.append("privacyConfirmed", "true");
    accepted.append("privacyNoticeVersion", "2026-07-22");
    accepted.append("images", new File([pixels], "page.jpg", { type: "image/jpeg" }));
    expect((await handlers.POST(
      new Request("http://localhost/api/reviews/review-privacy/images", { method: "POST", body: accepted }),
      { params: Promise.resolve({ id: "review-privacy" }) },
    )).status).toBe(200);
    expect(repository.getById(OWNER_ID, "review-privacy")).toMatchObject({
      privacyConsentVersion: "2026-07-22",
      privacyConsentedAt: expect.any(Date),
      expiresAt: null,
    });
  });

  it("不同教师不能借确认标记上传他人的作文", async () => {
    repository.create(OWNER_ID, { id: "review-private", config });
    const form = new FormData();
    form.append("expectedRevision", "0");
    form.append("privacyConfirmed", "true");
    form.append("privacyNoticeVersion", "2026-07-22");
    form.append("images", new File([new Uint8Array([1])], "page.jpg", { type: "image/jpeg" }));
    const handlers = createReviewImagesRouteHandlers({ imageService, ownerId: "teacher-02" });

    const response = await handlers.POST(
      new Request("http://localhost/api/reviews/review-private/images", { method: "POST", body: form }),
      { params: Promise.resolve({ id: "review-private" }) },
    );
    expect(response.status).toBe(404);
    expect(repository.getById(OWNER_ID, "review-private")?.images).toHaveLength(0);
  });

  it("旧 revision 重拍或变换都返回 409，并保留 SQLite 图片和已存文件", async () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    const pixels = await sharp({
      create: { width: 60, height: 80, channels: 3, background: "white" },
    }).jpeg().toBuffer();
    const handlers = createReviewImagesRouteHandlers({ imageService, ownerId: OWNER_ID });
    const initial = new FormData();
    initial.append("expectedRevision", "0");
    initial.append("privacyConfirmed", "true");
    initial.append("privacyNoticeVersion", "2026-07-22");
    initial.append("images", new File([pixels], "current.jpg", { type: "image/jpeg" }));
    expect((await handlers.POST(
      new Request("http://localhost/api/reviews/review-1/images", { method: "POST", body: initial }),
      { params: Promise.resolve({ id: "review-1" }) },
    )).status).toBe(200);
    const before = repository.getById(OWNER_ID, "review-1");
    const imageDirectory = fileStore.getReviewPaths(OWNER_ID, "review-1").imagesDirectory;
    const filesBefore = (await readdir(imageDirectory)).sort();

    repository.updateTeacherEdits(OWNER_ID, "review-1", {
      expectedRevision: 1,
      config: { ...config, title: "另一标签页已保存" },
    });
    const stale = new FormData();
    stale.append("expectedRevision", "1");
    stale.append("images", new File([pixels], "stale.jpg", { type: "image/jpeg" }));
    const response = await handlers.POST(
      new Request("http://localhost/api/reviews/review-1/images", { method: "POST", body: stale }),
      { params: Promise.resolve({ id: "review-1" }) },
    );

    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    expect(repository.getById(OWNER_ID, "review-1")?.images).toEqual(before?.images);
    expect((await readdir(imageDirectory)).sort()).toEqual(filesBefore);

    const staleTransform = await handlers.PATCH(
      jsonRequest("http://localhost/api/reviews/review-1/images", "PATCH", {
        expectedRevision: 1,
        images: before?.images.map((image) => ({ id: image.id, rotation: 90 })),
      }),
      { params: Promise.resolve({ id: "review-1" }) },
    );
    expect(staleTransform.status).toBe(409);
    expect(await json(staleTransform)).toMatchObject({ error: { code: "REVISION_CONFLICT" } });
    expect(repository.getById(OWNER_ID, "review-1")?.images).toEqual(before?.images);
    expect((await readdir(imageDirectory)).sort()).toEqual(filesBefore);
  });

  it("在解析 multipart 前按 Content-Length 拒绝超过 64MB 的请求", async () => {
    const handlers = createReviewImagesRouteHandlers({ imageService, ownerId: OWNER_ID });
    const request = new Request("http://localhost/api/reviews/review-1/images", {
      method: "POST",
      headers: { "content-length": String(64 * 1024 * 1024 + 1) },
    });
    const formData = vi.spyOn(request, "formData");

    const response = await handlers.POST(request, {
      params: Promise.resolve({ id: "review-1" }),
    });

    expect(response.status).toBe(413);
    expect(formData).not.toHaveBeenCalled();
  });

  it("无 Content-Length 的分块 multipart 也按实际读取字节硬拒绝", async () => {
    const boundary = "grader-boundary";
    const body = [
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="images"; filename="page.jpg"\r\n',
      "Content-Type: image/jpeg\r\n\r\n",
      "123456789",
      `\r\n--${boundary}--\r\n`,
    ].join("");
    const encoded = new TextEncoder().encode(body);
    const request = new Request("http://localhost/api/reviews/review-1/images", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoded.subarray(0, 8));
          controller.enqueue(encoded.subarray(8));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(request.headers.get("content-length")).toBeNull();
    const handlers = createReviewImagesRouteHandlers(
      { imageService, ownerId: OWNER_ID },
      { maxMultipartBytes: 8 },
    );

    const response = await handlers.POST(request, {
      params: Promise.resolve({ id: "review-1" }),
    });

    expect(response.status).toBe(413);
    expect(await json(response)).toMatchObject({
      error: { code: "PAYLOAD_TOO_LARGE" },
    });
  });

  it("在读取 File 内容前检查单张 20MB 上限", async () => {
    const handlers = createReviewImagesRouteHandlers({ imageService, ownerId: OWNER_ID });
    const file = new File(
      [new Uint8Array(MAX_IMAGE_BYTES + 1)],
      "too-large.jpg",
      { type: "image/jpeg" },
    );
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");
    const request = {
      headers: new Headers(),
      formData: vi.fn(async () => ({
        get: (key: string) => key === "expectedRevision" ? "0" : null,
        getAll: () => [file],
      })),
    } as never;

    const response = await handlers.POST(request, {
      params: Promise.resolve({ id: "review-1" }),
    });

    expect(response.status).toBe(413);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("analyze 仅创建后台任务，不在 HTTP 请求中调用模型", async () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    await imageService.upload(OWNER_ID, "review-1", repository.getById(OWNER_ID, "review-1")?.revision ?? 0, [
      {
        originalName: "page.jpg",
        mimeType: "image/jpeg",
        data: await sharp({
          create: { width: 60, height: 80, channels: 3, background: "white" },
        }).jpeg().toBuffer(),
      },
    ], { confirmed: true, version: "2026-07-22" });
    const queuedJob = {
      id: "job-1",
      reviewId: "review-1",
      status: "queued" as const,
      progressStage: "queued" as const,
      message: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    const analysisJobService = {
      enqueue: vi.fn(() => queuedJob),
      getForReview: vi.fn(() => queuedJob),
    };
    const handlers = createAnalyzeRouteHandlers({
      reviewService,
      analysisJobService: analysisJobService as never,
      ownerId: OWNER_ID,
    });

    const response = await handlers.POST(new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teacherGuidance: "请重点看结尾是否真正扣题，并保留我认为有效的细节。" }),
    }), {
      params: Promise.resolve({ id: "review-1" }),
    });
    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({
      data: { id: "job-1", status: "queued", progressStage: "queued" },
    });
    expect(analysisJobService.enqueue).toHaveBeenCalledWith(
      OWNER_ID,
      "review-1",
      "请重点看结尾是否真正扣题，并保留我认为有效的细节。",
      "full",
    );
    expect(analyze).not.toHaveBeenCalled();

    const status = await handlers.GET_STATUS(new Request("http://localhost"), {
      params: Promise.resolve({ id: "review-1" }),
    });
    expect(status.status).toBe(200);
    expect(await json(status)).toMatchObject({
      data: { job: { id: "job-1", status: "queued" } },
    });
  });

  it("analyze 在没有图片时拒绝创建后台任务", async () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    const analysisJobService = { enqueue: vi.fn(), getForReview: vi.fn(() => null) };
    const handlers = createAnalyzeRouteHandlers({
      reviewService,
      analysisJobService: analysisJobService as never,
      ownerId: OWNER_ID,
    });

    const response = await handlers.POST(new Request("http://localhost"), {
      params: Promise.resolve({ id: "review-1" }),
    });

    expect(response.status).toBe(422);
    expect(await json(response)).toMatchObject({ error: { code: "IMAGES_REQUIRED" } });
    expect(analysisJobService.enqueue).not.toHaveBeenCalled();
  });

  it("content_only 在没有 OCR v2 时同步返回升级冲突且不创建任务", async () => {
    repository.create(OWNER_ID, {
      id: "review-1",
      config,
      images: [{
        position: 0,
        originalName: "page.jpg",
        mimeType: "image/jpeg",
        originalPath: "images/page-original.jpg",
        annotationPath: "images/page-annotation.jpg",
        aiPath: "images/page-ai.jpg",
        width: 60,
        height: 80,
        rotation: 0,
        crop: null,
      }],
    });
    const jobs = new AnalysisJobRepository(drizzle(sqlite, { schema }), {
      createId: () => "job-content-only",
    });
    const handlers = createAnalyzeRouteHandlers({
      reviewService,
      analysisJobService: new AnalysisJobService(jobs),
      ownerId: OWNER_ID,
    });

    const response = await handlers.POST(jsonRequest(
      "http://localhost/api/reviews/review-1/analyze",
      "POST",
      { mode: "content_only" },
    ), { params: Promise.resolve({ id: "review-1" }) });

    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ error: { code: "OCR_V2_REQUIRED" } });
    expect(jobs.findLatestByReview(OWNER_ID, "review-1")).toBeNull();
  });
});

describe("reanalysis route handlers", () => {
  const revisionInput = {
    expectedRevision: 3,
    reason: "结尾没有扣题",
    changeRequest: "重新分析结尾并保留有效细节",
  };
  const commitItem = {
    reviewId: "review-1",
    expectedRevision: 3,
    assignmentId: "assignment-1",
    expectedAssignmentUpdatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("退回重分析合法请求返回 202，并使用路径 id 与解析后的字段", async () => {
    const result = {
      newlyQueued: true as const,
      job: {
        id: "job-1",
        reviewId: "review-from-path",
        mode: "content_only" as const,
        status: "queued" as const,
        progressStage: "queued" as const,
        message: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        finishedAt: null,
      },
    };
    const requestRevision = vi.fn(() => result);
    const handlers = createRevisionRequestRouteHandlers({
      reanalysisService: { requestRevision },
      ownerId: OWNER_ID,
    });

    const response = await handlers.POST(
      jsonRequest("http://localhost/api/reviews/review-from-path/revision-request", "POST", revisionInput),
      { params: Promise.resolve({ id: "review-from-path" }) },
    );

    expect(response.status).toBe(202);
    expect(await json(response)).toEqual({ ok: true, data: result });
    expectNoStore(response);
    expect(requestRevision).toHaveBeenCalledWith(
      OWNER_ID,
      "review-from-path",
      revisionInput,
    );
  });

  it("批量预览返回 200，并保持 reviewIds 原顺序传给 service", async () => {
    const result = { matched: [], skipped: [] };
    const preview = vi.fn(() => result);
    const handlers = createBatchReanalysisPreviewRouteHandlers({
      reanalysisService: { preview },
      ownerId: OWNER_ID,
    });
    const reviewIds = ["review-2", "review-1"];

    const response = await handlers.POST(
      jsonRequest("http://localhost/api/reanalysis/preview", "POST", { reviewIds }),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true, data: result });
    expectNoStore(response);
    expect(preview).toHaveBeenCalledWith(OWNER_ID, reviewIds);
  });

  it("批量确认返回 submitted/skipped partial success", async () => {
    const items = [commitItem];
    const result = {
      submitted: [{ reviewId: "review-1", jobId: "job-1", revision: 4 }],
      skipped: [{
        reviewId: "review-2",
        code: "REVISION_CONFLICT" as const,
        reason: "作文已更新，请重新预览",
      }],
    };
    const commitBatch = vi.fn(() => result);
    const handlers = createBatchReanalysisRouteHandlers({
      reanalysisService: { commitBatch },
      ownerId: OWNER_ID,
    });

    const response = await handlers.POST(
      jsonRequest("http://localhost/api/reanalysis", "POST", { items }),
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true, data: result });
    expectNoStore(response);
    expect(commitBatch).toHaveBeenCalledWith(OWNER_ID, items);
  });

  it.each([
    ["revision JSON", "revision"],
    ["revision body", "revision-body"],
    ["revision unknown field", "revision-unknown"],
    ["revision missing field", "revision-missing"],
    ["revision invalid id", "revision-id"],
    ["revision missing id", "revision-id-type"],
    ["preview duplicate ids", "preview-duplicate"],
    ["preview over limit", "preview-limit"],
    ["preview invalid id", "preview-id"],
    ["commit duplicate ids", "commit-duplicate"],
    ["commit over limit", "commit-limit"],
    ["commit invalid timestamp", "commit-timestamp"],
  ])("%s 返回 400 且 service 不被调用", async (_name, kind) => {
    const requestRevision = vi.fn();
    const preview = vi.fn();
    const commitBatch = vi.fn();
    const revisionHandlers = createRevisionRequestRouteHandlers({
      reanalysisService: { requestRevision },
      ownerId: OWNER_ID,
    });
    const previewHandlers = createBatchReanalysisPreviewRouteHandlers({
      reanalysisService: { preview },
      ownerId: OWNER_ID,
    });
    const commitHandlers = createBatchReanalysisRouteHandlers({
      reanalysisService: { commitBatch },
      ownerId: OWNER_ID,
    });
    let response: Response;
    if (kind === "revision") {
      response = await revisionHandlers.POST(
        new Request("http://localhost", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
        { params: Promise.resolve({ id: "review-1" }) },
      );
    } else if (kind === "revision-body") {
      response = await revisionHandlers.POST(
        jsonRequest("http://localhost", "POST", null),
        { params: Promise.resolve({ id: "review-1" }) },
      );
    } else if (kind === "revision-unknown") {
      response = await revisionHandlers.POST(
        jsonRequest("http://localhost", "POST", { ...revisionInput, extra: true }),
        { params: Promise.resolve({ id: "review-1" }) },
      );
    } else if (kind === "revision-missing") {
      response = await revisionHandlers.POST(
        jsonRequest("http://localhost", "POST", {
          expectedRevision: revisionInput.expectedRevision,
          reason: revisionInput.reason,
        }),
        { params: Promise.resolve({ id: "review-1" }) },
      );
    } else if (kind === "revision-id") {
      response = await revisionHandlers.POST(
        jsonRequest("http://localhost", "POST", revisionInput),
        { params: Promise.resolve({ id: "review/1" }) },
      );
    } else if (kind === "revision-id-type") {
      response = await revisionHandlers.POST(
        jsonRequest("http://localhost", "POST", revisionInput),
        { params: Promise.resolve({ id: undefined as never }) },
      );
    } else if (kind === "preview-duplicate") {
      response = await previewHandlers.POST(
        jsonRequest("http://localhost", "POST", { reviewIds: ["review-1", "review-1"] }),
      );
    } else if (kind === "preview-limit") {
      response = await previewHandlers.POST(
        jsonRequest("http://localhost", "POST", {
          reviewIds: Array.from({ length: 21 }, (_, index) => `review-${index}`),
        }),
      );
    } else if (kind === "preview-id") {
      response = await previewHandlers.POST(
        jsonRequest("http://localhost", "POST", { reviewIds: ["review/1"] }),
      );
    } else if (kind === "commit-duplicate") {
      response = await commitHandlers.POST(
        jsonRequest("http://localhost", "POST", { items: [commitItem, commitItem] }),
      );
    } else if (kind === "commit-limit") {
      response = await commitHandlers.POST(
        jsonRequest("http://localhost", "POST", {
          items: Array.from({ length: 21 }, (_, index) => ({
            ...commitItem,
            reviewId: `review-${index}`,
          })),
        }),
      );
    } else {
      response = await commitHandlers.POST(
        jsonRequest("http://localhost", "POST", {
          items: [{ ...commitItem, expectedAssignmentUpdatedAt: "not-a-timestamp" }],
        }),
      );
    }
    expect(response.status).toBe(400);
    expectNoStore(response);
    expect(requestRevision).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    expect(commitBatch).not.toHaveBeenCalled();
  });

  it("业务错误映射为稳定安全响应，并继续返回 no-store", async () => {
    const conflictService = {
      requestRevision: vi.fn(() => {
        throw Object.assign(new Error("SQLITE path / secret"), {
          code: "REVISION_CONFLICT",
          status: 409,
        });
      }),
    };
    const conflictHandlers = createRevisionRequestRouteHandlers({
      reanalysisService: conflictService,
      ownerId: OWNER_ID,
    });
    const conflict = await conflictHandlers.POST(
      jsonRequest("http://localhost", "POST", revisionInput),
      { params: Promise.resolve({ id: "review-1" }) },
    );
    expect(conflict.status).toBe(409);
    const conflictBody = await json(conflict);
    expect(conflictBody).toMatchObject({
      ok: false,
      error: { code: "REVISION_CONFLICT", message: "作文已更新，请重新预览" },
    });
    expect(JSON.stringify(conflictBody)).not.toContain("SQLITE path / secret");
    expectNoStore(conflict);

    const notFoundHandlers = createRevisionRequestRouteHandlers({
      reanalysisService: {
        requestRevision: vi.fn(() => {
          throw Object.assign(new Error("owner or path details"), {
            code: "REVIEW_NOT_FOUND",
            status: 404,
          });
        }),
      },
      ownerId: OWNER_ID,
    });
    const notFound = await notFoundHandlers.POST(
      jsonRequest("http://localhost", "POST", revisionInput),
      { params: Promise.resolve({ id: "review-1" }) },
    );
    expect(notFound.status).toBe(404);
    const notFoundBody = await json(notFound);
    expect(notFoundBody).toMatchObject({
      ok: false,
      error: { code: "REVIEW_NOT_FOUND", message: "批改记录不存在" },
    });
    expectNoStore(notFound);

    const unknownHandlers = createRevisionRequestRouteHandlers({
      reanalysisService: {
        requestRevision: vi.fn(() => {
          throw new Error("SQLITE /Users/micky/secret.db");
        }),
      },
      ownerId: OWNER_ID,
    });
    const unknown = await unknownHandlers.POST(
      jsonRequest("http://localhost", "POST", revisionInput),
      { params: Promise.resolve({ id: "review-1" }) },
    );
    expect(unknown.status).toBe(500);
    const unknownBody = await json(unknown);
    expect(unknownBody).toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" },
    });
    expect(JSON.stringify(unknownBody)).not.toContain("/Users/micky/secret.db");
    expectNoStore(unknown);
  });

  it("未知原型键错误不会误命中错误映射", async () => {
    const handlers = createRevisionRequestRouteHandlers({
      reanalysisService: {
        requestRevision: vi.fn(() => {
          throw Object.assign(new Error("prototype lookup detail"), {
            code: "toString",
          });
        }),
      },
      ownerId: OWNER_ID,
    });

    const response = await handlers.POST(
      jsonRequest("http://localhost", "POST", revisionInput),
      { params: Promise.resolve({ id: "review-1" }) },
    );

    expect(response.status).toBe(500);
    expect(await json(response)).toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "服务暂时不可用" },
    });
    expectNoStore(response);
  });
});
