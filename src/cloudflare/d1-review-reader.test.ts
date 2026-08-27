import { describe, expect, it, vi } from "vitest";

import { D1ReviewReader } from "./d1-review-reader";

const config = JSON.stringify({
  title: "我的老师", grade: "六年级", writingRequirements: "叙事", targetCharacters: 600,
  structureRequirements: "完整", scoringFocus: "细节", templateType: "custom",
});

const checkpointV2 = JSON.stringify({
  version: 2,
  sourceRevision: 3,
  ocrRevision: 1,
  editedAt: "2026-08-27T08:00:00.000Z",
  pages: [{
    pageIndex: 0,
    text: "老师修正后的第一段。",
    readable: true,
    warnings: [],
    blocks: [{ text: "原始分块", x: 0.1, y: 0.2, width: 0.5, height: 0.08 }],
  }],
  paragraphs: [{
    id: "paragraph-1",
    paragraphIndex: 0,
    text: "老师修正后的第一段。",
    segments: [{
      pageIndex: 0,
      text: "原始分段文字",
      x: 0.1,
      y: 0.2,
      width: 0.5,
      height: 0.08,
    }],
  }],
});

const paragraphReport = JSON.stringify({
  version: 2,
  themeFit: "fits",
  themeReason: "紧扣主题。",
  personalizedComment: "文章真诚。",
  painPoints: [],
  commonIssues: [],
  revisionSuggestions: [],
  grade: "A",
  diagnostics: {
    authenticityAndRelevance: { finding: "真实。", action: "保留。" },
    materialAndDetails: { finding: "细节充分。", action: "保留。" },
    structure: { finding: "结构完整。", action: "保留。" },
    language: { finding: "语言通顺。", action: "保留。" },
  },
  paragraphReviews: [{
    paragraphId: "paragraph-1",
    suggestions: [{ problem: "保留", advice: "保留原文", example: "保留。" }],
    revisedText: "老师修正后的第一段。",
  }],
  parentFeedbacks: [],
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
                pdf_filename: null, pdf_path: null, pdf_revision: null, exported_at: null,
                teacher_reviewed_at: null, expires_at: null,
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
      teacherReviewedAt: null,
      images: [expect.objectContaining({ id: 7, rotation: 0 })],
    })]);
    await expect(reader.imageObjectKey("teacher-1", "r1", 7, "annotation")).resolves.toEqual({
      key: "users/teacher-1/reviews/r1/images/annotation.jpg", contentType: "image/jpeg",
    });
  });

  it("returns a lightweight oldest-first queue scoped to unreviewed ready reports", async () => {
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn(() => ({
        all: vi.fn().mockResolvedValue({ results: [{
          id: "ready-1",
          student_name: "张小明",
          config,
          status: "ready_for_review",
          revision: 3,
          created_at: 1_700_000_000_000,
        }] }),
      })),
    }));

    await expect(new D1ReviewReader({ prepare } as unknown as D1Database).queue("teacher-1"))
      .resolves.toEqual([{
        id: "ready-1",
        studentName: "张小明",
        title: "我的老师",
        status: "ready_for_review",
        revision: 3,
        createdAt: new Date(1_700_000_000_000).toISOString(),
      }]);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("teacher_reviewed_at IS NULL"));
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("ORDER BY created_at ASC"));
  });

  it("hydrates structured v2 reports with a safe paragraph OCR view", async () => {
    const review = {
      id: "r1",
      status: "ready_for_review",
      student_name: "小明",
      config,
      report: paragraphReport,
      revision: 2,
      image_revision: 3,
      ocr_checkpoint: checkpointV2,
      report_ocr_revision: 1,
      pdf_filename: null,
      pdf_path: null,
      pdf_revision: null,
      exported_at: null,
      teacher_reviewed_at: null,
      expires_at: null,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_100_000,
    };
    const database = {
      prepare(query: string) {
        return {
          bind() {
            return {
              async all() {
                if (query.includes("FROM review_images")) return { results: [] };
                if (query.includes("FROM annotations")) return { results: [] };
                return { results: [] };
              },
              async first() {
                return query.includes("FROM reviews WHERE id") ? review : null;
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const hydrated = await new D1ReviewReader(database).get("teacher-1", "r1");

    expect(hydrated).toMatchObject({
      report: { version: 2, paragraphReviews: [{ paragraphId: "paragraph-1" }] },
      ocr: {
        version: 2,
        paragraphs: [{
          id: "paragraph-1",
          text: "老师修正后的第一段。",
          segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.08 }],
        }],
      },
    });
    expect(JSON.stringify(hydrated)).not.toContain("blocks");
    expect(JSON.stringify(hydrated)).not.toContain("原始分段文字");
  });

  it("requires every requested revision to be current and teacher reviewed before export", async () => {
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn(() => ({
        all: vi.fn().mockResolvedValue({ results: [{ id: "ready-1", revision: 3 }] }),
      })),
    }));
    const reader = new D1ReviewReader({ prepare } as unknown as D1Database);

    await expect(reader.checkExportable("teacher-1", [
      { id: "ready-1", revision: 3 },
      { id: "not-reviewed", revision: 2 },
    ])).resolves.toBe(false);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("teacher_reviewed_at IS NOT NULL"));
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("report_ocr_revision"));
  });
});
