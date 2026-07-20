// @vitest-environment node

import { mkdtemp, rm, stat } from "node:fs/promises";
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
import { ImageService } from "../images/image-service";
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
  sampleParagraphs: Array.from({ length: 5 }, () => "我".repeat(110)),
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
      save: vi.fn(),
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
    const settingsService = {
      get: vi.fn(),
      getSecret: vi.fn(),
      save: vi.fn(async () => {
        calls.push("save");
        return { baseUrl: "https://ai.test/v1", model: "m", keyConfigured: true };
      }),
    };
    const handlers = createSettingsRouteHandlers({
      settingsService,
      testConnection: vi.fn(async () => calls.push("test")),
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
    expect(settingsService.save).toHaveBeenCalledWith({
      baseUrl: "https://ai.test/v1",
      model: "m",
      apiKey: "new-key",
    });
  });

  it("PUT 连接测试失败时不保存候选设置", async () => {
    const settingsService = {
      get: vi.fn(),
      getSecret: vi.fn(),
      save: vi.fn(),
    };
    const handlers = createSettingsRouteHandlers({
      settingsService,
      testConnection: vi.fn(async () => {
        throw Object.assign(new Error("provider failed"), {
          code: "AI_REQUEST_FAILED",
          status: 502,
        });
      }),
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
    expect(settingsService.save).not.toHaveBeenCalled();
  });

  it("POST /test 测试失败不保存并返回 502", async () => {
    const settingsService = {
      get: vi.fn(),
      getSecret: vi.fn(),
      save: vi.fn(),
    };
    const handlers = createSettingsRouteHandlers({
      settingsService,
      testConnection: vi.fn(async () => {
        throw Object.assign(new Error("provider failed"), {
          code: "AI_REQUEST_FAILED",
          status: 502,
        });
      }),
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
    expect(settingsService.save).not.toHaveBeenCalled();
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
    const collection = createReviewsRouteHandlers({ reviewService });
    const item = createReviewRouteHandlers({ reviewService });

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
        config: { ...config, title: "不应保存" },
        status: "ready_for_review",
      }),
      { params: Promise.resolve({ id: "review-1" }) },
    );
    expect(illegalStatus.status).toBe(400);
    expect(repository.getById("review-1")).toMatchObject({
      status: "draft",
      config: { title: "我为自己喝彩" },
    });

    const teacherReview = await item.PATCH(
      jsonRequest("http://localhost/api/reviews/review-1", "PATCH", {
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
    expect(repository.getById("review-1")).toMatchObject({
      status: "ready_for_review",
      report,
      annotations: [{ category: "sentence" }],
    });

    const reviewDirectory = fileStore.getReviewPaths("review-1").reviewDirectory;
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

  it("multipart 一次上传三图并保存处理后的字段", async () => {
    repository.create({ id: "review-1", config });
    const pixels = await sharp({
      create: { width: 60, height: 80, channels: 3, background: "white" },
    }).jpeg().toBuffer();
    const form = new FormData();
    for (let index = 0; index < 3; index += 1) {
      form.append("images", new File([pixels], `page-${index + 1}.jpg`, { type: "image/jpeg" }));
    }
    const handlers = createReviewImagesRouteHandlers({ imageService });

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
    expect(repository.getById("review-1")?.images[2]).toMatchObject({
      position: 2,
      originalName: "page-3.jpg",
      width: 60,
      height: 80,
    });

    const current = repository.getById("review-1")?.images ?? [];
    const patched = await handlers.PATCH(
      jsonRequest("http://localhost/api/reviews/review-1/images", "PATCH", {
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
    expect(repository.getById("review-1")?.images).toMatchObject([
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

  it("analyze 保存 report/annotations 并管理成功和不可辨认状态", async () => {
    repository.create({ id: "review-1", config });
    await imageService.upload("review-1", [
      {
        originalName: "page.jpg",
        mimeType: "image/jpeg",
        data: await sharp({
          create: { width: 60, height: 80, channels: 3, background: "white" },
        }).jpeg().toBuffer(),
      },
    ]);
    const handlers = createAnalyzeRouteHandlers({ reviewService });

    const ready = await handlers.POST(new Request("http://localhost"), {
      params: Promise.resolve({ id: "review-1" }),
    });
    expect(ready.status).toBe(200);
    expect(repository.getById("review-1")).toMatchObject({
      status: "ready_for_review",
      report,
    });
    expect(analyze.mock.calls[0][0].imageDataUrls[0]).toMatch(/^data:image\/jpeg;base64,/);

    aiResult = {
      readable: false,
      pageWarnings: ["第 1 页模糊，请重拍。"],
      annotations: [],
    };
    await handlers.POST(new Request("http://localhost"), {
      params: Promise.resolve({ id: "review-1" }),
    });
    expect(repository.getById("review-1")).toMatchObject({
      status: "needs_better_images",
      report: null,
      annotations: [],
    });
  });

  it("AI 失败后将状态落为 failed 并返回 502", async () => {
    repository.create({ id: "review-1", config });
    await imageService.upload("review-1", [
      {
        originalName: "page.jpg",
        mimeType: "image/jpeg",
        data: await sharp({
          create: { width: 10, height: 10, channels: 3, background: "white" },
        }).jpeg().toBuffer(),
      },
    ]);
    analyze.mockRejectedValueOnce(
      Object.assign(new Error("bad provider"), {
        code: "AI_REQUEST_FAILED",
        status: 502,
      }),
    );
    const handlers = createAnalyzeRouteHandlers({ reviewService });

    const response = await handlers.POST(new Request("http://localhost"), {
      params: Promise.resolve({ id: "review-1" }),
    });

    expect(response.status).toBe(502);
    expect(repository.getById("review-1")?.status).toBe("failed");
  });
});
