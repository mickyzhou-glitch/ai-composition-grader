import { randomUUID } from "node:crypto";
import path from "node:path";

import sharp from "sharp";
import { z } from "zod";

import { normalizedCropSchema, type NormalizedCrop } from "../domain/contracts";
import type {
  ReviewImage,
  ReviewImageInput,
} from "../db/review-repository";
import type { ReviewFileStore } from "../storage/review-file-store";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

type AllowedMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

export interface UploadedImage {
  originalName: string;
  mimeType: string;
  data: Uint8Array;
}

export interface ImageRepository {
  getById(id: string): { images: ReviewImage[] } | null;
  replaceImages(
    reviewId: string,
    images: ReviewImageInput[],
  ): { images: ReviewImage[] };
}

export type ImageServiceErrorCode =
  | "IMAGE_COUNT_INVALID"
  | "IMAGE_TOO_LARGE"
  | "UNSUPPORTED_IMAGE_TYPE"
  | "INVALID_IMAGE"
  | "UNSUPPORTED_HEIC"
  | "INVALID_IMAGE_TRANSFORM"
  | "REVIEW_NOT_FOUND";

export class ImageServiceError extends Error {
  constructor(
    readonly code: ImageServiceErrorCode,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ImageServiceError";
  }
}

const rotationSchema = z.union([
  z.literal(0),
  z.literal(90),
  z.literal(180),
  z.literal(270),
]);

const updateSchema = z.object({
  images: z
    .array(
      z.object({
        id: z.number().int().positive(),
        position: z.number().int().nonnegative().optional(),
        rotation: rotationSchema.optional(),
        crop: normalizedCropSchema.nullable().optional(),
      }),
    )
    .min(1)
    .max(3),
});

export type UpdateImagesInput = z.infer<typeof updateSchema>;

interface ImageServiceOptions {
  createId?: () => string;
}

interface DecodedImage {
  format: "jpeg" | "png" | "webp" | "heif";
  width: number;
  height: number;
  orientation?: number;
}

function isHeicMime(mimeType: string): boolean {
  return mimeType === "image/heic" || mimeType === "image/heif";
}

function hasHeicSignature(data: Uint8Array): boolean {
  if (data.byteLength < 12) return false;
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buffer.toString("ascii", 4, 8) !== "ftyp") return false;
  return new Set(["heic", "heix", "hevc", "hevx", "heif", "mif1", "msf1"])
    .has(buffer.toString("ascii", 8, 12));
}

function canonicalExtension(format: DecodedImage["format"]): string {
  return format === "heif" ? "heic" : format === "jpeg" ? "jpg" : format;
}

function assertMimeMatchesFormat(mimeType: AllowedMimeType, format: string): void {
  const expected =
    mimeType === "image/jpeg" || mimeType === "image/jpg"
      ? "jpeg"
      : isHeicMime(mimeType)
        ? "heif"
        : mimeType.slice("image/".length);
  if (format !== expected) {
    throw new ImageServiceError(
      "INVALID_IMAGE",
      "图片实际格式与声明的 MIME 类型不一致",
      422,
    );
  }
}

function relativeImagePath(filename: string): string {
  return path.posix.join("images", filename);
}

function storedFilename(storedPath: string): string {
  const normalized = storedPath.replaceAll("\\", "/");
  if (!normalized.startsWith("images/") || normalized.split("/").length !== 2) {
    throw new ImageServiceError("INVALID_IMAGE", "图片存储路径无效", 422);
  }
  return normalized.slice("images/".length);
}

function orientedDimensions(decoded: DecodedImage, rotation: number) {
  const autoSwap = decoded.orientation !== undefined && decoded.orientation >= 5;
  let width = autoSwap ? decoded.height : decoded.width;
  let height = autoSwap ? decoded.width : decoded.height;
  if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  return { width, height };
}

function cropPixels(
  dimensions: { width: number; height: number },
  crop: NormalizedCrop | null,
) {
  if (!crop) return { left: 0, top: 0, ...dimensions };
  const left = Math.min(dimensions.width - 1, Math.floor(crop.x * dimensions.width));
  const top = Math.min(dimensions.height - 1, Math.floor(crop.y * dimensions.height));
  const right = Math.max(left + 1, Math.round((crop.x + crop.width) * dimensions.width));
  const bottom = Math.max(top + 1, Math.round((crop.y + crop.height) * dimensions.height));
  return {
    left,
    top,
    width: Math.min(dimensions.width, right) - left,
    height: Math.min(dimensions.height, bottom) - top,
  };
}

