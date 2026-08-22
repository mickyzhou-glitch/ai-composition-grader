import { describe, expect, it, vi } from "vitest";

import {
  D1Reanalysis,
  D1ReanalysisBatchError,
  type D1ReanalysisStatement,
} from "./d1-reanalysis";

const OWNER = "teacher-1";
const REVIEW = "review-1";
const ASSIGNMENT = "assignment-1";
const CHECKPOINT = JSON.stringify({ sourceRevision: 4, ocrRevision: 2 });

function statement(
  sql: string,
  handlers: Partial<Record<"all" | "first" | "run", unknown>> = {},
) {
  const value = {
    sql,
    bindings: [] as unknown[],
    bind(...args: unknown[]) {
      (this as unknown as { bindings: unknown[] }).bindings = args;
      return this;
    },
    all: handlers.all ?? vi.fn(async () => ({ results: [] })),
    first: handlers.first ?? vi.fn(async () => null),
    run: handlers.run ?? vi.fn(async () => ({ meta: { changes: 0 } })),
  } as unknown as D1ReanalysisStatement & { sql: string; bindings: unknown[] };
  return value;
}

function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW,
    status: "ready_for_review",
    student_name: "小明",
    config: JSON.stringify({
      title: "  春天  ",
      grade: "六年级",
      writingRequirements: "写一件事",
      targetCharacters: 600,
      structureRequirements: "完整",
      scoringFocus: "细节",
      templateType: "custom",
    }),
    revision: 3,
    image_revision: 4,
    ocr_checkpoint: CHECKPOINT,
    deleting_at: null,
    image_count: 1,
    ...overrides,
  };
}

