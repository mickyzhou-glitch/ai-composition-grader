// @vitest-environment node

import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReviewFileStore, UnsafeStoragePathError } from "./review-file-store";

const OWNER = "teacher-01";
const REVIEW = "review-1";

describe("ReviewFileStore", () => {
  let temporaryDirectory: string;
  let store: ReviewFileStore;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "grader-storage-"));
    store = new ReviewFileStore(path.join(temporaryDirectory, "users"));
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("按 owner 隔离作文目录并可读写", async () => {
    const paths = await store.createReview(OWNER, REVIEW);
    await store.writeFile(OWNER, REVIEW, "images", "page-1.jpg", Buffer.from("image"));
    await store.writeFile(OWNER, REVIEW, "pdf", "report.pdf", Buffer.from("pdf"));
    expect(paths.reviewDirectory).toBe(path.join(store.rootDirectory, OWNER, "reviews", REVIEW));
    expect((await stat(paths.imagesDirectory)).isDirectory()).toBe(true);
    await expect(store.readFile(OWNER, REVIEW, "images", "page-1.jpg")).resolves.toEqual(Buffer.from("image"));
    await expect(store.readFile("teacher-02", REVIEW, "images", "page-1.jpg")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("以 0700 权限创建 storage root", async () => {
    await store.createReview(OWNER, REVIEW);
    expect((await stat(store.rootDirectory)).mode & 0o777).toBe(0o700);
  });

  it("并发首次写入不因 EEXIST 失败", async () => {
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.writeFile(OWNER, REVIEW, "images", `page-${index}.txt`, `${index}`)));
    await expect(Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.readFile(OWNER, REVIEW, "images", `page-${index}.txt`)))).resolves.toHaveLength(20);
  });

  it.each([
    ["../outside", "images", "page.jpg"],
    ["teacher/../../outside", "images", "page.jpg"],
    ["/tmp/outside", "images", "page.jpg"],
    [OWNER, "images", "../outside.jpg"],
    [OWNER, "pdf", "folder/outside.pdf"],
  ] as const)("拒绝路径穿越 owner=%s kind=%s filename=%s", async (ownerId, kind, filename) => {
    await expect(store.writeFile(ownerId, REVIEW, kind, filename, Buffer.from("secret"))).rejects.toBeInstanceOf(UnsafeStoragePathError);
  });

  it("只递归删除指定 owner 的 review", async () => {
    await store.writeFile(OWNER, REVIEW, "images", "page.jpg", "one");
    await store.createReview("teacher-02", REVIEW);
    await store.deleteReview(OWNER, REVIEW);
    await expect(stat(store.getReviewPaths(OWNER, REVIEW).reviewDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(store.getReviewPaths("teacher-02", REVIEW).reviewDirectory)).isDirectory()).toBe(true);
  });

  it("清理队列带 owner 且不触及其他文件", async () => {
    await store.writeFile(OWNER, REVIEW, "pdf", "old.pdf", "old-pdf");
    await store.writeFile(OWNER, REVIEW, "pdf", "keep.pdf", "keep-pdf");
    await store.writeFile(OWNER, REVIEW, "images", "old.pdf", "image");
    await store.queuePdfCleanup(OWNER, REVIEW, ["old.pdf"]);
    await expect(store.readFile(OWNER, REVIEW, "pdf", "old.pdf")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.readFile(OWNER, REVIEW, "pdf", "keep.pdf")).resolves.toEqual(Buffer.from("keep-pdf"));
    await expect(store.readFile(OWNER, REVIEW, "images", "old.pdf")).resolves.toEqual(Buffer.from("image"));
  });

  it("stageDelete 可回滚或提交", async () => {
    await store.writeFile(OWNER, REVIEW, "images", "page.jpg", "page");
    const staged = await store.stageDelete(OWNER, REVIEW);
    await expect(stat(store.getReviewPaths(OWNER, REVIEW).reviewDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await staged.rollback();
    await expect(store.readFile(OWNER, REVIEW, "images", "page.jpg")).resolves.toEqual(Buffer.from("page"));
    const stagedAgain = await store.stageDelete(OWNER, REVIEW);
    await stagedAgain.commit();
    await expect(stat(store.getReviewPaths(OWNER, REVIEW).reviewDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("崩溃恢复时按 owner 恢复暂存目录", async () => {
    await store.writeFile(OWNER, REVIEW, "images", "page.jpg", "page");
    await store.stageDelete(OWNER, REVIEW);
    const restarted = new ReviewFileStore(store.rootDirectory);
    await restarted.recoverStagedDeletes(async (ownerId, reviewId) => ownerId === OWNER && reviewId === REVIEW);
    await expect(restarted.readFile(OWNER, REVIEW, "images", "page.jpg")).resolves.toEqual(Buffer.from("page"));
  });

  it("崩溃恢复时 DB 已无 review 则清理暂存目录", async () => {
    await store.writeFile(OWNER, REVIEW, "images", "page.jpg", "page");
    await store.stageDelete(OWNER, REVIEW);
    const restarted = new ReviewFileStore(store.rootDirectory);
    await restarted.recoverStagedDeletes(async () => false);
    await expect(readdir(path.join(restarted.rootDirectory, ".trash"))).resolves.toEqual([]);
  });

  it("拒绝通过符号链接访问目录或文件", async () => {
    const outside = path.join(temporaryDirectory, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "do-not-read");
    await store.createReview(OWNER, REVIEW);
    const paths = store.getReviewPaths(OWNER, REVIEW);
    await rm(paths.imagesDirectory, { recursive: true });
    await symlink(outside, paths.imagesDirectory);
    await expect(store.readFile(OWNER, REVIEW, "images", "secret.txt")).rejects.toBeInstanceOf(UnsafeStoragePathError);
  });

  it("拒绝读取最终文件符号链接", async () => {
    const outside = path.join(temporaryDirectory, "secret.txt");
    await writeFile(outside, "do-not-read");
    const paths = await store.createReview(OWNER, REVIEW);
    await symlink(outside, path.join(paths.imagesDirectory, "page.txt"));
    await expect(store.readFile(OWNER, REVIEW, "images", "page.txt")).rejects.toBeInstanceOf(UnsafeStoragePathError);
  });

  it("拒绝根目录符号链接且不触及外部目标", async () => {
    const outside = path.join(temporaryDirectory, "outside");
    await mkdir(outside);
    await symlink(outside, store.rootDirectory);
    await expect(store.writeFile(OWNER, REVIEW, "images", "escaped.txt", "secret")).rejects.toBeInstanceOf(UnsafeStoragePathError);
    await expect(stat(path.join(outside, OWNER))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("旧目录在确认 owner 后迁移且幂等", async () => {
    const legacyRoot = path.join(temporaryDirectory, "legacy");
    const legacyReview = path.join(legacyRoot, REVIEW);
    await mkdir(path.join(legacyReview, "images"), { recursive: true });
    await writeFile(path.join(legacyReview, "images", "page.jpg"), "legacy");
    const isolated = new ReviewFileStore(store.rootDirectory, legacyRoot);
    await isolated.migrateLegacyReview(OWNER, REVIEW);
    await expect(isolated.readFile(OWNER, REVIEW, "images", "page.jpg")).resolves.toEqual(Buffer.from("legacy"));
    await isolated.migrateLegacyReview(OWNER, REVIEW);
    await expect(readFile(path.join(isolated.getReviewPaths(OWNER, REVIEW).imagesDirectory, "page.jpg"), "utf8")).resolves.toBe("legacy");
  });
});
