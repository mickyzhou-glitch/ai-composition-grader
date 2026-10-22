import { decode, encode } from "jpeg-js";

import { readJpegExifOrientation } from "./jpeg-orientation";
import {
  addQuarterTurns,
  chooseUprightQuarterTurn,
  quarterTurnFromExif,
  type LuminanceImage,
  type QuarterTurn,
} from "./upright-orientation";

const SAMPLE_MAX_SIDE = 240;

function isJpeg(bytes: Uint8Array, mimeType: string): boolean {
  return mimeType === "image/jpeg"
    || mimeType === "image/jpg"
    || (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8);
}

function rotateRgba(
  data: Uint8Array,
  width: number,
  height: number,
  turn: QuarterTurn,
): { data: Uint8Array; width: number; height: number } {
  if (turn === 0) return { data, width, height };
  const nextWidth = turn === 180 ? width : height;
  const nextHeight = turn === 180 ? height : width;
  const out = new Uint8Array(nextWidth * nextHeight * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let nextX = x;
      let nextY = y;
      if (turn === 90) {
        nextX = height - 1 - y;
        nextY = x;
      } else if (turn === 180) {
        nextX = width - 1 - x;
        nextY = height - 1 - y;
      } else {
        nextX = y;
        nextY = width - 1 - x;
      }
      const source = (y * width + x) * 4;
      const target = (nextY * nextWidth + nextX) * 4;
      out[target] = data[source] ?? 0;
      out[target + 1] = data[source + 1] ?? 0;
      out[target + 2] = data[source + 2] ?? 0;
      out[target + 3] = data[source + 3] ?? 255;
    }
  }
  return { data: out, width: nextWidth, height: nextHeight };
}

function sampleLuminance(
  data: Uint8Array,
  width: number,
  height: number,
): LuminanceImage {
  const scale = Math.min(1, SAMPLE_MAX_SIDE / Math.max(width, height, 1));
  const sampleWidth = Math.max(1, Math.round(width * scale));
  const sampleHeight = Math.max(1, Math.round(height * scale));
  const luminance = new Uint8Array(sampleWidth * sampleHeight);
  for (let y = 0; y < sampleHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < sampleWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.floor(x / scale));
      const offset = (sourceY * width + sourceX) * 4;
      luminance[y * sampleWidth + x] = Math.round(
        (data[offset] ?? 255) * 0.299
        + (data[offset + 1] ?? 255) * 0.587
        + (data[offset + 2] ?? 255) * 0.114,
      );
    }
  }
  return { width: sampleWidth, height: sampleHeight, luminance };
}

function uprightJpegBytes(bytes: Uint8Array): Uint8Array {
  let decoded: { width: number; height: number; data: Uint8Array };
  try {
    decoded = decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: 60,
    });
  } catch {
    return bytes;
  }
  if (decoded.width < 1 || decoded.height < 1 || decoded.data.length < decoded.width * decoded.height * 4) {
    return bytes;
  }
  const orientation = readJpegExifOrientation(bytes);
  const exifTurn = quarterTurnFromExif(orientation);
  const exifNeedsBake = orientation !== null && orientation > 1;
  const exifOriented = rotateRgba(decoded.data, decoded.width, decoded.height, exifTurn);
  const textTurn = chooseUprightQuarterTurn(sampleLuminance(
    exifOriented.data,
    exifOriented.width,
    exifOriented.height,
  ));
  const total = addQuarterTurns(exifTurn, textTurn);
  if (total === 0 && !exifNeedsBake) return bytes;
  const output = total === exifTurn
    ? exifOriented
    : rotateRgba(decoded.data, decoded.width, decoded.height, total);
  try {
    const encoded = encode(
      { data: output.data, width: output.width, height: output.height },
      92,
    );
    return new Uint8Array(encoded.data);
  } catch {
    return bytes;
  }
}

interface SharpPipeline {
  autoOrient(): SharpPipeline;
  rotate(angle: number): SharpPipeline;
  resize(options: { width: number; height: number; fit: "inside"; withoutEnlargement: boolean }): SharpPipeline;
  greyscale(): SharpPipeline;
  raw(): SharpPipeline;
  metadata(): Promise<{ orientation?: number; format?: string }>;
  png(): { toBuffer(): Promise<Uint8Array> };
  webp(options: { quality: number }): { toBuffer(): Promise<Uint8Array> };
  jpeg(options: { quality: number }): { toBuffer(): Promise<Uint8Array> };
  toBuffer(options: { resolveWithObject: true }): Promise<{
    data: Uint8Array;
    info: { width: number; height: number };
  }>;
}

type SharpFactory = (input: Uint8Array, options?: { failOn?: "error" }) => SharpPipeline;

async function loadSharp(): Promise<SharpFactory | null> {
  try {
    const load = new Function("return import('sharp')") as () => Promise<{ default?: SharpFactory }>;
    const loaded = await load();
    const sharp = loaded.default ?? (loaded as unknown as SharpFactory);
    return typeof sharp === "function" ? sharp : null;
  } catch {
    return null;
  }
}

async function uprightWithSharp(
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  const sample = await sharp(bytes, { failOn: "error" })
    .autoOrient()
    .resize({ width: SAMPLE_MAX_SIDE, height: SAMPLE_MAX_SIDE, fit: "inside", withoutEnlargement: true })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const turn = chooseUprightQuarterTurn({
    width: sample.info.width,
    height: sample.info.height,
    luminance: sample.data,
  });
  const metadata = await sharp(bytes, { failOn: "error" }).metadata();
  const exifNeedsBake = metadata.orientation !== undefined && metadata.orientation > 1;
  if (turn === 0 && !exifNeedsBake) return { bytes, mimeType };
  let pipeline = sharp(bytes, { failOn: "error" }).autoOrient();
  if (turn !== 0) pipeline = pipeline.rotate(turn);
  const format = metadata.format === "png" ? "png" : metadata.format === "webp" ? "webp" : "jpeg";
  const encoded = format === "png"
    ? await pipeline.png().toBuffer()
    : format === "webp"
      ? await pipeline.webp({ quality: 92 }).toBuffer()
      : await pipeline.jpeg({ quality: 92 }).toBuffer();
  return {
    bytes: new Uint8Array(encoded),
    mimeType: format === "jpeg" ? "image/jpeg" : `image/${format}`,
  };
}

/**
 * Turn a stored essay photo upright before whole-image recognition.
 * JPEG is handled in pure JavaScript so the Cloudflare worker can rotate
 * pixels. PNG and WebP use sharp when this process can load it, and stay
 * unchanged when it cannot.
 */
export async function uprightRecognitionImage(
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (isJpeg(bytes, mimeType)) {
    return { bytes: uprightJpegBytes(bytes), mimeType: "image/jpeg" };
  }
  try {
    return await uprightWithSharp(bytes, mimeType) ?? { bytes, mimeType };
  } catch {
    return { bytes, mimeType };
  }
}
