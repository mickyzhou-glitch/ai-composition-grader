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
  const record = {
    id: "review-1",
    images: [{ originalPath: "images/safe.jpg", annotationPath: "images/marked.jpg", aiPath: "images/ai.jpg" }],
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

  it("只返回记录中登记的图片并设置 Content-Type", async () => {
    const handlers = await fixture();
    const response = await handlers.GET(
      new Request("http://local/api/reviews/review-1/files?path=images%2Fsafe.jpg"),
      { params: Promise.resolve({ id: "review-1" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it.each(["images/not-listed.jpg", "../secret", "/tmp/secret"])("拒绝未登记或越界路径 %s", async (filePath) => {
    const handlers = await fixture();
    const response = await handlers.GET(
      new Request(`http://local/api/reviews/review-1/files?path=${encodeURIComponent(filePath)}`),
      { params: Promise.resolve({ id: "review-1" }) },
    );

    expect([400, 404]).toContain(response.status);
    expect(await response.json()).toMatchObject({ ok: false });
  });
});
