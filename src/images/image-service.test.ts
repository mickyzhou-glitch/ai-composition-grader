// @vitest-environment node

import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewImage, ReviewImageInput } from "../db/review-repository";
import { ReviewFileStore } from "../storage/review-file-store";
import {
  ImageService,
  type ImageRepository,
} from "./image-service";

const OWNER_ID = "local-admin";

class MemoryImageRepository implements ImageRepository {
  images: ReviewImage[] = [];
  revision = 0;
  pdfFilename: string | null = null;
  replaceError: Error | null = null;

  getById(_ownerId: string, id: string) {
    return id === "review-1"
      ? {
          images: this.images,
          revision: this.revision,
          pdfFilename: this.pdfFilename,
        }
      : null;
  }

  replaceImages(_ownerId: string, reviewId: string, expectedRevision: number, images: ReviewImageInput[]) {
    if (this.replaceError) throw this.replaceError;
    if (expectedRevision !== this.revision) {
      throw Object.assign(new Error("stale revision"), {
        code: "REVISION_CONFLICT",
        status: 409,
      });
    }
    this.images = images.map((image, index) => ({
      ...image,
      id: index + 1,
      reviewId,
      createdAt: new Date(0),
    }));
    this.revision += 1;
    return { images: this.images, revision: this.revision };
  }
}

async function jpeg(width = 100, height = 80, color = "white") {
  return sharp({
    create: { width, height, channels: 3, background: color },
  })
    .jpeg()
    .toBuffer();
}

