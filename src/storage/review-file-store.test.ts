// @vitest-environment node

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ReviewFileStore, UnsafeStoragePathError } from "./review-file-store";

describe("ReviewFileStore", () => {
  let temporaryDirectory: string;
  let store: ReviewFileStore;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), "grader-storage-"));
    store = new ReviewFileStore(path.join(temporaryDirectory, "reviews"));
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("创建 review 专属的 images 和 pdf 目录并可读写", async () => {
    const paths = await store.createReview("review-1");
    await store.writeFile("review-1", "images", "page-1.jpg", Buffer.from("image"));
    await store.writeFile("review-1", "pdf", "report.pdf", Buffer.from("pdf"));

    expect((await stat(paths.imagesDirectory)).isDirectory()).toBe(true);
    expect((await stat(paths.pdfDirectory)).isDirectory()).toBe(true);
    await expect(
      store.readFile("review-1", "images", "page-1.jpg"),
    ).resolves.toEqual(Buffer.from("image"));
    await expect(readFile(path.join(paths.pdfDirectory, "report.pdf"))).resolves.toEqual(
      Buffer.from("pdf"),
    );
  });

  it("以 0700 权限创建 storage root", async () => {
    await store.createReview("review-1");

    expect((await stat(store.rootDirectory)).mode & 0o777).toBe(0o700);
  });

  it("20 个并发首次写入不因 EEXIST 失败", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.writeFile("review-1", "images", `page-${index}.txt`, `${index}`),
      ),
    );

    await expect(
      Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          store.readFile("review-1", "images", `page-${index}.txt`),
        ),
      ),
    ).resolves.toHaveLength(20);
  });

  it.each([
    ["../outside", "images", "page.jpg"],
    ["review/../../outside", "images", "page.jpg"],
    ["/tmp/outside", "images", "page.jpg"],
    ["review-1", "images", "../outside.jpg"],
    ["review-1", "pdf", "folder/outside.pdf"],
  ] as const)(
    "拒绝路径穿越 reviewId=%s kind=%s filename=%s",
    async (reviewId, kind, filename) => {
      await expect(
        store.writeFile(reviewId, kind, filename, Buffer.from("secret")),
      ).rejects.toBeInstanceOf(UnsafeStoragePathError);
    },
  );

  it("只递归删除指定 review 目录", async () => {
    await store.writeFile("review-1", "images", "page.jpg", "one");
    const sibling = await store.createReview("review-2");
    await store.deleteReview("review-1");

    await expect(stat(store.getReviewPaths("review-1").reviewDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await stat(sibling.reviewDirectory)).isDirectory()).toBe(true);
    expect((await stat(store.rootDirectory)).isDirectory()).toBe(true);
  });

  it("只删除 images 内指定的普通文件", async () => {
    await store.writeFile("review-1", "images", "old.jpg", "old");
    await store.writeFile("review-1", "images", "keep.jpg", "keep");

    await store.deleteFile("review-1", "images", "old.jpg");

    await expect(store.readFile("review-1", "images", "old.jpg")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(store.readFile("review-1", "images", "keep.jpg")).resolves.toEqual(
      Buffer.from("keep"),
    );
  });

  it("stageDelete 可回滚或提交同根目录的暂存删除", async () => {
    await store.writeFile("review-1", "images", "page.jpg", "page");
    const staged = await store.stageDelete("review-1");

    await expect(
      stat(store.getReviewPaths("review-1").reviewDirectory),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await staged.rollback();
    await expect(store.readFile("review-1", "images", "page.jpg")).resolves.toEqual(
      Buffer.from("page"),
    );

    const stagedAgain = await store.stageDelete("review-1");
    await stagedAgain.commit();
    await expect(
      stat(store.getReviewPaths("review-1").reviewDirectory),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("拒绝通过中间目录符号链接写入根目录外", async () => {
    const outside = path.join(temporaryDirectory, "outside");
    await store.createReview("review-1");
    await rm(store.getReviewPaths("review-1").imagesDirectory, { recursive: true });
    await symlink(outside, store.getReviewPaths("review-1").imagesDirectory);

    await expect(
      store.writeFile("review-1", "images", "escaped.txt", "secret"),
    ).rejects.toBeInstanceOf(UnsafeStoragePathError);
  });

  it("拒绝通过中间目录符号链接读取外部 secret", async () => {
    const outside = path.join(temporaryDirectory, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "do-not-read");
    await store.createReview("review-1");
    await rm(store.getReviewPaths("review-1").imagesDirectory, { recursive: true });
    await symlink(outside, store.getReviewPaths("review-1").imagesDirectory);

    await expect(
      store.readFile("review-1", "images", "secret.txt"),
    ).rejects.toBeInstanceOf(UnsafeStoragePathError);
  });

  it("拒绝读取指向外部文件的最终符号链接", async () => {
    const outside = path.join(temporaryDirectory, "secret.txt");
    await writeFile(outside, "do-not-read");
    const paths = await store.createReview("review-1");
    await symlink(outside, path.join(paths.imagesDirectory, "page.txt"));

    await expect(
      store.readFile("review-1", "images", "page.txt"),
    ).rejects.toBeInstanceOf(UnsafeStoragePathError);
  });

  it("reviews 根目录是符号链接时拒绝写入", async () => {
    const outside = path.join(temporaryDirectory, "outside");
    await mkdir(outside);
    await symlink(outside, store.rootDirectory);

    await expect(
      store.writeFile("review-1", "images", "escaped.txt", "secret"),
    ).rejects.toBeInstanceOf(UnsafeStoragePathError);
    await expect(stat(path.join(outside, "review-1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reviews 根目录是符号链接时拒绝删除且不触及链接目标", async () => {
    const outside = path.join(temporaryDirectory, "outside");
    const externalReview = path.join(outside, "review-1");
    const marker = path.join(externalReview, "keep.txt");
    await mkdir(externalReview, { recursive: true });
    await writeFile(marker, "keep");
    await symlink(outside, store.rootDirectory);

    await expect(store.deleteReview("review-1")).rejects.toBeInstanceOf(
      UnsafeStoragePathError,
    );
    await expect(readFile(marker, "utf8")).resolves.toBe("keep");
  });

  it("review 目录是符号链接时拒绝删除且不触及链接目标", async () => {
    const outside = path.join(temporaryDirectory, "outside-review");
    const marker = path.join(outside, "keep.txt");
    await mkdir(outside);
    await writeFile(marker, "keep");
    await mkdir(store.rootDirectory);
    await symlink(outside, store.getReviewPaths("review-1").reviewDirectory);

    await expect(store.deleteReview("review-1")).rejects.toBeInstanceOf(
      UnsafeStoragePathError,
    );
    await expect(readFile(marker, "utf8")).resolves.toBe("keep");
  });
});
