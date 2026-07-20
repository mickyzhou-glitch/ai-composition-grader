// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ReviewImage, ReviewImageInput } from "../db/review-repository";
import { ReviewFileStore } from "../storage/review-file-store";
import {
  ImageService,
  type ImageRepository,
} from "./image-service";

class MemoryImageRepository implements ImageRepository {
  images: ReviewImage[] = [];

  getById(id: string) {
    return id === "review-1" ? { images: this.images } : null;
  }

  replaceImages(reviewId: string, images: ReviewImageInput[]) {
    this.images = images.map((image, index) => ({
      ...image,
      id: index + 1,
      reviewId,
      createdAt: new Date(0),
    }));
    return { images: this.images };
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

  it.each([0, 4])("一次拒绝上传 %i 张图片", async (count) => {
    const data = await jpeg();
    const files = Array.from({ length: count }, (_, index) => ({
      originalName: `page-${index}.jpg`,
      mimeType: "image/jpeg",
      data,
    }));

    await expect(service.upload("review-1", files)).rejects.toMatchObject({
      code: "IMAGE_COUNT_INVALID",
      status: 400,
    });
  });

  it("拒绝大于 20MB 的单张图片", async () => {
    await expect(
      service.upload("review-1", [
        {
          originalName: "large.jpg",
          mimeType: "image/jpeg",
          data: Buffer.alloc(20 * 1024 * 1024 + 1),
        },
      ]),
    ).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE", status: 413 });
  });

  it.each(["image/gif", "application/octet-stream", "image/jpgx"])(
    "拒绝不支持的 MIME %s",
    async (mimeType) => {
      await expect(
        service.upload("review-1", [
          { originalName: "spoofed.jpg", mimeType, data: await jpeg() },
        ]),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_IMAGE_TYPE", status: 422 });
    },
  );

  it("不信任文件扩展名但会真实解码图片", async () => {
    await service.upload("review-1", [
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
      service.upload("review-1", [
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

  it("有效 HEIC 在当前 Sharp 缺少解码器时返回 UNSUPPORTED_HEIC", async () => {
    const heicHeader = Buffer.from("00000018667479706865696300000000", "hex");
    await expect(
      service.upload("review-1", [
        {
          originalName: "page.heic",
          mimeType: "image/heic",
          data: heicHeader,
        },
      ]),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_HEIC", status: 422 });
  });

  it("生成最长边受限的高质量批注底图和带 10x10 网格的 AI 副本", async () => {
    await service.upload("review-1", [
      {
        originalName: "large.jpg",
        mimeType: "image/jpeg",
        data: await jpeg(4000, 1000),
      },
    ]);

    const saved = repository.images[0];
    const annotation = await sharp(
      await readFile(path.join(store.rootDirectory, "review-1", saved.annotationPath)),
    ).metadata();
    const aiPath = path.join(store.rootDirectory, "review-1", saved.aiPath);
    const ai = sharp(await readFile(aiPath));
    const aiMetadata = await ai.metadata();
    const { data, info } = await ai.raw().toBuffer({ resolveWithObject: true });
    const gridPixel = (Math.floor(info.width / 10) * info.channels) +
      Math.floor(info.height / 2) * info.width * info.channels;

    expect(annotation).toMatchObject({ width: 3000, height: 750, format: "jpeg" });
    expect(aiMetadata).toMatchObject({ width: 2000, height: 500, format: "jpeg" });
    expect([...data.subarray(gridPixel, gridPixel + 3)]).not.toEqual([255, 255, 255]);
  });

  it("按 90 度旋转后应用 0..1 归一化裁剪并重新处理", async () => {
    await service.upload("review-1", [
      {
        originalName: "page.jpg",
        mimeType: "image/jpeg",
        data: await jpeg(400, 200),
      },
    ]);
    const current = repository.images[0];

    await service.update("review-1", {
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
    await service.upload("review-1", [
      { originalName: "page.jpg", mimeType: "image/jpeg", data: await jpeg() },
    ]);
    const id = repository.images[0].id;

    await expect(
      service.update("review-1", {
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
});
