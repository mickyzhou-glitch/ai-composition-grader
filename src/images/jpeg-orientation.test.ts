// @vitest-environment node

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { jpegExifQuarterTurn, readJpegExifOrientation } from "./jpeg-orientation";

describe("JPEG EXIF 方向", () => {
  it("读出方向标记并换成顺时针直角", async () => {
    const oriented = await sharp({
      create: { width: 40, height: 20, channels: 3, background: "white" },
    }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const plain = await sharp({
      create: { width: 40, height: 20, channels: 3, background: "white" },
    }).jpeg().toBuffer();

    expect(readJpegExifOrientation(oriented)).toBe(6);
    expect(jpegExifQuarterTurn(oriented)).toBe(90);
    expect(readJpegExifOrientation(plain)).toBeNull();
    expect(jpegExifQuarterTurn(plain)).toBe(0);
  });

  it.each([
    [3, 180],
    [8, 270],
  ] as const)("方向 %i 对应 %i°", async (orientation, turn) => {
    const oriented = await sharp({
      create: { width: 30, height: 16, channels: 3, background: "white" },
    }).jpeg().withMetadata({ orientation }).toBuffer();

    expect(readJpegExifOrientation(oriented)).toBe(orientation);
    expect(jpegExifQuarterTurn(oriented)).toBe(turn);
  });
});
