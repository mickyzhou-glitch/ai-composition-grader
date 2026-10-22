import { describe, expect, it, vi } from "vitest";

import { STANDING_GUIDANCE_HEADER } from "../grading-opinions/standing-guidance";
import { D1AnalysisJobs } from "./d1-analysis-jobs";

describe("D1AnalysisJobs", () => {
  it.each([
    ["AI_INVALID_RESPONSE_schema_report_sampleParagraphs_0_suggestion_invalid_type", "批改结果 JSON 解析失败，请重新分析"],
    ["AI_INVALID_RESPONSE_rewritten_essay_chars_3_min_180_actual_170", "AI 生成的范文未满足指定字数，请重新生成整篇批改"],
    ["AI_INVALID_RESPONSE_rewritten_essay_paragraph_count_expected_5", "AI 生成的范文未满足指定段数，请重新生成整篇批改"],
  ])("准确说明生成失败原因：%s", async (errorCode, message) => {
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue({
            id: "job-1", review_id: "review-1", status: "failed", progress_stage: "reading_images",
            error_code: errorCode,
            created_at: 1_700_000_000_000, finished_at: 1_700_000_000_100,
          }),
        })),
      })),
    } as unknown as D1Database;

    await expect(new D1AnalysisJobs(database).latest("teacher-1", "review-1")).resolves.toMatchObject({
      message,
    });
  });

  it("超时或中止时说明停在哪一步", async () => {
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue({
            id: "job-1", review_id: "review-1", status: "failed", progress_stage: "reading_images",
            error_code: "ANALYSIS_ABORTED", created_at: 1_700_000_000_000, finished_at: 1_700_000_000_100,
          }),
        })),
      })),
    } as unknown as D1Database;

    await expect(new D1AnalysisJobs(database).latest("teacher-1", "review-1")).resolves.toMatchObject({
      message: "分析在「读取图片」步骤超时或被中止，请重新分析",
    });
  });

  it("把图片批改的 403 说明为模型或网关不支持视觉输入", async () => {
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue({
            id: "job-1", review_id: "review-1", status: "failed", progress_stage: "reading_images",
            error_code: "AI_UPSTREAM_HTTP_403", created_at: 1_700_000_000_000, finished_at: 1_700_000_000_100,
          }),
        })),
      })),
    } as unknown as D1Database;

    await expect(new D1AnalysisJobs(database).latest("teacher-1", "review-1")).resolves.toMatchObject({
      message: "AI 服务拒绝了图片批改请求，请确认当前模型已开通视觉输入权限",
    });
  });

  it("把生成批改报告时的 402 说明为内容服务额度不足", async () => {
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue({
            id: "job-1", review_id: "review-1", status: "failed", progress_stage: "generating_review",
            error_code: "AI_UPSTREAM_HTTP_402", created_at: 1_700_000_000_000, finished_at: 1_700_000_000_100,
          }),
        })),
      })),
    } as unknown as D1Database;

    await expect(new D1AnalysisJobs(database).latest("teacher-1", "review-1")).resolves.toMatchObject({
      message: "AI 内容批改服务额度不足，请联系管理员充值后重试",
    });
  });

  it("reuses an already queued job for the same review", async () => {
    const database = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(query.includes("FROM reviews") ? { id: "review-1", revision: 2, expires_at: null, image_count: 1 } : {
            id: "job-1", review_id: "review-1", status: "queued", progress_stage: "queued", error_code: null, created_at: 1_700_000_000_000, finished_at: null,
          }),
        })),
      })),
    } as unknown as D1Database;

    const result = await new D1AnalysisJobs(database).enqueue("teacher-1", "review-1", {
      mode: "content_only",
    });

    expect(result.newlyQueued).toBe(false);
    expect(result.job).toMatchObject({ id: "job-1", status: "queued" });
  });

  it("reuses an already running job for the same review", async () => {
    const batch = vi.fn();
    const database = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(query.includes("FROM reviews") ? {
            id: "review-1", revision: 2, image_revision: 1, ocr_checkpoint: null, image_count: 1,
          } : {
            id: "job-1", review_id: "review-1", mode: "full", status: "running",
            progress_stage: "generating_review", error_code: null,
            created_at: 1_700_000_000_000, started_at: Date.now(), finished_at: null,
          }),
        })),
      })),
      batch,
    } as unknown as D1Database;

    const result = await new D1AnalysisJobs(database).enqueue("teacher-1", "review-1");

    expect(result).toMatchObject({ newlyQueued: false, job: { id: "job-1", status: "running" } });
    expect(batch).not.toHaveBeenCalled();
  });

  it("does not insert an orphan job when the review CAS no longer matches", async () => {
    const statements: Array<{ sql: string }> = [];
    const database = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          sql,
          bind() { return statement; },
          first: vi.fn().mockResolvedValue(
            sql.includes("FROM reviews LEFT JOIN")
              ? { id: "review-1", revision: 2, image_revision: 1, ocr_checkpoint: null, image_count: 1 }
              : null,
          ),
        };
        statements.push(statement);
        return statement;
      }),
      batch: vi.fn().mockResolvedValue([
        { meta: { changes: 0 } },
        { meta: { changes: 0 } },
      ]),
    } as unknown as D1Database;

    await expect(new D1AnalysisJobs(database).enqueue("teacher-1", "review-1"))
      .rejects.toMatchObject({ code: "ANALYSIS_CONFLICT" });

    const updateIndex = statements.findIndex(({ sql }) => sql.includes("UPDATE reviews SET"));
    const insertIndex = statements.findIndex(({ sql }) => sql.includes("INSERT INTO analysis_jobs"));
    expect(updateIndex).toBeGreaterThanOrEqual(0);
    expect(insertIndex).toBeGreaterThan(updateIndex);
    expect(statements[insertIndex]?.sql).toContain("SELECT");
  });

  it("releases the review if a defensive batch outcome binds it without inserting the job", async () => {
    const statements: Array<{ sql: string; bindings: unknown[]; run: ReturnType<typeof vi.fn> }> = [];
    const database = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          sql,
          bindings: [] as unknown[],
          bind(...bindings: unknown[]) {
            this.bindings = bindings;
            return this;
          },
          first: vi.fn().mockResolvedValue(
            sql.includes("FROM reviews LEFT JOIN")
              ? {
                  id: "review-1",
                  revision: 2,
                  image_revision: 1,
                  ocr_checkpoint: null,
                  image_count: 1,
                  status: "ready_for_review",
                  teacher_reviewed_at: 1_700_000_000_000,
                }
              : null,
          ),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
        };
        statements.push(statement);
        return statement;
      }),
      batch: vi.fn().mockResolvedValue([
        { meta: { changes: 1 } },
        { meta: { changes: 0 } },
      ]),
    } as unknown as D1Database;

    await expect(new D1AnalysisJobs(database).enqueue("teacher-1", "review-1"))
      .rejects.toMatchObject({ code: "ANALYSIS_CONFLICT" });

    const release = statements.find(({ sql }) => sql.includes("analysis_run_id = NULL"));
    expect(release?.sql).toContain("analysis_run_id = ?");
    expect(release?.bindings).toEqual(expect.arrayContaining([
      "ready_for_review",
      1_700_000_000_000,
      "review-1",
      "teacher-1",
    ]));
    expect(release?.run).toHaveBeenCalledOnce();
  });

  it("maps a unique-index race back to the concurrently created active job", async () => {
    let activeReads = 0;
    const database = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => {
            if (sql.includes("FROM reviews LEFT JOIN")) {
              return { id: "review-1", revision: 2, image_revision: 1, ocr_checkpoint: null, image_count: 1 };
            }
            if (sql.includes("status IN ('queued', 'running')")) {
              activeReads += 1;
              return activeReads === 1 ? null : {
                id: "job-race", review_id: "review-1", mode: "full", status: "running",
                progress_stage: "reading_images", error_code: null,
                created_at: 1_700_000_000_001, started_at: Date.now(), finished_at: null,
              };
            }
            return null;
          }),
        })),
      })),
      batch: vi.fn().mockRejectedValue(new Error("UNIQUE constraint failed: analysis_jobs.review_id")),
    } as unknown as D1Database;

    await expect(new D1AnalysisJobs(database).enqueue("teacher-1", "review-1"))
      .resolves.toMatchObject({
        newlyQueued: false,
        job: { id: "job-race", status: "running" },
      });
    expect(activeReads).toBe(2);
  });

  it("content_only requires an OCR checkpoint bound to the current image revision", async () => {
    const database = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(query.includes("FROM reviews LEFT JOIN") ? {
            id: "review-1",
            revision: 2,
            image_revision: 4,
            ocr_checkpoint: JSON.stringify({
              version: 2,
              sourceRevision: 3,
              ocrRevision: 1,
              editedAt: null,
              pages: [{ pageIndex: 0, text: "原文", readable: true, warnings: [], blocks: [] }],
              paragraphs: [{
                id: "paragraph-1",
                paragraphIndex: 0,
                text: "原文",
                segments: [{ pageIndex: 0, text: "原文", x: 0.1, y: 0.1, width: 0.3, height: 0.1 }],
              }],
            }),
            expires_at: null,
            image_count: 1,
          } : null),
        })),
      })),
    } as unknown as D1Database;

    await expect(new D1AnalysisJobs(database).enqueue("teacher-1", "review-1", {
      mode: "content_only",
    })).rejects.toThrow("OCR_NOT_FOUND");
  });

  it("content_only without OCR returns OCR_V2_REQUIRED", async () => {
    const database = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(query.includes("FROM reviews LEFT JOIN") ? {
            id: "review-1",
            revision: 2,
            image_revision: 4,
            ocr_checkpoint: null,
            image_count: 1,
          } : null),
        })),
      })),
    } as unknown as D1Database;

    await expect(new D1AnalysisJobs(database).enqueue("teacher-1", "review-1", {
      mode: "content_only",
    })).rejects.toMatchObject({ code: "OCR_V2_REQUIRED", status: 409 });
  });

  it("content_only rejects a current OCR v1 checkpoint with OCR_V2_REQUIRED", async () => {
    const database = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(query.includes("FROM reviews LEFT JOIN") ? {
            id: "review-1",
            revision: 2,
            image_revision: 4,
            ocr_checkpoint: JSON.stringify({
              version: 1,
              sourceRevision: 4,
              ocrRevision: 1,
              editedAt: null,
              pages: [{ pageIndex: 0, text: "旧原文", readable: true, warnings: [], blocks: [] }],
            }),
            image_count: 1,
          } : null),
        })),
      })),
    } as unknown as D1Database;

    await expect(new D1AnalysisJobs(database).enqueue("teacher-1", "review-1", {
      mode: "content_only",
    })).rejects.toMatchObject({ code: "OCR_V2_REQUIRED", status: 409 });
  });

  it("stores the requested mode and exposes it in the public job view", async () => {
    const statements: Array<{ query: string; bindings: unknown[] }> = [];
    const database = {
      prepare: vi.fn((query: string) => {
        const statement = {
          query,
          bindings: [] as unknown[],
          bind(...bindings: unknown[]) {
            this.bindings = bindings;
            return this;
          },
          async first() {
            if (query.includes("FROM reviews")) return {
              id: "review-1",
              revision: 2,
              image_revision: 4,
              ocr_checkpoint: JSON.stringify({
                version: 2,
                sourceRevision: 4,
                ocrRevision: 1,
                editedAt: null,
                pages: [{ pageIndex: 0, text: "原文", readable: true, warnings: [], blocks: [] }],
                paragraphs: [{
                  id: "paragraph-1",
                  paragraphIndex: 0,
                  text: "原文",
                  segments: [{ pageIndex: 0, text: "原文", x: 0.1, y: 0.1, width: 0.3, height: 0.1 }],
                }],
              }),
              expires_at: null,
              image_count: 1,
            };
            if (query.includes("ORDER BY created_at DESC")) return null;
            return {
              id: "job-2",
              review_id: "review-1",
              mode: "content_only",
              status: "queued",
              progress_stage: "queued",
              error_code: null,
              created_at: 1_700_000_000_000,
              finished_at: null,
            };
          },
        };
        statements.push(statement);
        return statement;
      }),
      batch: vi.fn(async () => [
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
      ]),
    } as unknown as D1Database;

    const result = await new D1AnalysisJobs(database).enqueue("teacher-1", "review-1", {
      mode: "content_only",
      teacherGuidance: "保留原意",
    });

    expect(result.job).toMatchObject({ mode: "content_only" });
    expect(statements.find(({ query }) => query.includes("INSERT INTO analysis_jobs"))?.bindings)
      .toContain("content_only");
    const reviewUpdate = statements.find(({ query }) => query.includes("UPDATE reviews SET"));
    expect(reviewUpdate?.query).toContain("teacher_reviewed_at = NULL");
    expect(statements.find(({ query }) => query.includes("FROM reviews"))?.query).not.toContain("expires_at");
  });

  it("accepts 1100 guidance characters and rejects 1101", async () => {
    const statements: Array<{ query: string; bindings: unknown[] }> = [];
    const database = {
      prepare: vi.fn((query: string) => {
        const statement = {
          query,
          bindings: [] as unknown[],
          bind(...bindings: unknown[]) {
            this.bindings = bindings;
            return this;
          },
          async first() {
            if (query.includes("FROM reviews")) return {
              id: "review-1",
              revision: 2,
              image_revision: 4,
              ocr_checkpoint: null,
              image_count: 1,
            };
            if (query.includes("ORDER BY created_at DESC")) return null;
            return {
              id: "job-2",
              review_id: "review-1",
              mode: "full",
              status: "queued",
              progress_stage: "queued",
              error_code: null,
              created_at: 1_700_000_000_000,
              finished_at: null,
            };
          },
        };
        statements.push(statement);
        return statement;
      }),
      batch: vi.fn(async () => [
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
      ]),
    } as unknown as D1Database;
    const jobs = new D1AnalysisJobs(database);
    const maximumGuidance = "意".repeat(1_100);

    await expect(jobs.enqueue("teacher-1", "review-1", {
      teacherGuidance: maximumGuidance,
    })).resolves.toMatchObject({ newlyQueued: true });
    expect(statements.find(({ query }) => query.includes("INSERT INTO analysis_jobs"))?.bindings)
      .toContain(maximumGuidance);
    await expect(jobs.enqueue("teacher-1", "review-1", {
      teacherGuidance: `${maximumGuidance}见`,
    })).rejects.toThrow("teacherGuidance must be at most 1100 characters");
  });

  it("新批改把老师存档的长期意见追加进任务，且不因存档放宽 1100 字的本次意见上限", async () => {
    const statements: Array<{ query: string; bindings: unknown[] }> = [];
    const database = {
      prepare: vi.fn((query: string) => {
        const statement = {
          query,
          bindings: [] as unknown[],
          bind(...bindings: unknown[]) {
            this.bindings = bindings;
            return this;
          },
          async first() {
            if (query.includes("FROM reviews")) return {
              id: "review-1",
              revision: 2,
              image_revision: 4,
              ocr_checkpoint: null,
              config: JSON.stringify({
                title: "我终于明白了",
                grade: "六年级",
                writingRequirements: "写一件事",
                targetCharacters: 600,
                structureRequirements: "五段",
                scoringFocus: "细节",
                templateType: "custom",
              }),
              image_count: 1,
            };
            if (query.includes("ORDER BY created_at DESC")) return null;
            return {
              id: "job-2",
              review_id: "review-1",
              mode: "full",
              status: "queued",
              progress_stage: "queued",
              error_code: null,
              created_at: 1_700_000_000_000,
              finished_at: null,
            };
          },
          async all() {
            return query.includes("FROM grading_opinions")
              ? {
                results: [
                  { text: "严格五段", paragraphLabel: null, category: "结构", sourceTitle: "我终于明白了", updatedAt: 20 },
                  { text: "严格五段", paragraphLabel: null, category: "结构", sourceTitle: "我终于明白了", updatedAt: 10 },
                  { text: "别的题目", paragraphLabel: null, category: "结构", sourceTitle: "另一篇题目", updatedAt: 30 },
                ],
              }
              : { results: [] };
          },
        };
        statements.push(statement);
        return statement;
      }),
      batch: vi.fn(async () => [
        { meta: { changes: 1 } },
        { meta: { changes: 1 } },
      ]),
    } as unknown as D1Database;

    await expect(new D1AnalysisJobs(database).enqueue("teacher-1", "review-1", {
      teacherGuidance: "本次只改结尾",
    })).resolves.toMatchObject({ newlyQueued: true });

    const guidance = statements.find(({ query }) => query.includes("INSERT INTO analysis_jobs"))?.bindings
      .find((binding) => typeof binding === "string" && binding.includes("本次只改结尾"));
    expect(guidance).toEqual(expect.stringContaining(STANDING_GUIDANCE_HEADER));
    expect(guidance).toEqual(expect.stringContaining("1. 严格五段（出现 2 次）"));
    expect(String(guidance).match(/严格五段/gu)).toHaveLength(1);
  });

  it("accepts the OCR and annotation mapping progress stages", async () => {
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue({
            id: "job-1", review_id: "review-1", mode: "full", status: "running",
            progress_stage: "mapping_annotations", error_code: null,
            created_at: 1_700_000_000_000, started_at: Date.now(), finished_at: null,
          }),
        })),
      })),
    } as unknown as D1Database;

    await expect(new D1AnalysisJobs(database).latest("teacher-1", "review-1")).resolves.toMatchObject({
      mode: "full",
      progressStage: "mapping_annotations",
    });
  });
});
