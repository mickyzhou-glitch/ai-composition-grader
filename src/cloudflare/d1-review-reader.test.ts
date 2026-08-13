import { describe, expect, it } from "vitest";

import { D1ReviewReader } from "./d1-review-reader";

const config = JSON.stringify({
  title: "我的老师", grade: "六年级", writingRequirements: "叙事", targetCharacters: 600,
  structureRequirements: "完整", scoringFocus: "细节", templateType: "custom",
});

function database(): D1Database {
  return {
    prepare(query: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async all() {
              if (query.includes("FROM reviews WHERE owner_id")) return { results: [{
                id: "r1", status: "draft", student_name: "小明", config, report: null, revision: 2,
                image_revision: 3, ocr_checkpoint: null, report_ocr_revision: null,
                pdf_filename: null, pdf_path: null, pdf_revision: null, exported_at: null, expires_at: null,
                created_at: 1_700_000_000_000, updated_at: 1_700_000_100_000,
              }] };
              if (query.includes("FROM review_images")) return { results: [{
                id: 7, review_id: "r1", position: 0, original_name: "essay.jpg", mime_type: "image/jpeg",
                original_path: "images/original.jpg", annotation_path: "images/annotation.jpg", ai_path: "images/ai.jpg",
                width: 100, height: 200, rotation: 0, crop: null,
              }] };
              if (query.includes("FROM annotations")) return { results: [] };
              return { results: [] };
            },
            async first() {
              if (!query.includes("INNER JOIN reviews")) return null;
              expect(args).toEqual([7, "r1", "teacher-1"]);
              return { original_path: "images/original.jpg", annotation_path: "images/annotation.jpg", ai_path: "images/ai.jpg", mime_type: "image/jpeg" };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("D1ReviewReader", () => {
  it("returns the existing page data shape and keeps R2 keys scoped to the owner", async () => {
    const reader = new D1ReviewReader(database());
    await expect(reader.list("teacher-1")).resolves.toEqual([expect.objectContaining({
      id: "r1", status: "draft", hasPdf: false, ocr: null, reportStale: false,
      images: [expect.objectContaining({ id: 7, rotation: 0 })],
    })]);
    await expect(reader.imageObjectKey("teacher-1", "r1", 7, "annotation")).resolves.toEqual({
      key: "users/teacher-1/reviews/r1/images/annotation.jpg", contentType: "image/jpeg",
    });
  });
});