function gridSvg(width: number, height: number): Buffer {
  const lines: string[] = [];
  for (let index = 0; index <= 10; index += 1) {
    const x = (index * width) / 10;
    const y = (index * height) / 10;
    lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}"/>`);
    lines.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}"/>`);
  }
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">` +
      `<g fill="none" stroke="#ef4444" stroke-opacity="0.72" stroke-width="${Math.max(2, Math.round(Math.min(width, height) / 400))}">${lines.join("")}</g>` +
      `</svg>`,
  );
}

export class ImageService {
  private readonly createId: () => string;

  constructor(
    private readonly fileStore: ReviewFileStore,
    private readonly repository: ImageRepository,
    options: ImageServiceOptions = {},
  ) {
    this.createId = options.createId ?? randomUUID;
  }

  async upload(reviewId: string, files: UploadedImage[]) {
    if (!this.repository.getById(reviewId)) {
      throw new ImageServiceError("REVIEW_NOT_FOUND", "批改记录不存在", 404);
    }
    if (files.length < 1 || files.length > 3) {
      throw new ImageServiceError(
        "IMAGE_COUNT_INVALID",
        "一次必须上传 1 至 3 张图片",
        400,
      );
    }

    const processed: ReviewImageInput[] = [];
    for (const [position, file] of files.entries()) {
      this.validateUpload(file);
      const decoded = await this.decode(file);
      const token = this.createId();
      const originalFilename = `${token}-original.${canonicalExtension(decoded.format)}`;
      const annotationFilename = `${token}-annotation.jpg`;
      const aiFilename = `${token}-ai.jpg`;
      const outputs = await this.transform(file.data, decoded, 0, null);

      await this.fileStore.writeFile(reviewId, "images", originalFilename, file.data);
      await this.fileStore.writeFile(
        reviewId,
        "images",
        annotationFilename,
        outputs.annotation,
      );
      await this.fileStore.writeFile(reviewId, "images", aiFilename, outputs.ai);
      processed.push({
        position,
        originalName: file.originalName,
        mimeType: file.mimeType,
        originalPath: relativeImagePath(originalFilename),
        annotationPath: relativeImagePath(annotationFilename),
        aiPath: relativeImagePath(aiFilename),
        width: outputs.width,
        height: outputs.height,
        rotation: 0,
        crop: null,
      });
    }
    return this.repository.replaceImages(reviewId, processed);
  }

  async update(reviewId: string, input: UpdateImagesInput) {
    const review = this.repository.getById(reviewId);
    if (!review) throw new ImageServiceError("REVIEW_NOT_FOUND", "批改记录不存在", 404);
    const parsed = this.parseUpdate(input);
    const currentById = new Map(review.images.map((image) => [image.id, image]));
    if (
      parsed.images.length !== review.images.length ||
      new Set(parsed.images.map(({ id }) => id)).size !== parsed.images.length
    ) {
      throw new ImageServiceError(
        "INVALID_IMAGE_TRANSFORM",
        "图片更新必须完整包含当前图片并提供连续顺序",
        400,
      );
    }
    const changes = parsed.images.map((change) => {
      const current = currentById.get(change.id);
      if (!current) {
        throw new ImageServiceError("INVALID_IMAGE_TRANSFORM", "图片 id 无效", 400);
      }
      return {
        id: change.id,
        position: change.position ?? current.position,
        rotation: change.rotation ?? current.rotation,
        crop: change.crop === undefined ? current.crop : change.crop,
      };
    });
    const expectedPositions = changes.map(({ position }) => position).sort((a, b) => a - b);
    if (expectedPositions.some((position, index) => position !== index)) {
      throw new ImageServiceError(
        "INVALID_IMAGE_TRANSFORM",
        "图片更新必须提供连续顺序",
        400,
      );
    }

    const updated: ReviewImageInput[] = [];
    for (const change of [...changes].sort((a, b) => a.position - b.position)) {
      const current = currentById.get(change.id) as ReviewImage;
      const original = await this.fileStore.readFile(
        reviewId,
        "images",
        storedFilename(current.originalPath),
      );
      const decoded = await this.decode({
        originalName: current.originalName,
        mimeType: current.mimeType,
        data: original,
      });
      const outputs = await this.transform(
        original,
        decoded,
        change.rotation,
        change.crop,
      );
      await this.fileStore.writeFile(
        reviewId,
        "images",
        storedFilename(current.annotationPath),
        outputs.annotation,
      );
      await this.fileStore.writeFile(
        reviewId,
        "images",
        storedFilename(current.aiPath),
        outputs.ai,
      );
      updated.push({
        position: change.position,
        originalName: current.originalName,
        mimeType: current.mimeType,
        originalPath: current.originalPath,
        annotationPath: current.annotationPath,
        aiPath: current.aiPath,
        width: outputs.width,
        height: outputs.height,
        rotation: change.rotation,
        crop: change.crop,
      });
    }
    return this.repository.replaceImages(reviewId, updated);
  }

