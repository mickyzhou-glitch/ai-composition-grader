// @vitest-environment node

import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReviewFileStore, UnsafeStoragePathError } from "./review-file-store";

const OWNER = "teacher-01";
const REVIEW = "review-1";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

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

  it("不同 FileStore 实例也会串行化同一篇作文的文件操作", async () => {
    const anotherProcessStore = new ReviewFileStore(store.rootDirectory);
    const entered = deferred<void>();
    const release = deferred<void>();
    let secondEntered = false;
    const first = store.withReviewLock(OWNER, REVIEW, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const second = anotherProcessStore.withReviewLock(OWNER, REVIEW, async () => {
      secondEntered = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(secondEntered).toBe(false);
    release.resolve();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });

  it("仅在锁持有进程已死亡时回收超过五分钟的崩溃残留锁", async () => {
    await store.createReview(OWNER, REVIEW);
    const locksDirectory = path.join(store.rootDirectory, ".review-locks");
    await mkdir(locksDirectory);
    const lockName = createHash("sha256").update(`${OWNER}\0${REVIEW}`).digest("hex");
    const staleLock = path.join(locksDirectory, lockName);
    await mkdir(staleLock);
    await writeFile(path.join(staleLock, "owner.json"), JSON.stringify({ pid: 19701, nonce: "crashed-owner-nonce" }));
    const staleAt = new Date(Date.now() - 6 * 60 * 1000);
    await utimes(staleLock, staleAt, staleAt);

    let called = false;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 19701) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    });
    await store.withReviewLock(OWNER, REVIEW, async () => { called = true; });
    kill.mockRestore();
    expect(called).toBe(true);
    await expect(stat(staleLock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("存活进程留下的 stale 锁不会被回收，而是安全返回忙碌", async () => {
    await store.createReview(OWNER, REVIEW);
    const anotherProcessStore = new ReviewFileStore(
      store.rootDirectory,
      undefined,
      { lockWaitMs: 50, lockRetryMs: 5 },
    );
    const locksDirectory = path.join(store.rootDirectory, ".review-locks");
    const lockName = createHash("sha256").update(`${OWNER}\0${REVIEW}`).digest("hex");
    const lockPath = path.join(locksDirectory, lockName);
    await mkdir(locksDirectory);
    await mkdir(lockPath);
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: 19702, nonce: "live-owner-nonce---" }));
    const staleAt = new Date(Date.now() - 6 * 60 * 1000);
    await utimes(lockPath, staleAt, staleAt);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 19702) return true;
      return true;
    });
    await expect(anotherProcessStore.withReviewLock(OWNER, REVIEW, async () => undefined))
      .rejects.toMatchObject({ code: "REVIEW_LOCK_BUSY" });
    kill.mockRestore();
    expect((await stat(lockPath)).isDirectory()).toBe(true);
  });

  it("mkdir 后崩溃且缺少 owner 标记的 stale 目录会超时返回忙碌，而非无限循环", async () => {
    await store.createReview(OWNER, REVIEW);
    const anotherProcessStore = new ReviewFileStore(
      store.rootDirectory,
      undefined,
      { lockWaitMs: 50, lockRetryMs: 5 },
    );
    const locksDirectory = path.join(store.rootDirectory, ".review-locks");
    await mkdir(locksDirectory);
    const lockName = createHash("sha256").update(`${OWNER}\0${REVIEW}`).digest("hex");
    const incompleteLock = path.join(locksDirectory, lockName);
    await mkdir(incompleteLock);
    const staleAt = new Date(Date.now() - 6 * 60 * 1000);
    await utimes(incompleteLock, staleAt, staleAt);

    await expect(anotherProcessStore.withReviewLock(OWNER, REVIEW, async () => undefined))
      .rejects.toMatchObject({ code: "REVIEW_LOCK_BUSY" });
    expect((await stat(incompleteLock)).isDirectory()).toBe(true);
  });

  it("两个 reclaimer 同时处理死锁时，只有一个能原子接管固定租约目录", async () => {
    await store.createReview(OWNER, REVIEW);
    const locksDirectory = path.join(store.rootDirectory, ".review-locks");
    await mkdir(locksDirectory);
    const lockName = createHash("sha256").update(`${OWNER}\0${REVIEW}`).digest("hex");
    const staleLock = path.join(locksDirectory, lockName);
    await mkdir(staleLock);
    await writeFile(path.join(staleLock, "owner.json"), JSON.stringify({ pid: 19703, nonce: "dead-owner-nonce----" }));
    const staleAt = new Date(Date.now() - 6 * 60 * 1000);
    await utimes(staleLock, staleAt, staleAt);
    const firstStore = new ReviewFileStore(store.rootDirectory, undefined, { lockWaitMs: 250, lockRetryMs: 5 });
    const secondStore = new ReviewFileStore(store.rootDirectory, undefined, { lockWaitMs: 250, lockRetryMs: 5 });
    const entered = deferred<void>();
    const release = deferred<void>();
    const acquisitions: string[] = [];
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 19703) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    });
    const first = firstStore.withReviewLock(OWNER, REVIEW, async () => {
      acquisitions.push("first");
      entered.resolve();
      await release.promise;
    });
    const second = secondStore.withReviewLock(OWNER, REVIEW, async () => {
      acquisitions.push("second");
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    await new Promise<void>((resolve) => setTimeout(resolve, 60));
    expect(acquisitions).toHaveLength(1);
    release.resolve();
    await Promise.all([first, second]);
    kill.mockRestore();
    expect(acquisitions).toEqual(expect.arrayContaining(["first", "second"]));
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
