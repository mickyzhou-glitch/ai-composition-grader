// @vitest-environment node

import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
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

  it("拒绝通过符号链接读写根目录外文件", async () => {
    const outside = path.join(temporaryDirectory, "outside");
    await store.createReview("review-1");
    await rm(store.getReviewPaths("review-1").imagesDirectory, { recursive: true });
    await symlink(outside, store.getReviewPaths("review-1").imagesDirectory);

    await expect(
      store.writeFile("review-1", "images", "escaped.txt", "secret"),
    ).rejects.toBeInstanceOf(UnsafeStoragePathError);
  });
});
