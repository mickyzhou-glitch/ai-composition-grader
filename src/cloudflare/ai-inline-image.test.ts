import { describe, expect, it } from "vitest";

import { loadInlineAiImageUrls } from "./ai-inline-image";

describe("loadInlineAiImageUrls", () => {
  it("从私有 R2 对象生成供视觉模型读取的数据 URL", async () => {
    const bucket = {
      get: async (key: string) => key === "users/teacher/reviews/review-1/images/page.jpg"
        ? { size: 2, arrayBuffer: async () => new TextEncoder().encode("hi").buffer }
        : null,
    } as unknown as R2Bucket;

    await expect(loadInlineAiImageUrls(bucket, [{
      key: "users/teacher/reviews/review-1/images/page.jpg",
      mimeType: "image/jpeg",
    }])).resolves.toEqual(["data:image/jpeg;base64,aGk="]);
  });
});
