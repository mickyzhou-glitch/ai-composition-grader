// @vitest-environment node
import { composeReviewGuidance } from "../grading-opinions/review-guidance";
import { describe, expect, it, vi } from "vitest";

import { d1Shim, migratedDatabase } from "../../test/d1-sqlite-shim";
import { savePipelineResult } from "../../worker/index";
import { D1ImageWriter } from "./d1-image-writer";
import { D1OcrCheckpointRepository } from "./d1-ocr-checkpoint";
import { D1Reanalysis } from "./d1-reanalysis";
import { D1ReviewReader } from "./d1-review-reader";
import { D1ReviewWriter } from "./d1-review-writer";

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
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        all: vi.fn().mockResolvedValue({ results: [{
          id: "ready-1",
          class_name: "六（1）班",
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
        className: "六（1）班",
        studentName: "张小明",
        title: "我的老师",
        status: "ready_for_review",
        revision: 3,
        createdAt: new Date(1_700_000_000_000).toISOString(),
      }]);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("teacher_reviewed_at IS NULL"));
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("ORDER BY created_at ASC"));
  });

  it.each([
    { jobGuidance: null, draft: undefined, expected: "" },
    { jobGuidance: composeReviewGuidance(null, [], [{ text: "旧五段式", createdAt: 1 }]), draft: undefined, expected: "" },
    { jobGuidance: "旧要求", draft: "", expected: "" },
    { jobGuidance: "生成时指导", draft: "尚未生成的指导草稿", expected: "尚未生成的指导草稿" },
  ])("hydrates current draft independently of job/history $expected", async ({ jobGuidance, draft, expected }) => {
    const review = {
      id: "r1",
      status: "ready_for_review",
      student_name: "小明",
      config,
      report: JSON.stringify({ ...JSON.parse(paragraphReport), ...(draft !== undefined ? { teacherGuidanceDraft: draft } : {}) }),
      teacher_guidance: jobGuidance,
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
      teacherGuidance: expected,
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
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        all: vi.fn().mockResolvedValue({ results: [{ id: "ready-1", revision: 3 }] }),
      })),
    }));
    const reader = new D1ReviewReader({ prepare } as unknown as D1Database);

    await expect(reader.checkExportable("teacher-1", [
      { id: "ready-1", revision: 3 },
      { id: "not-reviewed", revision: 2 },
    ])).resolves.toBe(false);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("owner_id = ?"));
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("ocr_checkpoint"));
  });

  it("parses report and OCR and requires every requested entry to pass the shared gate", async () => {
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn(() => ({
        all: vi.fn().mockResolvedValue(query.includes("FROM review_images")
          ? { results: [{ position: 0, width: 1000, height: 1500 }] }
          : { results: [{
              id: "ready-1", revision: 3, report: paragraphReport,
              image_revision: 3, ocr_checkpoint: checkpointV2, report_ocr_revision: 1,
              teacher_reviewed_at: Date.parse("2026-08-27T09:00:00.000Z"),
            }] }),
      })),
    }));

    await expect(new D1ReviewReader({ prepare } as unknown as D1Database).checkExportable(
      "teacher-1",
      [{ id: "ready-1", revision: 3 }],
    )).resolves.toBe(true);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("batches images, annotations, and failure queries in list() instead of N+1 queries per review", async () => {
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn(() => ({
        all: vi.fn().mockImplementation(async () => {
          if (query.includes("FROM reviews WHERE owner_id")) {
            return {
              results: [
                {
                  id: "r1", status: "draft", student_name: "小明", class_name: "六1", config, report: null, revision: 1,
                  image_revision: 1, ocr_checkpoint: null, report_ocr_revision: null,
                  pdf_filename: null, pdf_path: null, pdf_revision: null, exported_at: null,
                  teacher_reviewed_at: null, rejection_reason: null, rejection_change_request: null, expires_at: null,
                  created_at: 1_700_000_000_000, updated_at: 1_700_000_200_000,
                },
                {
                  id: "r2", status: "failed", student_name: "小红", class_name: "六1", config, report: null, revision: 2,
                  image_revision: 1, ocr_checkpoint: null, report_ocr_revision: null,
                  pdf_filename: null, pdf_path: null, pdf_revision: null, exported_at: null,
                  teacher_reviewed_at: null, rejection_reason: null, rejection_change_request: null, expires_at: null,
                  created_at: 1_700_000_000_000, updated_at: 1_700_000_100_000,
                },
                {
                  id: "r3", status: "ready_for_review", student_name: "小刚", class_name: "六2", config, report: paragraphReport, revision: 3,
                  image_revision: 3, ocr_checkpoint: checkpointV2, report_ocr_revision: 1,
                  pdf_filename: null, pdf_path: null, pdf_revision: null, exported_at: null,
                  teacher_reviewed_at: null, rejection_reason: null, rejection_change_request: null, expires_at: null,
                  created_at: 1_700_000_000_000, updated_at: 1_700_000_050_000,
                },
              ],
            };
          }
          if (query.includes("FROM review_images")) {
            return {
              results: [
                {
                  id: 11, review_id: "r1", position: 0, original_name: "a.jpg", mime_type: "image/jpeg",
                  original_path: "images/a.jpg", annotation_path: "images/a.jpg", ai_path: "images/a.jpg",
                  width: 100, height: 200, rotation: 0, crop: null,
                },
                {
                  id: 12, review_id: "r3", position: 0, original_name: "c.jpg", mime_type: "image/jpeg",
                  original_path: "images/c.jpg", annotation_path: "images/c.jpg", ai_path: "images/c.jpg",
                  width: 100, height: 200, rotation: 0, crop: null,
                },
              ],
            };
          }
          if (query.includes("FROM annotations")) {
            return {
              results: [
                {
                  review_id: "r3", position: 0, page_index: 0, x: 0.2, y: 0.3,
                  category: "highlight", anchor_text: "好句", comment: "生动", is_highlight: 1,
                },
              ],
            };
          }
          if (query.includes("FROM analysis_jobs")) {
            return {
              results: [
                { review_id: "r2", error_code: "ANALYSIS_TIMEOUT", progress_stage: "generating_review", message: null },
                { review_id: "r2", error_code: "AI_REQUEST_FAILED", progress_stage: "reading_images", message: null },
              ],
            };
          }
          return { results: [] };
        }),
      })),
    }));

    const list = await new D1ReviewReader({ prepare } as unknown as D1Database).list("teacher-1") as Array<Record<string, unknown>>;
    expect(list).toHaveLength(3);
    // 1 reviews query + 1 batched images query + 1 batched annotations query + 1 batched failures query = 4 total (not 1 + 3*2 + 1 = 8)
    expect(prepare).toHaveBeenCalledTimes(4);
    expect(list[0]).toMatchObject({ id: "r1", images: [expect.objectContaining({ id: 11 })], annotations: [] });
    expect(list[1]).toMatchObject({
      id: "r2",
      images: [],
      analysisFailure: expect.objectContaining({ summary: expect.stringContaining("超时") }),
    });
    expect(list[2]).toMatchObject({
      id: "r3",
      images: [expect.objectContaining({ id: 12 })],
      annotations: [expect.objectContaining({ anchorText: "好句" })],
    });
  });

  it("batches image lookups in checkExportable across multiple reviews", async () => {
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn(() => ({
        all: vi.fn().mockResolvedValue(query.includes("FROM review_images")
          ? {
              results: [
                { review_id: "ready-1", position: 0, width: 1000, height: 1500 },
                { review_id: "ready-2", position: 0, width: 1000, height: 1500 },
              ],
            }
          : {
              results: [
                {
                  id: "ready-1", revision: 3, report: paragraphReport,
                  image_revision: 3, ocr_checkpoint: checkpointV2, report_ocr_revision: 1,
                  teacher_reviewed_at: Date.parse("2026-08-27T09:00:00.000Z"),
                },
                {
                  id: "ready-2", revision: 4, report: paragraphReport,
                  image_revision: 3, ocr_checkpoint: checkpointV2, report_ocr_revision: 1,
                  teacher_reviewed_at: Date.parse("2026-08-27T09:00:00.000Z"),
                },
              ],
            }),
      })),
    }));

    await expect(new D1ReviewReader({ prepare } as unknown as D1Database).checkExportable(
      "teacher-1",
      [{ id: "ready-1", revision: 3 }, { id: "ready-2", revision: 4 }],
    )).resolves.toBe(true);
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it("queries only requested review IDs when list() receives an ids filter", async () => {
    const boundArgs: unknown[][] = [];
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn((...args: unknown[]) => {
        boundArgs.push([query, ...args]);
        return {
          all: vi.fn().mockImplementation(async () => {
            if (query.includes("FROM reviews WHERE owner_id") && query.includes("id IN (")) {
              return {
                results: [{
                  id: "r-analyzing", status: "ready_for_review", student_name: "小林", class_name: "六1", config, report: paragraphReport, revision: 2,
                  image_revision: 3, ocr_checkpoint: checkpointV2, report_ocr_revision: 1,
                  pdf_filename: null, pdf_path: null, pdf_revision: null, exported_at: null,
                  teacher_reviewed_at: null, rejection_reason: null, rejection_change_request: null, expires_at: null,
                  created_at: 1_700_000_000_000, updated_at: 1_700_000_300_000,
                }],
              };
            }
            return { results: [] };
          }),
        };
      }),
    }));

    const reader = new D1ReviewReader({ prepare } as unknown as D1Database);
    await expect(reader.list("teacher-1", { ids: [] })).resolves.toEqual([]);
    expect(prepare).not.toHaveBeenCalled();

    const items = await reader.list("teacher-1", { ids: ["r-analyzing", "r-analyzing"] }) as Array<{ id: string; status: string }>;
    expect(items).toMatchObject([{ id: "r-analyzing", status: "ready_for_review" }]);
    expect(boundArgs[0]?.slice(1)).toEqual(["teacher-1", "r-analyzing"]);
  });

  it("queries only reviewed unexported records when list() uses pending_export scope", async () => {
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        all: vi.fn().mockResolvedValue({ results: [] }),
      })),
    }));
    await expect(new D1ReviewReader({ prepare } as unknown as D1Database).list("teacher-1", { scope: "pending_export" }))
      .resolves.toEqual([]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("teacher_reviewed_at IS NOT NULL"));
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("status <> 'exported'"));
  });

  it("paginates summaries on real migrated SQLite, filters by class/status/name, and keeps first-page payload small at semester scale", async () => {
    const sqlite = migratedDatabase();
    try {
      const db = d1Shim(sqlite);
      const largeParagraphText = "春风吹绿了操场边的柳树，同学们在跑道上奋力奔跑。".repeat(12);
      const heavyReportObj = {
        ...JSON.parse(paragraphReport),
        paragraphReviews: Array.from({ length: 5 }, (_, index) => ({
          paragraphId: `paragraph-${index + 1}`,
          suggestions: [{ advice: `第${index + 1}段补充动作与神态细节` }],
          revisedText: largeParagraphText,
        })),
        rewrittenEssay: Array.from({ length: 5 }, () => largeParagraphText),
      };
      const heavyCheckpointObj = {
        version: 2,
        sourceRevision: 1,
        ocrRevision: 0,
        editedAt: null,
        pages: [{
          pageIndex: 0,
          text: largeParagraphText,
          readable: true,
          warnings: [],
          blocks: [{ text: largeParagraphText, x: 0.1, y: 0.1, width: 0.6, height: 0.08 }],
        }],
        paragraphs: Array.from({ length: 5 }, (_, index) => ({
          id: `paragraph-${index + 1}`,
          paragraphIndex: index,
          text: largeParagraphText,
          segments: [{ pageIndex: 0, text: largeParagraphText, x: 0.1, y: 0.1 * (index + 1), width: 0.6, height: 0.08 }],
        })),
      };

      const insertReview = sqlite.prepare(`
        INSERT INTO reviews (
          id, owner_id, status, student_name, class_name, config, report, revision, image_revision,
          ocr_checkpoint, report_ocr_revision, exported_at, teacher_reviewed_at,
          has_report, summary_title, summary_grade, summary_is_legacy,
          ocr_revision_cached, export_ready_version, export_blocked_reason, summary_state_key,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 3, 1, ?, ?, ?, ?, ?, '我的老师', ?, 0, ?, ?, ?, ?, ?, ?)
      `);
      const insertImage = sqlite.prepare(`
        INSERT INTO review_images (
          review_id, page_index, path, position, original_name, mime_type,
          original_path, annotation_path, ai_path, width, height, rotation, created_at
        ) VALUES (?, 0, 'images/p.jpg', 0, 'p.jpg', 'image/jpeg', 'images/p.jpg', 'images/p.jpg', 'images/p.jpg', 1200, 1600, 0, 1)
      `);
      const insertFailedJob = sqlite.prepare(`
        INSERT INTO analysis_jobs (
          id, review_id, owner_id, mode, status, attempt, available_at, progress_stage, error_code, created_at, finished_at
        ) VALUES (?, ?, ?, 'full', 'failed', 1, 1, 'generating_review', 'ANALYSIS_TIMEOUT', 10, 20)
      `);

      sqlite.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES ('u-small', 'small', 'x', 'teacher', 0, 1, 1)").run();

      const seedOwner = (ownerId: string, count: number) => {
        const tx = sqlite.transaction(() => {
          for (let idx = 0; idx < count; idx += 1) {
            const id = `${ownerId}-sem-${idx + 1}`;
            const isPendingExport = idx === 0 || idx === 35;
            const isFailed = idx === 1 || idx === 42;
            const status = isFailed
              ? "failed"
              : isPendingExport
                ? "ready_for_review"
                : idx < 10
                  ? "ready_for_review"
                  : "exported";
            const reviewedAt = (isPendingExport || status === "exported") ? 1_700_000_400_000 : null;
            const exportedAt = status === "exported" ? 1_700_000_500_000 : null;
            const hasReport = isFailed ? 0 : 1;
            const ocrRev = isFailed ? null : 0;
            const readyVer = (isPendingExport || status === "exported") ? "3:1:0:0" : null;
            const blockedReason = isFailed
              ? "批改报告尚未完成"
              : readyVer
                ? null
                : "尚未经过老师审核";
            const stateKey = `3:1:${ocrRev ?? -1}:${ocrRev ?? -1}:${status}:${reviewedAt ?? -1}`;
            insertReview.run(
              id,
              ownerId,
              status,
              idx % 2 === 0 ? `陈虚构${idx + 1}` : `林测试${idx + 1}`,
              idx % 3 === 0 ? "六（1）班" : "六（2）班",
              config,
              isFailed ? null : JSON.stringify(heavyReportObj),
              isFailed ? null : JSON.stringify(heavyCheckpointObj),
              ocrRev,
              exportedAt,
              reviewedAt,
              hasReport,
              isFailed ? null : "A",
              ocrRev,
              readyVer,
              blockedReason,
              stateKey,
              1_700_000_000_000 + idx * 1000,
              1_700_100_000_000 - idx * 1000,
            );
            insertImage.run(id);
            if (isFailed) {
              insertFailedJob.run(`job-${id}`, id, ownerId);
            }
          }
        });
        tx();
      };

      seedOwner("u-small", 5);
      seedOwner("u1", 160);

      const reader = new D1ReviewReader(db);
      const smallSummaryBytes = Buffer.byteLength(JSON.stringify(await reader.summaryPage("u-small", { page: 1, pageSize: 20 })));
      const semesterFullListBytes = Buffer.byteLength(JSON.stringify(await reader.list("u1")));
      const semesterFirstPage = await reader.summaryPage("u1", { page: 1, pageSize: 20 });
      const semesterSummaryBytes = Buffer.byteLength(JSON.stringify(semesterFirstPage));

      expect(semesterFirstPage.items).toHaveLength(20);
      expect(semesterFirstPage.stats.total).toBe(160);
      expect(semesterFirstPage.stats.reviewed).toBe(2);
      expect(semesterFirstPage.exportableReviewedIds).toEqual(["u1-sem-1", "u1-sem-36"]);
      expect(semesterFirstPage.matchingFailed.map(({ id }) => id)).toEqual(["u1-sem-2", "u1-sem-43"]);
      expect(semesterFirstPage.classes).toEqual(["六（1）班", "六（2）班"]);
      expect(JSON.stringify(semesterFirstPage.items)).not.toContain(largeParagraphText);
      expect(semesterSummaryBytes).toBeLessThan(semesterFullListBytes * 0.05);
      expect(smallSummaryBytes).toBeLessThan(semesterSummaryBytes);

      const filteredPage = await reader.summaryPage("u1", {
        page: 1,
        pageSize: 20,
        classFilter: "六（1）班",
        statusFilter: "reviewed",
        studentSearch: "陈虚构",
      });
      expect(filteredPage.totalFiltered).toBe(1);
      expect(filteredPage.items.map(({ id }) => id)).toEqual(["u1-sem-1"]);
    } finally {
      sqlite.close();
    }
  });

  it("bounds D1 work when 60+ approved pending-export essays exist and search matches 1 essay: zero report/ocr_checkpoint/review_images reads", async () => {
    const sqlite = migratedDatabase();
    try {
      const baseDb = d1Shim(sqlite);
      const writer = new D1ReviewWriter(baseDb);
      const imageWriter = new D1ImageWriter(baseDb);
      const ocrRepo = new D1OcrCheckpointRepository(baseDb);
      const parsedConfig = JSON.parse(config);
      const parsedReport = JSON.parse(paragraphReport);

      // 通过真实业务写入器创建 61 篇已复核待导出（其中第 61 篇随后修改 OCR 使报告过期）+ 40 篇已导出
      const createdIds: string[] = [];
      for (let i = 0; i < 101; i += 1) {
        const studentName = i === 25 ? "陈目标唯一" : `李常规${i + 1}`;
        const created = await writer.create("u1", {
          config: parsedConfig,
          studentName,
          className: "六（1）班",
        });
        createdIds.push(created.id);
        const replaced = await imageWriter.replace("u1", created.id, created.revision, [{
          originalName: "page1.jpg",
          mimeType: "image/jpeg",
          width: 1200,
          height: 1600,
          path: "images/page1.jpg",
        }], true);
        const jobId = `job-${i + 1}`;
        sqlite.prepare(`
          UPDATE reviews SET status = 'analyzing', analysis_run_id = ? WHERE id = ?
        `).run(jobId, created.id);
        sqlite.prepare(`
          INSERT INTO analysis_jobs (id, review_id, owner_id, mode, status, attempt, available_at, progress_stage, created_at)
          VALUES (?, ?, 'u1', 'full', 'running', 1, 1, 'generating_review', 1)
        `).run(jobId, created.id);
        const savedOcr = await ocrRepo.saveRecognized("u1", created.id, 1, {
          pages: [{
            pageIndex: 0,
            text: "老师修正后的第一段。",
            readable: true,
            warnings: [],
            blocks: [{ text: "老师修正后的第一段。", x: 0.1, y: 0.2, width: 0.5, height: 0.08 }],
          }],
          paragraphs: [{
            paragraphIndex: 0,
            text: "老师修正后的第一段。",
            segments: [{ pageIndex: 0, text: "老师修正后的第一段。", x: 0.1, y: 0.2, width: 0.5, height: 0.08 }],
          }],
        }, jobId);
        await savePipelineResult(baseDb, {
          id: jobId,
          reviewId: created.id,
          ownerId: "u1",
          mode: "full",
          imageRevision: 1,
          config: parsedConfig,
        }, {
          report: parsedReport,
          annotations: [],
          ocrRevision: savedOcr.ocrRevision,
        });
        await writer.completeTeacherReview("u1", created.id, {
          expectedRevision: replaced.revision + 1,
          studentName,
          report: parsedReport,
          annotations: [],
        });
        if (i >= 61) {
          await writer.markExported("u1", created.id);
        }
      }

      // 将第 61 篇（index 60）修改 OCR 原文，使其报告过期，不应再进入 exportableReviewedIds
      await ocrRepo.editParagraphTexts("u1", createdIds[60]!, 0, [{
        paragraphId: "paragraph-1",
        text: "老师事后修改了识别原文，批改报告已过期。",
      }]);

      const executedQueries: Array<{ sql: string; rowCount: number }> = [];
      const instrumentedDb: D1Database = {
        prepare(sql: string) {
          const inner = baseDb.prepare(sql);
          return {
            bind(...args: unknown[]) {
              const bound = inner.bind(...args);
              return {
                async all<T = Record<string, unknown>>() {
                  const res = await bound.all<T>();
                  executedQueries.push({ sql, rowCount: res.results?.length ?? 0 });
                  return res;
                },
                async first<T = unknown>() {
                  const row = await bound.first<T>();
                  executedQueries.push({ sql, rowCount: row ? 1 : 0 });
                  return row;
                },
                run: () => bound.run(),
              } as unknown as D1PreparedStatement;
            },
          } as unknown as D1PreparedStatement;
        },
        batch: (stmts: D1PreparedStatement[]) => baseDb.batch(stmts),
      } as unknown as D1Database;

      const reader = new D1ReviewReader(instrumentedDb);
      const result = await reader.summaryPage("u1", {
        page: 1,
        pageSize: 20,
        classFilter: "六（1）班",
        studentSearch: "陈目标唯一",
      });

      // 60 篇有效待导出全部识别，第 61 篇 OCR 过期被排除；搜索仅命中 1 篇
      expect(result.stats.total).toBe(101);
      expect(result.stats.reviewed).toBe(61);
      expect(result.stats.exported).toBe(40);
      expect(result.exportableReviewedIds).toHaveLength(60);
      expect(result.exportableReviewedIds).not.toContain(createdIds[60]);
      expect(result.totalFiltered).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        id: createdIds[25],
        studentName: "陈目标唯一",
        grade: "A",
        exportEligibility: { eligible: true },
      });

      // 核心数据库工作量断言：全程不读 reviews.report、reviews.ocr_checkpoint、reviews.config、review_images，且分页查询仅返回 1 行
      for (const { sql } of executedQueries) {
        expect(sql).not.toMatch(/\breport\b/u);
        expect(sql).not.toMatch(/\bocr_checkpoint\b/u);
        expect(sql).not.toMatch(/\bconfig\b/u);
        expect(sql).not.toMatch(/\breview_images\b/u);
      }
      const pageQuery = executedQueries.find(({ sql }) => sql.includes("LIMIT ? OFFSET ?"));
      expect(pageQuery).toBeDefined();
      expect(pageQuery?.rowCount).toBe(1);

      // 进一步验证：已审核 v2 记录通过 D1ReviewWriter.update 修改报告后，summary_state_key 不会置空，且 pendingExportSummaries 同样零大字段读取
      const targetId = createdIds[25]!;
      const updated = await writer.update("u1", targetId, {
        expectedRevision: 3,
        report: {
          ...parsedReport,
          grade: "A+",
        },
      });
      expect(updated?.revision).toBe(4);
      const stateKeyRow = sqlite.prepare("SELECT summary_state_key, export_ready_version, summary_grade FROM reviews WHERE id = ?").get(targetId) as {
        summary_state_key: string | null;
        export_ready_version: string | null;
        summary_grade: string | null;
      };
      expect(stateKeyRow.summary_state_key).not.toBeNull();
      expect(stateKeyRow.export_ready_version).toBe("4:1:0:0");
      expect(stateKeyRow.summary_grade).toBe("A+");

      executedQueries.length = 0;
      const pendingSummaries = await reader.pendingExportSummaries("u1");
      expect(pendingSummaries).toHaveLength(61);
      expect(pendingSummaries.find((s) => s.id === targetId)).toMatchObject({
        grade: "A+",
        exportEligibility: { eligible: true },
        diagnostics: {
          authenticityAndRelevance: { finding: "真实。", action: "保留。" },
          structure: { finding: "结构完整。", action: "保留。" },
        },
      });
      for (const { sql } of executedQueries) {
        expect(sql).not.toMatch(/\breport\b/u);
        expect(sql).not.toMatch(/\bocr_checkpoint\b/u);
        expect(sql).not.toMatch(/\bconfig\b/u);
        expect(sql).not.toMatch(/\breview_images\b/u);
        expect(sql).not.toMatch(/\bannotations\b/u);
      }

      // 极端容错边界：即便手工把 45 条历史记录的 summary_state_key 置空，backfillReviewSummaryBatch 与 summaryPage 均严格封顶单次 <= 20 条，且暴露剩余待回填篇数防止漏导
      sqlite.prepare("UPDATE reviews SET summary_state_key = NULL, export_ready_version = NULL WHERE id IN (" + createdIds.slice(0, 45).map(() => "?").join(",") + ")").run(...createdIds.slice(0, 45));
      executedQueries.length = 0;
      const partialPage1 = await reader.summaryPage("u1", { page: 1, pageSize: 20 });
      const backfillReads = executedQueries.filter(({ sql }) => /\breport\b/u.test(sql));
      expect(backfillReads.length).toBeLessThanOrEqual(1);
      expect(backfillReads[0]?.rowCount ?? 0).toBe(20);
      expect(partialPage1.summaryBackfillPending).toBe(25);

      const partialPage2 = await reader.summaryPage("u1", { page: 1, pageSize: 20 });
      expect(partialPage2.summaryBackfillPending).toBe(5);

      const settledPage = await reader.summaryPage("u1", { page: 1, pageSize: 20 });
      expect(settledPage.summaryBackfillPending).toBeUndefined();
      expect(settledPage.exportableReviewedIds).toHaveLength(60);

      // Major 2A 并发回归：摘要回填读取快照后、写入前，真实 OCR 写入器将 ocrRevision 从 0 改为 1 -> 摘要资格与最终门禁必须一致为不可导出
      const raceBackfillId = createdIds[0]!;
      sqlite.prepare("UPDATE reviews SET summary_state_key = NULL, export_ready_version = NULL WHERE id = ?").run(raceBackfillId);
      let injectedBackfillOcrEdit = false;
      const racingBackfillDb: D1Database = {
        prepare(sql: string) {
          const inner = baseDb.prepare(sql);
          return {
            bind(...args: unknown[]) {
              const bound = inner.bind(...args);
              return {
                async all<T = Record<string, unknown>>() {
                  const res = await bound.all<T>();
                  if (!injectedBackfillOcrEdit && sql.includes("FROM reviews") && sql.includes("summary_state_key")) {
                    injectedBackfillOcrEdit = true;
                    await ocrRepo.editParagraphTexts("u1", raceBackfillId, 0, [{
                      paragraphId: "paragraph-1",
                      text: "回填并发瞬间老师修正了识别原文。",
                    }]);
                  }
                  return res;
                },
                first: <T = unknown>() => bound.first<T>(),
                run: () => bound.run(),
              } as unknown as D1PreparedStatement;
            },
          } as unknown as D1PreparedStatement;
        },
        batch: (stmts: D1PreparedStatement[]) => baseDb.batch(stmts),
      } as unknown as D1Database;

      const afterBackfillRace = await new D1ReviewReader(racingBackfillDb).summaryPage("u1", { page: 1, pageSize: 20 });
      expect(injectedBackfillOcrEdit).toBe(true);
      const dbAfterBackfillRace = sqlite.prepare("SELECT revision, ocr_checkpoint, ocr_revision_cached, export_ready_version FROM reviews WHERE id = ?").get(raceBackfillId) as {
        revision: number;
        ocr_checkpoint: string;
        ocr_revision_cached: number | null;
        export_ready_version: string | null;
      };
      expect(JSON.parse(dbAfterBackfillRace.ocr_checkpoint).ocrRevision).toBe(1);
      expect(dbAfterBackfillRace.ocr_revision_cached).toBe(1);
      expect(dbAfterBackfillRace.export_ready_version).toBeNull();
      expect(afterBackfillRace.exportableReviewedIds).not.toContain(raceBackfillId);
      await expect(new D1ReviewReader(baseDb).checkExportable("u1", [
        { id: raceBackfillId, revision: dbAfterBackfillRace.revision },
      ])).resolves.toBe(false);

      // Major 2B 并发回归：仅改姓名/班级/批注的 D1ReviewWriter.update 读取快照后、写入前，OCR 修正并发把 ocrRevision 从 0 改为 1
      const raceUpdateId = createdIds[1]!;
      const beforeUpdateRow = sqlite.prepare("SELECT revision FROM reviews WHERE id = ?").get(raceUpdateId) as { revision: number };
      let injectedUpdateOcrEdit = false;
      const racingWriterDb: D1Database = {
        prepare(sql: string) {
          const inner = baseDb.prepare(sql);
          return {
            bind(...args: unknown[]) {
              const bound = inner.bind(...args);
              return {
                all: <T = Record<string, unknown>>() => bound.all<T>(),
                async first<T = unknown>() {
                  const row = await bound.first<T>();
                  if (!injectedUpdateOcrEdit && sql.startsWith("SELECT student_name")) {
                    injectedUpdateOcrEdit = true;
                    await ocrRepo.editParagraphTexts("u1", raceUpdateId, 0, [{
                      paragraphId: "paragraph-1",
                      text: "改名并发瞬间老师修正了识别原文。",
                    }]);
                  }
                  return row;
                },
                run: () => bound.run(),
              } as unknown as D1PreparedStatement;
            },
          } as unknown as D1PreparedStatement;
        },
        batch: (stmts: D1PreparedStatement[]) => baseDb.batch(stmts),
      } as unknown as D1Database;

      const updatedAfterOcrRace = await new D1ReviewWriter(racingWriterDb).update("u1", raceUpdateId, {
        expectedRevision: beforeUpdateRow.revision,
        studentName: "并发改名学生",
        className: "六（1）班",
        annotations: [],
      });
      expect(injectedUpdateOcrEdit).toBe(true);
      expect(updatedAfterOcrRace).toEqual({ revision: beforeUpdateRow.revision + 1 });

      const dbAfterUpdateRace = sqlite.prepare("SELECT revision, ocr_checkpoint, ocr_revision_cached, export_ready_version FROM reviews WHERE id = ?").get(raceUpdateId) as {
        revision: number;
        ocr_checkpoint: string;
        ocr_revision_cached: number | null;
        export_ready_version: string | null;
      };
      expect(JSON.parse(dbAfterUpdateRace.ocr_checkpoint).ocrRevision).toBe(1);
      expect(dbAfterUpdateRace.ocr_revision_cached).toBe(1);
      expect(dbAfterUpdateRace.export_ready_version).toBeNull();

      const finalSummaryPage = await new D1ReviewReader(baseDb).summaryPage("u1", { page: 1, pageSize: 20 });
      expect(finalSummaryPage.exportableReviewedIds).not.toContain(raceUpdateId);
      await expect(new D1ReviewReader(baseDb).checkExportable("u1", [
        { id: raceUpdateId, revision: dbAfterUpdateRace.revision },
      ])).resolves.toBe(false);

      // 第 5 轮 Major 并发回归：两次带批注保存读到同一 revision 且在同一毫秒生成 updated_at，冲突失败方绝不能覆盖胜出方的批注
      const sameMsTargetId = createdIds[2]!;
      const sameMsBefore = sqlite.prepare("SELECT revision FROM reviews WHERE id = ?").get(sameMsTargetId) as { revision: number };
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_760_000_000_123);
      try {
        let injectedWinner = false;
        const interleavedDb: D1Database = {
          prepare(sql: string) {
            const inner = baseDb.prepare(sql);
            return {
              bind(...args: unknown[]) {
                const bound = inner.bind(...args);
                return {
                  all: <T = Record<string, unknown>>() => bound.all<T>(),
                  async first<T = unknown>() {
                    const row = await bound.first<T>();
                    if (!injectedWinner && sql.startsWith("SELECT student_name")) {
                      injectedWinner = true;
                      // 请求甲在同一毫秒抢先完成更新并写入甲的批注
                      await new D1ReviewWriter(baseDb).update("u1", sameMsTargetId, {
                        expectedRevision: sameMsBefore.revision,
                        studentName: "甲胜出学生",
                        annotations: [{
                          pageIndex: 0,
                          x: 0.2,
                          y: 0.3,
                          category: "highlight",
                          anchorText: "第一段",
                          comment: "甲老师的成功批注",
                          isHighlight: true,
                        }],
                      });
                    }
                    return row;
                  },
                  run: () => bound.run(),
                } as unknown as D1PreparedStatement;
              },
            } as unknown as D1PreparedStatement;
          },
          batch: (stmts: D1PreparedStatement[]) => baseDb.batch(stmts),
        } as unknown as D1Database;

        // 请求乙携带同一 expectedRevision 与同一毫秒时间戳尝试写入乙的批注，必须报版本冲突且零副作用
        await expect(new D1ReviewWriter(interleavedDb).update("u1", sameMsTargetId, {
          expectedRevision: sameMsBefore.revision,
          studentName: "乙失败学生",
          annotations: [{
            pageIndex: 0,
            x: 0.5,
            y: 0.6,
            category: "typo",
            anchorText: "错字",
            comment: "乙老师的冲突批注（绝不能入库）",
            isHighlight: false,
          }],
        })).rejects.toMatchObject({ name: "RevisionConflictError" });

        const savedReviewAfterConflict = sqlite.prepare("SELECT student_name, revision FROM reviews WHERE id = ?").get(sameMsTargetId) as {
          student_name: string;
          revision: number;
        };
        const savedAnnotationsAfterConflict = sqlite.prepare("SELECT comment, category FROM annotations WHERE review_id = ?").all(sameMsTargetId) as Array<{
          comment: string;
          category: string;
        }>;
        expect(savedReviewAfterConflict).toEqual({
          student_name: "甲胜出学生",
          revision: sameMsBefore.revision + 1,
        });
        expect(savedAnnotationsAfterConflict).toEqual([{
          comment: "甲老师的成功批注",
          category: "highlight",
        }]);

        // 同毫秒并发 completeTeacherReview：乙失败同样绝不能覆盖甲在审核通过时写入的批注
        const sameMsReviewApproveId = createdIds[3]!;
        const approveBefore = sqlite.prepare("SELECT revision FROM reviews WHERE id = ?").get(sameMsReviewApproveId) as { revision: number };
        let injectedApproveWinner = false;
        const interleavedApproveDb: D1Database = {
          prepare(sql: string) {
            const inner = baseDb.prepare(sql);
            return {
              bind(...args: unknown[]) {
                const bound = inner.bind(...args);
                return {
                  all: <T = Record<string, unknown>>() => bound.all<T>(),
                  async first<T = unknown>() {
                    const row = await bound.first<T>();
                    if (!injectedApproveWinner && sql.startsWith("SELECT config, status, revision")) {
                      injectedApproveWinner = true;
                      await new D1ReviewWriter(baseDb).completeTeacherReview("u1", sameMsReviewApproveId, {
                        expectedRevision: approveBefore.revision,
                        studentName: "甲审核胜出",
                        report: parsedReport,
                        annotations: [{
                          pageIndex: 0,
                          x: 0.1,
                          y: 0.2,
                          category: "highlight",
                          anchorText: "佳句",
                          comment: "甲审核批注保留",
                          isHighlight: true,
                        }],
                      });
                    }
                    return row;
                  },
                  run: () => bound.run(),
                } as unknown as D1PreparedStatement;
              },
            } as unknown as D1PreparedStatement;
          },
          batch: (stmts: D1PreparedStatement[]) => baseDb.batch(stmts),
        } as unknown as D1Database;

        await expect(new D1ReviewWriter(interleavedApproveDb).completeTeacherReview("u1", sameMsReviewApproveId, {
          expectedRevision: approveBefore.revision,
          studentName: "乙审核冲突",
          report: parsedReport,
          annotations: [{
            pageIndex: 0,
            x: 0.7,
            y: 0.8,
            category: "typo",
            anchorText: "错词",
            comment: "乙审核冲突批注",
            isHighlight: false,
          }],
        })).rejects.toMatchObject({ name: "RevisionConflictError" });

        expect(sqlite.prepare("SELECT comment, category FROM annotations WHERE review_id = ?").all(sameMsReviewApproveId)).toEqual([{
          comment: "甲审核批注保留",
          category: "highlight",
        }]);
      } finally {
        nowSpy.mockRestore();
      }
    } finally {
      sqlite.close();
    }
  });

  it("4096 字合法超长题目在创建后、教师审核通过后与批量重批提交后，分页摘要标题始终保持 200 码点硬封顶而详情 config.title 完整保留全文", async () => {
    const sqlite = migratedDatabase();
    try {
      const baseDb = d1Shim(sqlite);
      const writer = new D1ReviewWriter(baseDb);
      const imageWriter = new D1ImageWriter(baseDb);
      const ocrRepo = new D1OcrCheckpointRepository(baseDb);
      const reanalysis = new D1Reanalysis(baseDb);
      const reader = new D1ReviewReader(baseDb);

      const full4096Title = `秋日记事${"长".repeat(4_092)}`;
      expect(Array.from(full4096Title)).toHaveLength(4_096);
      const expectedTruncatedTitle = `${Array.from(full4096Title).slice(0, 199).join("")}…`;
      expect(Array.from(expectedTruncatedTitle)).toHaveLength(200);

      const longConfig = {
        ...JSON.parse(config),
        title: full4096Title,
      };
      const parsedReport = JSON.parse(paragraphReport);
      const createdIds: string[] = [];

      // 1) 通过真实写入器创建 20 篇 4096 字合法题目记录，完成分析并逐篇执行真实 completeTeacherReview
      for (let i = 0; i < 20; i += 1) {
        const created = await writer.create("u1", {
          config: longConfig,
          studentName: `虚构生${i + 1}`,
          className: "六（1）班",
        });
        createdIds.push(created.id);
        await imageWriter.replace("u1", created.id, created.revision, [{
          originalName: "page1.jpg",
          mimeType: "image/jpeg",
          width: 1200,
          height: 1600,
          path: "images/page1.jpg",
        }], true);
        const jobId = `long-title-job-${i + 1}`;
        sqlite.prepare("UPDATE reviews SET status = 'analyzing', analysis_run_id = ? WHERE id = ?").run(jobId, created.id);
        sqlite.prepare(`
          INSERT INTO analysis_jobs (id, review_id, owner_id, mode, status, attempt, available_at, progress_stage, created_at)
          VALUES (?, ?, 'u1', 'full', 'running', 1, 1, 'generating_review', 1)
        `).run(jobId, created.id);
        const savedOcr = await ocrRepo.saveRecognized("u1", created.id, 1, {
          pages: [{
            pageIndex: 0,
            text: "老师修正后的第一段。",
            readable: true,
            warnings: [],
            blocks: [{ text: "老师修正后的第一段。", x: 0.1, y: 0.2, width: 0.5, height: 0.08 }],
          }],
          paragraphs: [{
            paragraphIndex: 0,
            text: "老师修正后的第一段。",
            segments: [{ pageIndex: 0, text: "老师修正后的第一段。", x: 0.1, y: 0.2, width: 0.5, height: 0.08 }],
          }],
        }, jobId);
        await savePipelineResult(
          baseDb,
          { id: jobId, reviewId: created.id, ownerId: "u1", mode: "full", imageRevision: 1, config: longConfig },
          { report: parsedReport, annotations: [], ocrRevision: savedOcr.ocrRevision },
        );
        const readyRow = sqlite.prepare("SELECT revision FROM reviews WHERE id = ?").get(created.id) as { revision: number };
        await writer.completeTeacherReview("u1", created.id, {
          expectedRevision: readyRow.revision,
          studentName: `虚构生${i + 1}`,
          report: parsedReport,
          annotations: [],
        });
      }

      // 2) 教师审核通过后：首页分页摘要 20 条标题全部严格为 200 码点（整页 JSON < 25KB，待回填数 = 0），单篇详情仍完整保留 4096 码点
      const pageAfterApprove = await reader.summaryPage("u1", { page: 1, pageSize: 20 });
      expect(pageAfterApprove.items).toHaveLength(20);
      expect(pageAfterApprove.summaryBackfillPending).toBeUndefined();
      for (const item of pageAfterApprove.items) {
        expect(item.config.title).toBe(expectedTruncatedTitle);
        expect(Array.from(item.config.title)).toHaveLength(200);
      }
      expect(Buffer.byteLength(JSON.stringify(pageAfterApprove), "utf8")).toBeLessThan(25_000);

      for (const id of createdIds) {
        const detailAfterApprove = (await reader.get("u1", id)) as { config: { title: string } };
        expect(detailAfterApprove.config.title).toBe(full4096Title);
        expect(Array.from(detailAfterApprove.config.title)).toHaveLength(4_096);
      }

      // 3) 批量重批（含 applyCurrentFramework: true）提交后：分页摘要标题仍然严格为 200 码点（整页 JSON < 25KB），全部 20 篇详情题目仍完整保留 4096 码点
      const preview = await reanalysis.preview("u1", createdIds);
      expect(preview.matched).toHaveLength(20);
      const committed = await reanalysis.commitBatch(
        "u1",
        preview.matched.map((item) => ({
          reviewId: item.reviewId,
          expectedRevision: item.expectedRevision,
          assignmentId: item.assignmentId,
          expectedAssignmentUpdatedAt: item.assignmentUpdatedAt,
        })),
        { applyCurrentFramework: true },
      );
      expect(committed.submitted).toHaveLength(20);

      const pageAfterReanalysis = await reader.summaryPage("u1", { page: 1, pageSize: 20 });
      expect(pageAfterReanalysis.items).toHaveLength(20);
      expect(pageAfterReanalysis.summaryBackfillPending).toBeUndefined();
      for (const item of pageAfterReanalysis.items) {
        expect(item.config.title).toBe(expectedTruncatedTitle);
        expect(Array.from(item.config.title)).toHaveLength(200);
      }
      expect(Buffer.byteLength(JSON.stringify(pageAfterReanalysis), "utf8")).toBeLessThan(25_000);

      for (const id of createdIds) {
        const detailAfterReanalysis = (await reader.get("u1", id)) as { config: { title: string } };
        expect(detailAfterReanalysis.config.title).toBe(full4096Title);
        expect(Array.from(detailAfterReanalysis.config.title)).toHaveLength(4_096);
      }
    } finally {
      sqlite.close();
    }
  });
});
