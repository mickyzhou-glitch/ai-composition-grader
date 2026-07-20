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
import { ReviewFileStore } from "../storage/review-file-store";
import { ReviewService } from "./review-service";

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
    scores: {
      themeIntent: 9,
      contentSelection: 9,
      structure: 7,
      languageExpression: 7,
      writingConventions: 4,
      total: 36,
      level: "优秀作文",
    },
    sampleParagraphs: Array.from({ length: 5 }, () => "我".repeat(110)),
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
    repository.create({ id: "review-1", config });
    await fileStore.writeFile("review-1", "images", "page-original.jpg", "original");
    await fileStore.writeFile("review-1", "images", "page-annotation.jpg", "annotation");
    await fileStore.writeFile("review-1", "images", "page-ai.jpg", "ai");
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
    repository.replaceImages("review-1", [image]);
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

  it("分析期间改配置时丢弃旧结果且保持新配置的 draft", async () => {
    const ai = deferred<AiReviewEnvelope>();
    const analyze = vi.fn(() => ai.promise);
    const service = serviceFor(analyze);

    const pending = service.analyze("review-1");
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    service.update("review-1", { config: { ...config, title: "新题目" } });
    ai.resolve(readyEnvelope);

    await expect(pending).rejects.toMatchObject({ code: "ANALYSIS_CONFLICT" });
    expect(repository.getById("review-1")).toMatchObject({
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

    const pending = service.analyze("review-1");
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    const edited = service.update("review-1", edits);
    ai.resolve(readyEnvelope);

    expect(edited).toMatchObject({
      revision: 2,
      analysisRunId: null,
      ...saved,
    });
    await expect(pending).rejects.toMatchObject({ code: "ANALYSIS_CONFLICT" });
    expect(repository.getById("review-1")).toMatchObject({
      revision: 2,
      analysisRunId: null,
      ...saved,
    });
  });

  it("分析期间换图时旧结果不能覆盖新图片状态", async () => {
    const ai = deferred<AiReviewEnvelope>();
    const analyze = vi.fn(() => ai.promise);
    const service = serviceFor(analyze);

    const pending = service.analyze("review-1");
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    repository.replaceImages("review-1", [{ ...image, originalName: "new.jpg" }]);
    ai.resolve(readyEnvelope);

    await expect(pending).rejects.toMatchObject({ code: "ANALYSIS_CONFLICT" });
    expect(repository.getById("review-1")).toMatchObject({
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

    const firstPending = service.analyze("review-1");
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    const secondPending = service.analyze("review-1");
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));
    first.resolve(readyEnvelope);

    await expect(firstPending).rejects.toMatchObject({ code: "ANALYSIS_CONFLICT" });
    expect(repository.getById("review-1")).toMatchObject({
      status: "analyzing",
      analysisRunId: "run-2",
    });
    second.resolve(readyEnvelope);
    await expect(secondPending).resolves.toMatchObject({
      review: { status: "ready_for_review", analysisRunId: null },
    });
  });

  it("DELETE 的数据库步骤失败时恢复已暂存的 review 目录", async () => {
    const service = serviceFor(async () => readyEnvelope);
    vi.spyOn(repository, "delete").mockImplementation(() => {
      throw new Error("database delete failed");
    });

    await expect(service.delete("review-1")).rejects.toThrow(
      "database delete failed",
    );

    expect(repository.getById("review-1")).not.toBeNull();
    await expect(
      fileStore.readFile("review-1", "images", "page-ai.jpg"),
    ).resolves.toEqual(Buffer.from("ai"));
  });

  it("首次异步操作等待启动恢复后再读取仍存在于 DB 的 review 文件", async () => {
    await fileStore.stageDelete("review-1");
    const analyze = vi.fn(async () => readyEnvelope);
    const service = serviceFor(analyze);

    await expect(service.analyze("review-1")).resolves.toMatchObject({
      review: { status: "ready_for_review" },
    });

    expect(analyze).toHaveBeenCalledOnce();
  });

  it("DB 删除成功后 trash 清理失败仍返回成功并留给下一次启动恢复", async () => {
    const stageDelete = fileStore.stageDelete.bind(fileStore);
    vi.spyOn(fileStore, "stageDelete").mockImplementation(async (reviewId) => {
      const staged = await stageDelete(reviewId);
      return {
        rollback: staged.rollback,
        commit: async () => {
          throw new Error("trash cleanup failed");
        },
      };
    });
    const service = serviceFor(async () => readyEnvelope);

    await expect(service.delete("review-1")).resolves.toBeUndefined();

    expect(repository.getById("review-1")).toBeNull();
    await expect(
      readdir(path.join(fileStore.rootDirectory, ".trash")),
    ).resolves.toHaveLength(1);

    const restarted = serviceFor(async () => readyEnvelope);
    await restarted.create(config);
    await expect(
      readdir(path.join(fileStore.rootDirectory, ".trash")),
    ).resolves.toEqual([]);
  });
});
