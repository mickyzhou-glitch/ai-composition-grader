// @vitest-environment node

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { chooseUprightQuarterTurn, type LuminanceImage } from "./upright-orientation";
import { uprightRecognitionImage } from "./upright-recognition";

function essayPixels(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height, 255);
  const lines = [
    { y: 18, x0: 14, x1: 78 },
    { y: 34, x0: 14, x1: 46 },
    { y: 50, x0: 14, x1: 88 },
    { y: 66, x0: 14, x1: 40 },
    { y: 82, x0: 14, x1: 70 },
    { y: 98, x0: 14, x1: 58 },
  ];
  for (const line of lines) {
    for (let thickness = -1; thickness <= 1; thickness += 1) {
      const y = line.y + thickness;
      for (let x = line.x0; x <= line.x1; x += 1) data[y * width + x] = 12;
    }
  }
  return data;
}

async function jpegFromRaw(width: number, height: number, pixels: Buffer): Promise<Buffer> {
  return sharp(pixels, { raw: { width, height, channels: 1 } }).jpeg({ quality: 95 }).toBuffer();
}

async function luminanceOf(buffer: Buffer): Promise<LuminanceImage> {
  const { data, info } = await sharp(buffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, luminance: data };
}

describe("uprightRecognitionImage", () => {
  const width = 110;
  const height = 150;

  it("已转正的 JPEG 保持原字节，无法解码的内容也不改写", async () => {
    const upright = await jpegFromRaw(width, height, essayPixels(width, height));
    const kept = await uprightRecognitionImage(upright, "image/jpeg");
    const garbage = new Uint8Array([1, 2, 3, 4]);

    expect(Buffer.compare(Buffer.from(kept.bytes), upright)).toBe(0);
    expect(kept.mimeType).toBe("image/jpeg");
    await expect(uprightRecognitionImage(garbage, "image/jpeg")).resolves.toEqual({
      bytes: garbage,
      mimeType: "image/jpeg",
    });
  });

  it.each([90, 180, 270] as const)("把顺时针转了 %i° 的整页 JPEG 转正", async (applied) => {
    const upright = await jpegFromRaw(width, height, essayPixels(width, height));
    const turned = await sharp(upright).rotate(applied).toBuffer();
    const restored = await uprightRecognitionImage(turned, "image/jpeg");

    expect(chooseUprightQuarterTurn(await luminanceOf(Buffer.from(restored.bytes)))).toBe(0);
    expect(restored.mimeType).toBe("image/jpeg");
  });

  it("EXIF 方向和文字方向都会被烤进像素", async () => {
    const upright = await jpegFromRaw(width, height, essayPixels(width, height));
    const tagged = await sharp(upright).withMetadata({ orientation: 6 }).toBuffer();
    const restored = await uprightRecognitionImage(new Uint8Array(tagged), "image/jpeg");

    expect(chooseUprightQuarterTurn(await luminanceOf(Buffer.from(restored.bytes)))).toBe(0);
    expect(Buffer.compare(Buffer.from(restored.bytes), tagged)).not.toBe(0);
  });
});
