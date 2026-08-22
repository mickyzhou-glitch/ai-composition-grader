import { describe, expect, it, vi } from "vitest";

import { D1AnalysisJobs } from "./d1-analysis-jobs";

describe("D1AnalysisJobs", () => {
  it("把带校验详情的 AI_INVALID_RESPONSE 说明为返回格式异常", async () => {
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue({
            id: "job-1", review_id: "review-1", status: "failed", progress_stage: "reading_images",
            error_code: "AI_INVALID_RESPONSE_schema_report_sampleParagraphs_0_suggestion_invalid_type",
            created_at: 1_700_000_000_000, finished_at: 1_700_000_000_100,
          }),
        })),
      })),
    } as unknown as D1Database;

    await expect(new D1AnalysisJobs(database).latest("teacher-1", "review-1")).resolves.toMatchObject({
      message: "AI 返回格式异常，请重新分析",
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

    const result = await new D1AnalysisJobs(database).enqueue("teacher-1", "review-1");

    expect(result.newlyQueued).toBe(false);
    expect(result.job).toMatchObject({ id: "job-1", status: "queued" });
  });

  it("content_only requires an OCR checkpoint bound to the current image revision", async () => {
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue({
            id: "review-1",
            revision: 2,
            image_revision: 4,
            ocr_checkpoint: JSON.stringify({ sourceRevision: 3, ocrRevision: 1 }),
            expires_at: null,
            image_count: 1,
          }),
        })),
      })),
    } as unknown as D1Database;

    await expect(new D1AnalysisJobs(database).enqueue("teacher-1", "review-1", {
      mode: "content_only",
    })).rejects.toThrow("OCR_NOT_FOUND");
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
              ocr_checkpoint: JSON.stringify({ sourceRevision: 4, ocrRevision: 1 }),
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
      batch: vi.fn(async () => []),
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
      batch: vi.fn(async () => []),
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

  it("accepts the OCR and annotation mapping progress stages", async () => {
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue({
            id: "job-1", review_id: "review-1", mode: "full", status: "running",
            progress_stage: "mapping_annotations", error_code: null,
            created_at: 1_700_000_000_000, finished_at: null,
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