describe("D1Reanalysis", () => {
  it("预览只使用 all，跨 owner 只返回安全的 REVIEW_NOT_FOUND", async () => {
    const calls: string[] = [];
    const database = {
      prepare: vi.fn((sql: string) => {
        calls.push(sql);
        if (sql.includes("FROM reviews")) {
          return statement(sql, { all: vi.fn(async () => ({ results: [reviewRow()] })) });
        }
        if (/^\s*SELECT/iu.test(sql) && sql.includes("FROM saved_assignments")) {
          return statement(sql, {
            all: vi.fn(async () => ({ results: [{
              id: ASSIGNMENT,
              title: " 春天 ",
              updated_at: 1_700_000_000_000,
            }] })),
          });
        }
        return statement(sql, { all: vi.fn(async () => ({ results: [] })) });
      }),
      batch: vi.fn(),
      exec: vi.fn(),
    } as unknown as D1Database;

    const result = await new D1Reanalysis(database).preview(OWNER, [REVIEW, "other-owner-review"]);

    expect(result.matched).toEqual([expect.objectContaining({
      reviewId: REVIEW,
      studentName: "小明",
      title: "春天",
      expectedRevision: 3,
      assignmentId: ASSIGNMENT,
      assignmentUpdatedAt: new Date(1_700_000_000_000).toISOString(),
    })]);
    expect(result.skipped).toEqual([{
      reviewId: "other-owner-review",
      code: "REVIEW_NOT_FOUND",
      reason: "作文不存在或已不可用",
    }]);
    expect(database.batch).not.toHaveBeenCalled();
    expect(database.exec).not.toHaveBeenCalled();
    expect(calls.every((sql) => !/^\s*(UPDATE|INSERT|DELETE)/iu.test(sql))).toBe(true);
  });

  it("单篇退回在一个原子 batch 中更新作文并条件插入 content_only 任务", async () => {
    const statements: Array<D1ReanalysisStatement & { sql: string; bindings: unknown[] }> = [];
    const database = {
      prepare: vi.fn((sql: string) => {
        const prepared = statement(sql, {
          first: vi.fn(async () => reviewRow()),
        }) as D1ReanalysisStatement & { sql: string; bindings: unknown[] };
        statements.push(prepared);
        return prepared;
      }),
      batch: vi.fn(async (batchStatements: D1ReanalysisStatement[]) =>
        batchStatements.map(() => ({ meta: { changes: 1 } }))),
    } as unknown as D1Database;
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("job-1");

    const result = await new D1Reanalysis(database).requestRevision(OWNER, REVIEW, {
      expectedRevision: 3,
      reason: "原批改不合适",
      changeRequest: "重新关注结尾",
    });

    expect(database.batch).toHaveBeenCalledOnce();
    expect(statements.filter(({ sql }) => /UPDATE reviews/iu.test(sql))).toHaveLength(1);
    expect(statements.filter(({ sql }) => /INSERT INTO analysis_jobs/iu.test(sql))).toHaveLength(1);
    const update = statements.find(({ sql }) => /UPDATE reviews/iu.test(sql))!;
    const insert = statements.find(({ sql }) => /INSERT INTO analysis_jobs/iu.test(sql))!;
    expect(update.sql).toContain("deleting_at IS NULL");
    expect(update.sql).toContain("teacher_reviewed_at = NULL");
    expect(update.sql).toContain("pdf_filename = NULL");
    expect(insert.sql).toContain("SELECT");
    expect(insert.sql).toContain("analysis_run_id = ?");
    expect(result).toMatchObject({
      newlyQueued: true,
      job: { id: "job-1", reviewId: REVIEW, mode: "content_only", status: "queued" },
    });
    expect(insert.bindings).toContain("[不合适原因]\n原批改不合适\n[修改要求]\n重新关注结尾");
  });

  it("批量确认逐项使用独立 batch，读取数据库 assignment.config 且保留旧报告", async () => {
    const batches: Array<Array<D1ReanalysisStatement & { sql: string; bindings: unknown[] }>> = [];
    let index = 0;
    const database = {
      prepare: vi.fn((sql: string) => {
        const current = statement(sql, {
          first: vi.fn(async () => reviewRow({ report: "old-report" })),
          all: vi.fn(async () => sql.includes("saved_assignments") ? {
            results: [{ id: ASSIGNMENT, title: " 春天 ", config: reviewRow().config, updated_at: 1_700_000_000_000 }],
          } : { results: [] }),
        });
        return current;
      }),
      batch: vi.fn(async (batchStatements: D1ReanalysisStatement[]) => {
        batches.push(batchStatements as Array<D1ReanalysisStatement & { sql: string; bindings: unknown[] }>);
        index += 1;
        return batchStatements.map(() => ({ meta: { changes: 1 } }));
      }),
    } as unknown as D1Database;
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("job-batch");

    const result = await new D1Reanalysis(database).commitBatch(OWNER, [{
      reviewId: REVIEW,
      expectedRevision: 3,
      assignmentId: ASSIGNMENT,
      expectedAssignmentUpdatedAt: new Date(1_700_000_000_000).toISOString(),
    }]);

    expect(index).toBe(1);
    expect(batches).toHaveLength(1);
    expect(batches[0][0].sql).toContain("revision = revision + 1");
    expect(batches[0][0].sql).toContain("SELECT config FROM saved_assignments");
    expect(batches[0][0].sql).not.toContain("report = NULL");
    expect(result).toEqual({
      submitted: [{ reviewId: REVIEW, jobId: "job-batch", revision: 4 }],
      skipped: [],
    });
  });

  it("Queue 投递补偿只处理仍 queued 且仍由目标 job 占用的记录", async () => {
    const statements: Array<D1ReanalysisStatement & { sql: string; bindings: unknown[] }> = [];
    const database = {
      prepare: vi.fn((sql: string) => {
        const prepared = statement(sql) as D1ReanalysisStatement & { sql: string; bindings: unknown[] };
        statements.push(prepared);
        return prepared;
      }),
      batch: vi.fn(async (batchStatements: D1ReanalysisStatement[]) =>
        batchStatements.map(() => ({ meta: { changes: 1 } }))),
    } as unknown as D1Database;

    await new D1Reanalysis(database).markDispatchFailed(OWNER, ["job-1"]);

    expect(database.batch).toHaveBeenCalledOnce();
    expect(statements[0].sql).toContain("status = 'queued'");
    expect(statements[0].sql).toContain("QUEUE_DISPATCH_FAILED");
    expect(statements[1].sql).toContain("analysis_run_id = ?");
    expect(statements[1].sql).toContain("status = 'analyzing'");
  });

  it("预览严格按 sourceRevision 判断 OCR 是否当前", async () => {
    const database = {
      prepare: vi.fn((sql: string) => {
        if (/^\s*SELECT/iu.test(sql) && sql.includes("FROM reviews")) {
          return statement(sql, { all: vi.fn(async () => ({ results: [reviewRow({
            ocr_checkpoint: JSON.stringify({ sourceRevision: 3 }),
          })] })) });
        }
        return statement(sql, { all: vi.fn(async () => ({ results: [] })) });
      }),
    } as unknown as D1Database;

    await expect(new D1Reanalysis(database).preview(OWNER, [REVIEW])).resolves.toEqual({
      matched: [],
      skipped: [{
        reviewId: REVIEW,
        studentName: "小明",
        title: "春天",
        code: "OCR_NOT_CURRENT",
        reason: "识别原文不存在或已失效",
      }],
    });
  });

  it("活动任务唯一竞态映射为 ANALYSIS_ACTIVE，而不是向上暴露 D1 错误", async () => {
    const database = {
      prepare: vi.fn((sql: string) => statement(sql, {
        first: vi.fn(async () => reviewRow()),
      })),
      batch: vi.fn(async () => {
        throw Object.assign(new Error("UNIQUE constraint failed: analysis_jobs.review_id"), { code: "D1_ERROR" });
      }),
    } as unknown as D1Database;

    await expect(new D1Reanalysis(database).requestRevision(OWNER, REVIEW, {
      expectedRevision: 3,
      reason: "原因",
      changeRequest: "要求",
    })).rejects.toMatchObject({ code: "ANALYSIS_ACTIVE" });
  });

  it("批量项分别 batch，第一项成功时第二项冲突仍返回 partial success", async () => {
    let reviewReads = 0;
    let assignmentReads = 0;
    let batchCalls = 0;
    const database = {
      prepare: vi.fn((sql: string) => {
        if (/^\s*SELECT/iu.test(sql) && sql.includes("FROM saved_assignments")) {
          assignmentReads += 1;
          return statement(sql, {
            all: vi.fn(async () => ({ results: [{
              id: ASSIGNMENT,
              title: " 春天 ",
              config: reviewRow().config,
              updated_at: 1_700_000_000_000,
            }] })),
          });
        }
        if (/^\s*SELECT/iu.test(sql) && sql.includes("FROM reviews")) {
          reviewReads += 1;
          return statement(sql, {
            first: vi.fn(async () => reviewReads < 3 ? reviewRow() : reviewRow({ revision: 4 })),
          });
        }
        return statement(sql);
      }),
      batch: vi.fn(async (batchStatements: D1ReanalysisStatement[]) => {
        batchCalls += 1;
        return batchStatements.map(() => ({ meta: { changes: batchCalls === 1 ? 1 : 0 } }));
      }),
    } as unknown as D1Database;
    let nextJob = 0;
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => `job-${++nextJob}`);

    await expect(new D1Reanalysis(database).commitBatch(OWNER, [
      {
        reviewId: REVIEW,
        expectedRevision: 3,
        assignmentId: ASSIGNMENT,
        expectedAssignmentUpdatedAt: new Date(1_700_000_000_000).toISOString(),
      },
      {
        reviewId: "review-2",
        expectedRevision: 3,
        assignmentId: ASSIGNMENT,
        expectedAssignmentUpdatedAt: new Date(1_700_000_000_000).toISOString(),
      },
    ])).resolves.toEqual({
      submitted: [{ reviewId: REVIEW, jobId: "job-1", revision: 4 }],
      skipped: [{
        reviewId: "review-2",
        studentName: "小明",
        title: "春天",
        code: "REVISION_CONFLICT",
        reason: "作文已更新，请重新预览",
      }],
    });
    expect(batchCalls).toBe(2);
    expect(assignmentReads).toBe(2);
  });

  it("未知 D1 错误中止批量并携带此前已提交的 jobIds 与结果", async () => {
    let reviewReads = 0;
    let batchCalls = 0;
    const database = {
      prepare: vi.fn((sql: string) => {
        if (/^\s*SELECT/iu.test(sql) && sql.includes("FROM saved_assignments")) {
          return statement(sql, {
            all: vi.fn(async () => ({ results: [{
              id: ASSIGNMENT,
              title: " 春天 ",
              config: reviewRow().config,
              updated_at: 1_700_000_000_000,
            }] })),
          });
        }
        if (/^\s*SELECT/iu.test(sql) && sql.includes("FROM reviews")) {
          reviewReads += 1;
          return statement(sql, { first: vi.fn(async () => reviewRow()) });
        }
        return statement(sql);
      }),
      batch: vi.fn(async (batchStatements: D1ReanalysisStatement[]) => {
        batchCalls += 1;
        if (batchCalls === 2) throw new Error("D1 raw internal details");
        return batchStatements.map(() => ({ meta: { changes: 1 } }));
      }),
    } as unknown as D1Database;
    let nextJob = 0;
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => `job-${++nextJob}`);

    const promise = new D1Reanalysis(database).commitBatch(OWNER, [
      {
        reviewId: REVIEW,
        expectedRevision: 3,
        assignmentId: ASSIGNMENT,
        expectedAssignmentUpdatedAt: new Date(1_700_000_000_000).toISOString(),
      },
      {
        reviewId: "review-2",
        expectedRevision: 3,
        assignmentId: ASSIGNMENT,
        expectedAssignmentUpdatedAt: new Date(1_700_000_000_000).toISOString(),
      },
    ]);

    await expect(promise).rejects.toBeInstanceOf(D1ReanalysisBatchError);
    await expect(promise).rejects.toMatchObject({
      message: "D1_REANALYSIS_BATCH_FAILED",
      jobIds: ["job-1"],
      submitted: [{ reviewId: REVIEW, jobId: "job-1", revision: 4 }],
    });
    expect(reviewReads).toBe(2);
    expect(batchCalls).toBe(2);
  });
});
