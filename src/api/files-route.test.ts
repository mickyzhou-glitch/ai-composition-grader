// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createReviewFilesRouteHandlers } from "./handlers";
import { ReviewService } from "../services/review-service";
import { ReviewFileStore } from "../storage/review-file-store";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "grader-files-route-"));
  roots.push(root);
  const store = new ReviewFileStore(root);
  await store.writeFile("review-1", "images", "safe.jpg", new Uint8Array([1, 2, 3]));
  await store.writeFile("review-1", "images", "marked.jpg", new Uint8Array([4, 5, 6]));
  const record = {
    id: "review-1",
    images: [{ id: 7, originalPath: "images/safe.jpg", annotationPath: "images/marked.jpg", aiPath: "images/ai.jpg" }],
  };
  const repository = { getById: (id: string) => (id === "review-1" ? record : null) };
  const reviewer = { analyze: async () => { throw new Error("unused"); } };
  const service = new ReviewService(repository as never, store, reviewer);
  return createReviewFilesRouteHandlers({ reviewService: service });
}

describe("review files route", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("用不透明 imageId 和 variant 返回当前记录中登记的图片", async () => {
    const handlers = await fixture();
    const response = await handlers.GET(
      new Request("http://local/api/reviews/review-1/files?imageId=7&variant=annotation"),
      { params: Promise.resolve({ id: "review-1" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
  });

  it.each([
    "imageId=999&variant=annotation",
    "imageId=7&variant=unknown",
    "imageId=../../secret&variant=original",
  ])("拒绝越权 id 或无效 variant：%s", async (query) => {
    const handlers = await fixture();
    const response = await handlers.GET(
      new Request(`http://local/api/reviews/review-1/files?${query}`),
      { params: Promise.resolve({ id: "review-1" }) },
    );

    expect([400, 404]).toContain(response.status);
    expect(await response.json()).toMatchObject({ ok: false });
  });
});
