// @vitest-environment node

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AssignmentConfig } from "../domain/contracts";
import { EMPTY_DRAFT_RETENTION_MS, REVIEW_RETENTION_MS } from "../domain/contracts";
import { AuthRepository } from "../auth/auth-repository";
import { initializeSchema } from "../db/init";
import { ReviewRepository, type ReviewImageInput } from "../db/review-repository";
import * as schema from "../db/schema";
import { ImageService } from "../images/image-service";
import { InMemoryReviewLock } from "../services/review-lock";
import { ReviewFileStore, UnsafeStoragePathError } from "../storage/review-file-store";
import { RetentionService } from "./retention-service";

const OWNER = "local-admin";
const OTHER_OWNER = "teacher-02";
const START = new Date("2026-07-01T00:00:00.000Z");

const config: AssignmentConfig = {
  title: "为自己喝彩",
  grade: "上海五四学制六年级",
  writingRequirements: "写一件亲身经历的事。",
  targetCharacters: 600,
  structureRequirements: "开头点题，结尾升华。",
  scoringFocus: "细节描写。",
  templateType: "preset_self_applause",
};

function image(position = 0): ReviewImageInput {
  return {
    position,
    originalName: `page-${position}.jpg`,
    mimeType: "image/jpeg",
    originalPath: `images/page-${position}-original.jpg`,
    annotationPath: `images/page-${position}-annotation.jpg`,
    aiPath: `images/page-${position}-ai.jpg`,
    width: 1200,
    height: 1600,
    rotation: 0,
    crop: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("RetentionService", () => {
  let sqlite: Database.Database;
  let database: ReturnType<typeof drizzle<typeof schema>>;
  let repository: ReviewRepository;
  let audit: AuthRepository;
  let store: ReviewFileStore;
  let temporaryDirectory: string;
  let now: Date;

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    initializeSchema(sqlite);
    // Retention tests exercise ownership as well as deletion path precision.
    sqlite.prepare(
      `INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at)
       VALUES (?, ?, '!test', 'teacher', 0, ?, ?)`,
    ).run(OTHER_OWNER, OTHER_OWNER, START.valueOf(), START.valueOf());
    database = drizzle(sqlite, { schema });
    now = new Date(START);
    repository = new ReviewRepository(database, { now: () => new Date(now) });
    audit = new AuthRepository(database, { now: () => new Date(now) });
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "grader-retention-"));
    store = new ReviewFileStore(path.join(temporaryDirectory, "users"));
  });

  afterEach(async () => {
    sqlite.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  function service(fileStore = store): RetentionService {
    return new RetentionService(repository, fileStore, {
      now: () => new Date(now),
      audit,
    });
  }

  async function createWithImage(ownerId = OWNER, id = "review-1"): Promise<void> {
    repository.create(ownerId, { id, config, images: [image()] });
    await store.writeFile(ownerId, id, "images", "page.jpg", "page");
  }

  it("首次上传图片时设置 30 天到期日，后续替换图片不延长", () => {
    repository.create(OWNER, { id: "review-1", config });
    now = new Date(START.valueOf() + 2 * 60 * 60 * 1000);
    const first = repository.replaceImages(OWNER, "review-1", 0, [image()]);
    const firstExpiry = first.expiresAt?.valueOf();
    expect(firstExpiry).toBe(now.valueOf() + REVIEW_RETENTION_MS);

    now = new Date(now.valueOf() + 7 * 24 * 60 * 60 * 1000);
    const second = repository.replaceImages(OWNER, "review-1", first.revision, [image(), image(1)]);
    expect(second.expiresAt?.valueOf()).toBe(firstExpiry);
  });

  it("仅在严格超过 24 小时后清理空草稿", async () => {
    repository.create(OWNER, { id: "empty", config });
    now = new Date(START.valueOf() + EMPTY_DRAFT_RETENTION_MS);
    expect(service().inspect()).toEqual([]);

    now = new Date(now.valueOf() + 1);
    await expect(service().run()).resolves.toMatchObject({ deleted: 1, failed: 0 });
    expect(repository.getById(OWNER, "empty")).toBeNull();
  });

  it("到期作文先标记并从普通查询消失，再删除其精确目录", async () => {
    await createWithImage();
    now = new Date(START.valueOf() + REVIEW_RETENTION_MS);
    const deletingSpy = vi.spyOn(store, "deleteReview").mockImplementation(async (ownerId, reviewId) => {
      expect(repository.getById(ownerId, reviewId)).toBeNull();
      await ReviewFileStore.prototype.deleteReview.call(store, ownerId, reviewId);
    });

    await expect(service().run()).resolves.toMatchObject({ inspected: 1, claimed: 1, deleted: 1, failed: 0 });
    expect(deletingSpy).toHaveBeenCalledWith(OWNER, "review-1");
    await expect(stat(store.getReviewPaths(OWNER, "review-1").reviewDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(repository.list(OWNER)).toEqual([]);
  });

  it("文件已删而数据库收尾失败时保留标记，并在下一次继续完成", async () => {
    await createWithImage();
    now = new Date(START.valueOf() + REVIEW_RETENTION_MS);
    sqlite.exec(`
      CREATE TRIGGER reject_review_delete
      BEFORE DELETE ON reviews
      BEGIN SELECT RAISE(ABORT, 'forced DB failure'); END;
    `);

    await expect(service().run()).resolves.toMatchObject({ deleted: 0, failed: 1 });
    expect(repository.getById(OWNER, "review-1")).toBeNull();
    expect(service().inspect()).toEqual([
      expect.objectContaining({ id: "review-1", ownerId: OWNER, deletingAt: expect.any(Date) }),
    ]);
    await expect(stat(store.getReviewPaths(OWNER, "review-1").reviewDirectory)).rejects.toMatchObject({ code: "ENOENT" });

    sqlite.exec("DROP TRIGGER reject_review_delete");
    await expect(service().run()).resolves.toMatchObject({ inspected: 1, claimed: 1, deleted: 1, failed: 0 });
    expect(repository.getById(OWNER, "review-1")).toBeNull();
    expect(service().inspect()).toEqual([]);
  });

  it("标记成功但文件删除失败时保留标记并在下次重试", async () => {
    await createWithImage();
    now = new Date(START.valueOf() + REVIEW_RETENTION_MS);
    const deletingSpy = vi.spyOn(store, "deleteReview")
      .mockRejectedValueOnce(Object.assign(new Error("disk busy"), { code: "EIO" }));

    await expect(service().run()).resolves.toMatchObject({ deleted: 0, failed: 1, errors: [{ id: "review-1", ownerId: OWNER, code: "EIO" }] });
    expect(repository.getById(OWNER, "review-1")).toBeNull();
    expect(service().inspect()).toHaveLength(1);

    deletingSpy.mockRestore();
    await expect(service().run()).resolves.toMatchObject({ deleted: 1, failed: 0 });
    await expect(stat(store.getReviewPaths(OWNER, "review-1").reviewDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("手动删除使用同一状态机、取消活动任务且不触及其他教师目录", async () => {
    await createWithImage(OWNER, "review-owner");
    await createWithImage(OTHER_OWNER, "review-other");
    database.insert(schema.analysisJobs).values({
      id: "job-1",
      reviewId: "review-owner",
      ownerId: OWNER,
      status: "running",
      attempt: 1,
      availableAt: now,
      leaseExpiresAt: now,
      progressStage: "reading_images",
      errorCode: null,
      message: null,
      createdAt: now,
      startedAt: now,
      finishedAt: null,
    }).run();

    await expect(service().delete(OWNER, "review-owner")).resolves.toBeUndefined();
    expect(repository.getById(OWNER, "review-owner")).toBeNull();
    expect(repository.getById(OTHER_OWNER, "review-other")?.id).toBe("review-other");
    await expect(store.readFile(OTHER_OWNER, "review-other", "images", "page.jpg")).resolves.toEqual(Buffer.from("page"));
    expect(sqlite.prepare("SELECT count(*) AS count FROM analysis_jobs WHERE id = 'job-1'").get()).toEqual({ count: 0 });
  });

  it("拒绝不安全的 owner 或 review 路径，且不会递归到 storage 根目录", async () => {
    await expect(service().delete("../outside", "review-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await createWithImage();
    const unsafeStore = {
      ...store,
      deleteReview: async () => { throw new UnsafeStoragePathError("../outside"); },
    } as unknown as ReviewFileStore;
    now = new Date(START.valueOf() + REVIEW_RETENTION_MS);
    await expect(service(unsafeStore).run()).resolves.toMatchObject({ failed: 1 });
    await expect(store.readFile(OWNER, "review-1", "images", "page.jpg")).resolves.toEqual(Buffer.from("page"));
  });

  it("清理先迁移仅存在于旧目录的作文，再永久删除旧目录", async () => {
    const legacyRoot = path.join(temporaryDirectory, "legacy-reviews");
    const legacyReview = path.join(legacyRoot, "legacy-only");
    repository.create(OWNER, { id: "legacy-only", config, images: [image()] });
    await mkdir(path.join(legacyReview, "images"), { recursive: true });
    await writeFile(path.join(legacyReview, "images", "page.jpg"), "legacy");
    const legacyStore = new ReviewFileStore(store.rootDirectory, legacyRoot);
    now = new Date(START.valueOf() + REVIEW_RETENTION_MS);

    await expect(service(legacyStore).run()).resolves.toMatchObject({ deleted: 1, failed: 0 });
    await expect(stat(legacyReview)).rejects.toMatchObject({ code: "ENOENT" });
    expect(repository.getById(OWNER, "legacy-only")).toBeNull();
  });

  it("清理失败仅记录安全错误码，不记录作文路径或正文", async () => {
    await createWithImage();
    now = new Date(START.valueOf() + REVIEW_RETENTION_MS);
    vi.spyOn(store, "deleteReview").mockRejectedValueOnce(Object.assign(new Error("disk busy"), { code: "EIO" }));

    await service().run();
    const event = sqlite.prepare(
      "SELECT user_id AS userId, event_type AS eventType, metadata FROM security_events ORDER BY id DESC LIMIT 1",
    ).get() as { userId: string; eventType: string; metadata: string } | undefined;
    expect(event).toMatchObject({ userId: OWNER, eventType: "retention.delete_failed" });
    expect(event?.metadata).toContain("EIO");
    expect(event?.metadata).not.toContain("page.jpg");
    expect(event?.metadata).not.toContain(store.rootDirectory);
  });

  it("清理和上传共用同一作文锁，删除完成后上传得到不存在且不会重建目录", async () => {
    await createWithImage();
    now = new Date(START.valueOf() + REVIEW_RETENTION_MS);
    const lock = new InMemoryReviewLock();
    const blockingDelete = deferred<void>();
    const enteredDelete = deferred<void>();
    vi.spyOn(store, "deleteReview").mockImplementationOnce(async () => {
      enteredDelete.resolve();
      await blockingDelete.promise;
      await ReviewFileStore.prototype.deleteReview.call(store, OWNER, "review-1");
    });
    const imageService = new ImageService(store, repository, { lock, createId: () => "new-image" });
    const cleanup = new RetentionService(repository, store, { now: () => new Date(now), lock }).run();
    await enteredDelete.promise;
    const jpeg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "white" } }).jpeg().toBuffer();
    const upload = imageService.upload(OWNER, "review-1", 0, [{
      originalName: "new.jpg",
      mimeType: "image/jpeg",
      data: jpeg,
    }]).then(
      () => null,
      (error: unknown) => error,
    );

    blockingDelete.resolve();
    await expect(cleanup).resolves.toMatchObject({ deleted: 1, failed: 0 });
    await expect(upload).resolves.toMatchObject({ code: "REVIEW_NOT_FOUND", status: 404 });
    await expect(stat(store.getReviewPaths(OWNER, "review-1").reviewDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("并发清理与手动删除在另一方已完成时均视为幂等成功", async () => {
    await createWithImage();
    now = new Date(START.valueOf() + REVIEW_RETENTION_MS);
    const lock = new InMemoryReviewLock();
    const blockingDelete = deferred<void>();
    const enteredDelete = deferred<void>();
    vi.spyOn(store, "deleteReview").mockImplementationOnce(async () => {
      enteredDelete.resolve();
      await blockingDelete.promise;
      await ReviewFileStore.prototype.deleteReview.call(store, OWNER, "review-1");
    });
    const retained = new RetentionService(repository, store, { now: () => new Date(now), lock });
    const scheduled = retained.run();
    await enteredDelete.promise;
    const manual = retained.delete(OWNER, "review-1");

    blockingDelete.resolve();
    await expect(scheduled).resolves.toMatchObject({ deleted: 1, failed: 0 });
    await expect(manual).resolves.toBeUndefined();
  });
});
