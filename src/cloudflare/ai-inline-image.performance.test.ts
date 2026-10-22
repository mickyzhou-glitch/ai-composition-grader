import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

vi.mock("jpeg-js", () => ({
  decode: () => {
    throw new Error("JPEG_DECODE_FORBIDDEN");
  },
  encode: () => {
    throw new Error("JPEG_ENCODE_FORBIDDEN");
  },
}));

import { loadInlineAiImageUrls } from "./ai-inline-image";
import { uprightRecognitionImage } from "../images/upright-recognition";

describe("多图识别路径", () => {
  it("3 张 1500×2000 图片只内联原字节，不整图解码或重编码", async () => {
    const images = await Promise.all([0, 1, 2].map(async (index) => {
      const encoded = await sharp({
        create: {
          width: 1500,
          height: 2000,
          channels: 3,
          background: { r: 240, g: 230, b: 210 + index },
        },
      }).jpeg({ quality: 80 }).toBuffer();
      return new Uint8Array(encoded);
    }));
    const bucket = {
      get: async (key: string) => {
        const image = images[Number(key)];
        return {
          size: image.byteLength,
          arrayBuffer: async () => {
            const copy = new Uint8Array(image.byteLength);
            copy.set(image);
            return copy.buffer;
          },
        };
      },
    } as unknown as R2Bucket;

    const started = Date.now();
    const urls = await loadInlineAiImageUrls(bucket, images.map((_, index) => ({
      key: String(index),
      mimeType: "image/jpeg",
    })));
    const durationMs = Date.now() - started;

    expect(urls).toHaveLength(3);
    urls.forEach((url, index) => {
      expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
      expect(Buffer.from(url.slice("data:image/jpeg;base64,".length), "base64"))
        .toEqual(Buffer.from(images[index]));
    });
    expect(durationMs).toBeLessThan(1_500);
    await expect(uprightRecognitionImage(images[0], "image/jpeg")).resolves.toEqual({
      bytes: images[0],
      mimeType: "image/jpeg",
    });
  });
});