  private parseUpdate(input: UpdateImagesInput): UpdateImagesInput {
    const result = updateSchema.safeParse(input);
    if (!result.success) {
      throw new ImageServiceError(
        "INVALID_IMAGE_TRANSFORM",
        "旋转或裁剪参数无效",
        400,
        result.error.flatten(),
      );
    }
    return result.data;
  }

  private validateUpload(file: UploadedImage): void {
    if (file.data.byteLength > MAX_IMAGE_BYTES) {
      throw new ImageServiceError("IMAGE_TOO_LARGE", "单张图片不能超过 20MB", 413);
    }
    if (!(ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(file.mimeType)) {
      throw new ImageServiceError(
        "UNSUPPORTED_IMAGE_TYPE",
        "仅支持 JPG、PNG、WebP、HEIC 或 HEIF 图片",
        422,
      );
    }
  }

  private async decode(file: UploadedImage): Promise<DecodedImage> {
    try {
      const metadata = await sharp(file.data, { failOn: "error" }).metadata();
      if (!metadata.format || !metadata.width || !metadata.height) throw new Error("missing metadata");
      assertMimeMatchesFormat(file.mimeType as AllowedMimeType, metadata.format);
      if (!["jpeg", "png", "webp", "heif"].includes(metadata.format)) {
        throw new ImageServiceError("INVALID_IMAGE", "图片实际格式不受支持", 422);
      }
      return {
        format: metadata.format as DecodedImage["format"],
        width: metadata.width,
        height: metadata.height,
        orientation: metadata.orientation,
      };
    } catch (error) {
      if (error instanceof ImageServiceError) throw error;
      if (isHeicMime(file.mimeType) && hasHeicSignature(file.data)) {
        throw new ImageServiceError(
          "UNSUPPORTED_HEIC",
          "当前环境无法解码 HEIC/HEIF，请转换为 JPG 或 PNG 后重试",
          422,
        );
      }
      throw new ImageServiceError("INVALID_IMAGE", "图片内容无法解码", 422);
    }
  }

  private async transform(
    data: Uint8Array,
    decoded: DecodedImage,
    rotation: 0 | 90 | 180 | 270,
    crop: NormalizedCrop | null,
  ) {
    try {
      const dimensions = orientedDimensions(decoded, rotation);
      const extract = cropPixels(dimensions, crop);
      const pipeline = sharp(data, { failOn: "error" })
        .autoOrient()
        .rotate(rotation)
        .extract(extract);
      const annotationResult = await pipeline
        .clone()
        .resize({ width: 3000, height: 3000, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
        .toBuffer({ resolveWithObject: true });
      const aiBase = await pipeline
        .clone()
        .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
        .toBuffer({ resolveWithObject: true });
      const ai = await sharp(aiBase.data)
        .composite([{ input: gridSvg(aiBase.info.width, aiBase.info.height) }])
        .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
        .toBuffer();
      return {
        annotation: annotationResult.data,
        ai,
        width: annotationResult.info.width,
        height: annotationResult.info.height,
      };
    } catch {
      throw new ImageServiceError("INVALID_IMAGE", "图片处理失败", 422);
    }
  }
}
