import { describe, expect, it } from "vitest";

import { createAiImageUrl, verifyAiImageUrl } from "./ai-image-url";

describe("AI image URLs", () => {
  it("allows only the exact signed image before expiry", async () => {
    const url = new URL(await createAiImageUrl({ origin: "https://grader.example", secret: "secret", reviewId: "review-1", imageId: 7, variant: "ai", expiresAt: 2_000 }));
    await expect(verifyAiImageUrl({ secret: "secret", reviewId: "review-1", imageId: 7, variant: url.searchParams.get("variant"), expires: url.searchParams.get("expires"), signature: url.searchParams.get("signature"), now: 1_000 })).resolves.toBe("ai");
    await expect(verifyAiImageUrl({ secret: "secret", reviewId: "review-2", imageId: 7, variant: url.searchParams.get("variant"), expires: url.searchParams.get("expires"), signature: url.searchParams.get("signature"), now: 1_000 })).resolves.toBeNull();
    await expect(verifyAiImageUrl({ secret: "secret", reviewId: "review-1", imageId: 7, variant: url.searchParams.get("variant"), expires: url.searchParams.get("expires"), signature: url.searchParams.get("signature"), now: 2_001 })).resolves.toBeNull();
  });
});
