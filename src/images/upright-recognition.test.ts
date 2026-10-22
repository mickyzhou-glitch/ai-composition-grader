import { describe, expect, it } from "vitest";

import { uprightRecognitionImage } from "./upright-recognition";

describe("uprightRecognitionImage", () => {
  it("原样返回已存图片，不解码也不重编码", async () => {
    const stored = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3, 4]);
    const result = await uprightRecognitionImage(stored, "image/jpeg");

    expect(result.mimeType).toBe("image/jpeg");
    expect(result.bytes).toBe(stored);
  });
});
