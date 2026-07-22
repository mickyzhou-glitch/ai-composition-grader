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
import { ReviewService, type AiReviewer } from "../services/review-service";
import { ReviewFileStore } from "../storage/review-file-store";
import {
  createAnalyzeRouteHandlers,
  createReviewImagesRouteHandlers,
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
  scores: {
    themeIntent: 9,
    contentSelection: 9,
    structure: 7,
    languageExpression: 7,
    writingConventions: 4,
    total: 36,
    level: "优秀作文" as const,
  },
  sampleParagraphs: Array.from({ length: 5 }, (_, index) => ({
    title: `第 ${index + 1} 段`,
    text: "我".repeat(110),
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
      jsonRequest("http://localhost/api/reviews", "POST", { config }),
    );
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({
      ok: true,
      data: { id: "review-1", status: "draft" },
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

  it("multipart 一次上传三图并保存处理后的字段", async () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    const pixels = await sharp({
      create: { width: 60, height: 80, channels: 3, background: "white" },
    }).jpeg().toBuffer();
    const form = new FormData();
    form.append("expectedRevision", "0");
    form.append("privacyConfirmed", "true");
    form.append("privacyNoticeVersion", "2026-07-22");
    for (let index = 0; index < 3; index += 1) {
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
    expect((body.data as { images: unknown[] }).images).toHaveLength(3);
    expect(repository.getById(OWNER_ID, "review-1")?.images[2]).toMatchObject({
      position: 2,
      originalName: "page-3.jpg",
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
      { originalName: "page-3.jpg", position: 0 },
      { originalName: "page-2.jpg", position: 1 },
      {
        originalName: "page-1.jpg",
        position: 2,
        rotation: 90,
        crop: { x: 0, y: 0, width: 0.5, height: 1 },
        width: 40,
        height: 60,
      },
    ]);
  });

  it("首次上传必须由服务端验证隐私确认，并记录版本与到期时间", async () => {
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
      expiresAt: expect.any(Date),
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

    const response = await handlers.POST(new Request("http://localhost"), {
      params: Promise.resolve({ id: "review-1" }),
    });
    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({
      data: { id: "job-1", status: "queued", progressStage: "queued" },
    });
    expect(analysisJobService.enqueue).toHaveBeenCalledWith(OWNER_ID, "review-1");
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
});
