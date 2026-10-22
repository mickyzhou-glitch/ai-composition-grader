// @vitest-environment node

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { chooseUprightQuarterTurn, type LuminanceImage } from "./upright-orientation";

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

async function leftIsDenser(buffer: Buffer): Promise<boolean> {
  const image = await luminanceOf(buffer);
  const cutoff = 180;
  let left = 0;
  let right = 0;
  const leftLimit = Math.floor(image.width * 0.3);
  const rightStart = Math.ceil(image.width * 0.7);
  for (let y = 0; y < image.height; y += 1) {
    const row = y * image.width;
    for (let x = 0; x < image.width; x += 1) {
      if (image.luminance[row + x] > cutoff) continue;
      if (x < leftLimit) left += 1;
      if (x >= rightStart) right += 1;
    }
  }
  return left > right;
}

describe("chooseUprightQuarterTurn", () => {
  const width = 110;
  const height = 150;

  it("空白图保持 0，已正的文字图也保持 0", async () => {
    const blank = await sharp({
      create: { width: 80, height: 120, channels: 3, background: "white" },
    }).jpeg().toBuffer();
    const upright = await jpegFromRaw(width, height, essayPixels(width, height));

    expect(chooseUprightQuarterTurn(await luminanceOf(blank))).toBe(0);
    expect(chooseUprightQuarterTurn(await luminanceOf(upright))).toBe(0);
    expect(await leftIsDenser(upright)).toBe(true);
  });

  it.each([
    [90, 270],
    [180, 180],
    [270, 90],
  ] as const)("文字被顺时针转 %i° 时转回正方向需要 %i°", async (applied, correction) => {
    const upright = await jpegFromRaw(width, height, essayPixels(width, height));
    const turned = await sharp(upright).rotate(applied).toBuffer();

    expect(chooseUprightQuarterTurn(await luminanceOf(turned))).toBe(correction);
    const restored = await sharp(turned).rotate(correction).toBuffer();
    expect(chooseUprightQuarterTurn(await luminanceOf(restored))).toBe(0);
    expect(await leftIsDenser(restored)).toBe(true);
  });
});
