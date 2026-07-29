import { describe, expect, it } from "vitest";

import { fitImageWithinAiLimit } from "./image-upload-transform";

describe("fitImageWithinAiLimit", () => {
  it("将手机原图限制在 AI 批改可接受的 2000px 长边", () => {
    expect(fitImageWithinAiLimit(3024, 4032)).toEqual({ width: 1500, height: 2000 });
  });

  it("不放大小于限制的图片", () => {
    expect(fitImageWithinAiLimit(1200, 1600)).toEqual({ width: 1200, height: 1600 });
  });
});
