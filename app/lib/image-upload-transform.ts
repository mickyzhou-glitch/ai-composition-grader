import type { NormalizedCrop } from "@/src/domain/contracts";
import { jpegExifQuarterTurn, readJpegExifOrientation, readJpegSize } from "@/src/images/jpeg-orientation";
import {
  addQuarterTurns,
  chooseUprightQuarterTurn,
  quarterTurnFromExif,
  type LuminanceImage,
  type QuarterTurn,
} from "@/src/images/upright-orientation";

const MAX_AI_IMAGE_DIMENSION = 2000;

export function fitImageWithinAiLimit(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_AI_IMAGE_DIMENSION / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function rotatedSize(width: number, height: number, rotation: QuarterTurn) {
  return rotation === 90 || rotation === 270
    ? { width: height, height: width }
    : { width, height };
}

function exifTurnForBitmap(bytes: Uint8Array, bitmapWidth: number, bitmapHeight: number): QuarterTurn {
  const orientation = readJpegExifOrientation(bytes);
  const turn = quarterTurnFromExif(orientation);
  if (turn !== 90 && turn !== 270) return jpegExifQuarterTurn(bytes);
  const size = readJpegSize(bytes);
  if (!size || size.width === size.height) return turn;
  const alreadySwapped = bitmapWidth === size.height && bitmapHeight === size.width;
  return alreadySwapped ? 0 : turn;
}

async function loadBitmap(file: File): Promise<{ bitmap: ImageBitmap; exifTurn: QuarterTurn }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "none" });
    return {
      bitmap,
      exifTurn: exifTurnForBitmap(bytes, bitmap.width, bitmap.height),
    };
  } catch {
    const bitmap = await createImageBitmap(file);
    return { bitmap, exifTurn: 0 };
  }
}

function sampleLuminance(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  rotation: QuarterTurn,
): LuminanceImage | null {
  const oriented = rotatedSize(sourceWidth, sourceHeight, rotation);
  const scale = Math.min(1, 240 / Math.max(oriented.width, oriented.height, 1));
  const width = Math.max(1, Math.round(oriented.width * scale));
  const height = Math.max(1, Math.round(oriented.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.translate(width / 2, height / 2);
  context.rotate((rotation * Math.PI) / 180);
  context.drawImage(
    source,
    (-sourceWidth * scale) / 2,
    (-sourceHeight * scale) / 2,
    sourceWidth * scale,
    sourceHeight * scale,
  );
  let pixels: Uint8ClampedArray;
  try {
    pixels = context.getImageData(0, 0, width, height).data;
  } catch {
    return null;
  }
  const luminance = new Uint8Array(width * height);
  for (let index = 0; index < luminance.length; index += 1) {
    const offset = index * 4;
    luminance[index] = Math.round(
      pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114,
    );
  }
  return { width, height, luminance };
}

export async function uprightImageFile(file: File): Promise<File> {
  try {
    const prepared = await prepareImageForCloudUpload({ file, rotation: 0, crop: null });
    return prepared.file;
  } catch {
    return file;
  }
}

export async function prepareImageForCloudUpload(input: {
  file: File;
  rotation: 0 | 90 | 180 | 270;
  crop: NormalizedCrop | null;
}): Promise<{ file: File; width: number; height: number }> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(input.file.type)) {
    throw new TypeError("仅支持 JPG、PNG、WebP 图片");
  }
  if (typeof createImageBitmap !== "function") {
    return { file: input.file, width: 1, height: 1 };
  }
  const loaded = await loadBitmap(input.file);
  const source = loaded.bitmap;
  try {
    const sample = sampleLuminance(source, source.width, source.height, loaded.exifTurn);
    const textTurn = sample ? chooseUprightQuarterTurn(sample) : 0;
    const rotation = addQuarterTurns(loaded.exifTurn, textTurn, input.rotation);
    const crop = input.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    const sourceWidth = Math.max(1, Math.round(source.width * crop.width));
    const sourceHeight = Math.max(1, Math.round(source.height * crop.height));
    const oriented = rotatedSize(sourceWidth, sourceHeight, rotation);
    const { width, height } = fitImageWithinAiLimit(oriented.width, oriented.height);
    const scale = width / oriented.width;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器不支持图片处理");
    context.translate(width / 2, height / 2);
    context.rotate((rotation * Math.PI) / 180);
    context.drawImage(
      source,
      Math.round(source.width * crop.x),
      Math.round(source.height * crop.y),
      sourceWidth,
      sourceHeight,
      (-sourceWidth * scale) / 2,
      (-sourceHeight * scale) / 2,
      sourceWidth * scale,
      sourceHeight * scale,
    );
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => value ? resolve(value) : reject(new Error("图片转换失败")),
        "image/jpeg",
        0.9,
      );
    });
    return {
      file: new File([blob], input.file.name.replace(/\.[^.]+$/u, "") + ".jpg", { type: "image/jpeg" }),
      width,
      height,
    };
  } finally {
    source.close();
  }
}