describe("ImageService", () => {
  let temporaryDirectory: string;
  let store: ReviewFileStore;
  let repository: MemoryImageRepository;
  let service: ImageService;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "grader-images-"));
    store = new ReviewFileStore(path.join(temporaryDirectory, "reviews"));
    repository = new MemoryImageRepository();
    service = new ImageService(store, repository);
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it.each([0, 5])("一次拒绝上传 %i 张图片", async (count) => {
    const data = await jpeg();
    const files = Array.from({ length: count }, (_, index) => ({
      originalName: `page-${index}.jpg`,
      mimeType: "image/jpeg",
      data,
    }));

    await expect(service.upload(OWNER_ID, "review-1", repository.revision, files)).rejects.toMatchObject({
      code: "IMAGE_COUNT_INVALID",
      status: 400,
    });
  });

  it("拒绝大于 20MB 的单张图片", async () => {
    await expect(
      service.upload(OWNER_ID, "review-1", repository.revision, [
        {
          originalName: "large.jpg",
          mimeType: "image/jpeg",
          data: Buffer.alloc(20 * 1024 * 1024 + 1),
        },
      ]),
    ).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE", status: 413 });
  });

  it("拒绝超过 6000 万像素的解压炸弹并返回明确 422", async () => {
    const oversizedPixels = await sharp({
      create: {
        width: 8000,
        height: 8000,
        channels: 3,
        background: "white",
      },
    })
      .png()
      .toBuffer();

    await expect(
      service.upload(OWNER_ID, "review-1", repository.revision, [
        {
          originalName: "too-many-pixels.png",
          mimeType: "image/png",
          data: oversizedPixels,
        },
      ]),
    ).rejects.toMatchObject({
      code: "IMAGE_PIXEL_LIMIT_EXCEEDED",
      status: 422,
    });
  });

  it.each(["image/gif", "application/octet-stream", "image/jpgx"])(
    "拒绝不支持的 MIME %s",
    async (mimeType) => {
      await expect(
        service.upload(OWNER_ID, "review-1", repository.revision, [
          { originalName: "spoofed.jpg", mimeType, data: await jpeg() },
        ]),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE_TYPE", status: 422 });
    },
  );

  it("不信任文件扩展名但会真实解码图片", async () => {
    await service.upload(OWNER_ID, "review-1", repository.revision, [
      {
        originalName: "homework.exe",
        mimeType: "image/jpeg",
        data: await jpeg(),
      },
    ]);

    expect(repository.images[0]).toMatchObject({
      position: 0,
      originalName: "homework.exe",
      mimeType: "image/jpeg",
      width: 100,
      height: 80,
      rotation: 0,
      crop: null,
    });
    expect(repository.images[0].originalPath).toMatch(/original\.jpg$/);
    expect(repository.images[0].annotationPath).toMatch(/annotation\.jpg$/);
    expect(repository.images[0].aiPath).toMatch(/ai\.jpg$/);
  });

  it("无法解码时返回 INVALID_IMAGE 而不是 Sharp 原始错误", async () => {
    await expect(
      service.upload(OWNER_ID, "review-1", repository.revision, [
        {
          originalName: "fake.jpg",
          mimeType: "image/jpeg",
          data: Buffer.from("not an image"),
        },
      ]),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "INVALID_IMAGE",
        status: 422,
      }),
    );
  });

  it("第二张图片处理失败时不遗留第一张的新文件", async () => {
    await expect(
      service.upload(OWNER_ID, "review-1", repository.revision, [
        { originalName: "valid.jpg", mimeType: "image/jpeg", data: await jpeg() },
        {
          originalName: "broken.jpg",
          mimeType: "image/jpeg",
          data: Buffer.from("broken"),
        },
      ]),
    ).rejects.toMatchObject({ code: "INVALID_IMAGE" });

    const imagesDirectory = store.getReviewPaths(OWNER_ID, "review-1").imagesDirectory;
    await expect(readdir(imagesDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(repository.images).toEqual([]);
  });

  it("DB 替换失败时清理新版本并完整保留旧图片文件", async () => {
    await service.upload(OWNER_ID, "review-1", repository.revision, [
      { originalName: "old.jpg", mimeType: "image/jpeg", data: await jpeg() },
    ]);
    const old = repository.images[0];
    const oldFiles = [old.originalPath, old.annotationPath, old.aiPath];
    repository.replaceError = new Error("database failed");

    await expect(
      service.upload(OWNER_ID, "review-1", repository.revision, [
        { originalName: "new.jpg", mimeType: "image/jpeg", data: await jpeg() },
      ]),
    ).rejects.toThrow("database failed");

    expect(repository.images).toEqual([old]);
    for (const storedPath of oldFiles) {
      await expect(
        stat(path.join(store.rootDirectory, OWNER_ID, "reviews", "review-1", storedPath)),
      ).resolves.toMatchObject({});
    }
    expect(await readdir(store.getReviewPaths(OWNER_ID, "review-1").imagesDirectory)).toHaveLength(3);
  });

  it("重传成功后数据库切换到新版本并清理全部旧文件", async () => {
    await service.upload(OWNER_ID, "review-1", repository.revision, [
      { originalName: "old.jpg", mimeType: "image/jpeg", data: await jpeg() },
    ]);
    const oldPaths = [
      repository.images[0].originalPath,
      repository.images[0].annotationPath,
      repository.images[0].aiPath,
    ];

    await service.upload(OWNER_ID, "review-1", repository.revision, [
      { originalName: "new.jpg", mimeType: "image/jpeg", data: await jpeg() },
    ]);

    expect(repository.images[0].originalName).toBe("new.jpg");
    for (const storedPath of oldPaths) {
      await expect(
        stat(path.join(store.rootDirectory, OWNER_ID, "reviews", "review-1", storedPath)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readdir(store.getReviewPaths(OWNER_ID, "review-1").imagesDirectory)).toHaveLength(3);
  });

  it("旧文件清理失败不回滚 DB 切换，并持久排队到同 review 下次操作重试", async () => {
    await service.upload(OWNER_ID, "review-1", repository.revision, [
      { originalName: "old.jpg", mimeType: "image/jpeg", data: await jpeg() },
    ]);
    const oldFilenames = [
      repository.images[0].originalPath,
      repository.images[0].annotationPath,
      repository.images[0].aiPath,
    ].map((storedPath) => path.basename(storedPath));
    const deleteFile = store.deleteFile.bind(store);
    const deleteSpy = vi.spyOn(store, "deleteFile").mockImplementation(
      async (ownerId, reviewId, kind, filename) => {
        if (oldFilenames.includes(filename)) {
          throw new Error("cleanup failed");
        }
        await deleteFile(ownerId, reviewId, kind, filename);
      },
    );

    await expect(
      service.upload(OWNER_ID, "review-1", repository.revision, [
        { originalName: "new.jpg", mimeType: "image/jpeg", data: await jpeg() },
      ]),
    ).resolves.toMatchObject({ images: [{ originalName: "new.jpg" }] });
    expect(repository.images[0].originalName).toBe("new.jpg");
    const queued = JSON.parse(
      await readFile(path.join(store.rootDirectory, ".cleanup-queue.json"), "utf8"),
    ) as Array<{ reviewId: string; filename: string }>;
    expect(queued).toEqual(
      expect.arrayContaining(
        oldFilenames.map((filename) => ({
          ownerId: OWNER_ID,
          reviewId: "review-1",
          kind: "images",
          filename,
        })),
      ),
    );

    deleteSpy.mockRestore();
    store = new ReviewFileStore(path.join(temporaryDirectory, "reviews"));
    service = new ImageService(store, repository);
    await service.update(OWNER_ID, "review-1", { expectedRevision: repository.revision,
      images: [{ id: repository.images[0].id, position: 0 }],
    });

    for (const filename of oldFilenames) {
      await expect(
        stat(path.join(store.getReviewPaths(OWNER_ID, "review-1").imagesDirectory, filename)),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(
      readFile(path.join(store.rootDirectory, ".cleanup-queue.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("有效 HEIC 在当前 Sharp 缺少解码器时返回 UNSUPPORTED_HEIC", async () => {
    const heicHeader = Buffer.from("00000018667479706865696300000000", "hex");
    await expect(
      service.upload(OWNER_ID, "review-1", repository.revision, [
        {
          originalName: "page.heic",
          mimeType: "image/heic",
          data: heicHeader,
        },
      ]),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_HEIC", status: 422 });
  });

  it.each(["image/heic", "image/heif"])(
    "拒绝用 %s MIME 伪装的可解码 AVIF",
    async (mimeType) => {
      const avif = await sharp({
        create: { width: 16, height: 16, channels: 3, background: "white" },
      })
        .avif()
        .toBuffer();

      await expect(
        service.upload(OWNER_ID, "review-1", repository.revision, [
          { originalName: "spoofed.heic", mimeType, data: avif },
        ]),
      ).rejects.toMatchObject({ code: "INVALID_IMAGE", status: 422 });
      expect(repository.images).toEqual([]);
    },
  );

  it("生成最长边受限的高质量批注底图和带 10x10 网格的 AI 副本", async () => {
    await service.upload(OWNER_ID, "review-1", repository.revision, [
      {
        originalName: "large.jpg",
        mimeType: "image/jpeg",
        data: await jpeg(4000, 1000),
      },
    ]);

    const saved = repository.images[0];
    const annotation = await sharp(
      await readFile(path.join(store.rootDirectory, OWNER_ID, "reviews", "review-1", saved.annotationPath)),
    ).metadata();
    const aiPath = path.join(store.rootDirectory, OWNER_ID, "reviews", "review-1", saved.aiPath);
    const ai = sharp(await readFile(aiPath));
    const aiMetadata = await ai.metadata();
    const { data, info } = await ai.raw().toBuffer({ resolveWithObject: true });
    const gridPixel = (Math.floor(info.width / 10) * info.channels) +
      Math.floor(info.height / 2) * info.width * info.channels;

    expect(annotation).toMatchObject({ width: 3000, height: 750, format: "jpeg" });
    expect(aiMetadata).toMatchObject({ width: 2000, height: 500, format: "jpeg" });
    expect([...data.subarray(gridPixel, gridPixel + 3)]).not.toEqual([255, 255, 255]);
  });

  it("上传时按 EXIF 自动方向纠正尺寸", async () => {
    const oriented = await sharp({
      create: { width: 400, height: 200, channels: 3, background: "white" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();

    await service.upload(OWNER_ID, "review-1", repository.revision, [
      { originalName: "phone.jpg", mimeType: "image/jpeg", data: oriented },
    ]);

    expect(repository.images[0]).toMatchObject({ width: 200, height: 400 });
  });

  it("按 90 度旋转后应用 0..1 归一化裁剪并重新处理", async () => {
    await service.upload(OWNER_ID, "review-1", repository.revision, [
      {
        originalName: "page.jpg",
        mimeType: "image/jpeg",
        data: await jpeg(400, 200),
      },
    ]);
    const current = repository.images[0];

    await service.update(OWNER_ID, "review-1", { expectedRevision: repository.revision,
      images: [
        {
          id: current.id,
          position: 0,
          rotation: 90,
          crop: { x: 0, y: 0, width: 0.5, height: 1 },
        },
      ],
    });

    expect(repository.images[0]).toMatchObject({
      id: 1,
      position: 0,
      rotation: 90,
      crop: { x: 0, y: 0, width: 0.5, height: 1 },
      width: 100,
      height: 400,
    });
  });

  it("拒绝越界裁剪和非 90 度倍数旋转", async () => {
    await service.upload(OWNER_ID, "review-1", repository.revision, [
      { originalName: "page.jpg", mimeType: "image/jpeg", data: await jpeg() },
    ]);
    const id = repository.images[0].id;

    await expect(
      service.update(OWNER_ID, "review-1", { expectedRevision: repository.revision,
        images: [
          {
            id,
            position: 0,
            rotation: 45 as never,
            crop: { x: 0.8, y: 0, width: 0.3, height: 1 },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_IMAGE_TRANSFORM", status: 400 });
  });

  it("旧 revision 变换在校验图片 id 前返回 409", async () => {
    repository.revision = 1;

    await expect(
      service.update(OWNER_ID, "review-1", {
        expectedRevision: 0,
        images: [{ id: 999, rotation: 90 }],
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT", status: 409 });
  });

  it("更换图片成功后将旧 PDF 加入清理队列", async () => {
    repository.pdfFilename = "old.pdf";
    const cleanup = vi.spyOn(store, "queuePdfCleanup");

    await service.upload(OWNER_ID, "review-1", repository.revision, [
      { originalName: "new.jpg", mimeType: "image/jpeg", data: await jpeg() },
    ]);

    expect(cleanup).toHaveBeenCalledWith(OWNER_ID, "review-1", ["old.pdf"]);
  });

  it("PATCH 仅调整顺序时保留已有旋转和裁剪", async () => {
    const data = await jpeg();
    await service.upload(OWNER_ID, "review-1", repository.revision, [
      { originalName: "first.jpg", mimeType: "image/jpeg", data },
      { originalName: "second.jpg", mimeType: "image/jpeg", data },
    ]);

    await service.update(OWNER_ID, "review-1", { expectedRevision: repository.revision,
      images: [
        { id: repository.images[0].id, position: 1 },
        { id: repository.images[1].id, position: 0 },
      ],
    } as never);

    expect(repository.images.map(({ originalName, rotation, crop }) => ({
      originalName,
      rotation,
      crop,
    }))).toEqual([
      { originalName: "second.jpg", rotation: 0, crop: null },
      { originalName: "first.jpg", rotation: 0, crop: null },
    ]);
  });

  it("update 使用新版本路径，DB 失败时不覆盖旧批注和 AI 文件", async () => {
    await service.upload(OWNER_ID, "review-1", repository.revision, [
      { originalName: "page.jpg", mimeType: "image/jpeg", data: await jpeg() },
    ]);
    const old = repository.images[0];
    const oldAnnotation = await store.readFile(
      OWNER_ID,
      "review-1",
      "images",
      path.basename(old.annotationPath),
    );
    repository.replaceError = new Error("database failed");

    await expect(
      service.update(OWNER_ID, "review-1", { expectedRevision: repository.revision,
        images: [{ id: old.id, rotation: 90 }],
      }),
    ).rejects.toThrow("database failed");

    await expect(
      store.readFile(OWNER_ID, "review-1", "images", path.basename(old.annotationPath)),
    ).resolves.toEqual(oldAnnotation);
    expect(await readdir(store.getReviewPaths(OWNER_ID, "review-1").imagesDirectory)).toHaveLength(3);
  });
});
