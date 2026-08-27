import { describe, expect, it, vi } from "vitest";

import { D1ReviewWriter } from "./d1-review-writer";

const config = {
  title: "自定义题目", grade: "六年级", writingRequirements: "叙事", targetCharacters: 600,
  structureRequirements: "完整", scoringFocus: "细节", templateType: "custom" as const,
};

const report = {
  themeFit: "fits" as const,
  themeReason: "切题",
  personalizedComment: "细节真实",
  painPoints: ["补充转折"],
  commonIssues: [],
  revisionSuggestions: [],
  grade: "B+" as const,
  diagnostics: {
    authenticityAndRelevance: { finding: "事件真实。", action: "保留真实细节。" },
    materialAndDetails: { finding: "动作略少。", action: "补写动作。" },
    structure: { finding: "衔接清楚。", action: "强化转折。" },
    language: { finding: "语言通顺。", action: "精简长句。" },
  },
  sampleParagraphs: Array.from({ length: 5 }, (_, index) => ({
    title: `第 ${index + 1} 段`,
    text: "我".repeat(120),
    suggestion: "补充动作",
  })),
  parentFeedbacks: [],
};

const invalidReport = {
  ...report,
  sampleParagraphs: [{ title: "示范", text: "示范正文", suggestion: "补充动作" }],
};

const paragraphReport = {
  version: 2,
  themeFit: "fits",
  themeReason: "切题",
  personalizedComment: "真实",
  painPoints: [], commonIssues: [], revisionSuggestions: [], grade: "A",
  diagnostics: {
    authenticityAndRelevance: { finding: "真实", action: "保留" },
    materialAndDetails: { finding: "具体", action: "保留" },
    structure: { finding: "完整", action: "保留" },
    language: { finding: "通顺", action: "保留" },
  },
  paragraphReviews: [{
    paragraphId: "paragraph-1",
    suggestions: [{ problem: "保留", advice: "保留", example: "自然" }],
    revisedText: "原文。",
  }],
  parentFeedbacks: [],
};

const checkpoint = {
  version: 2,
  sourceRevision: 3,
  ocrRevision: 1,
  editedAt: null,
  pages: [{
    pageIndex: 0, text: "原文。", readable: true, warnings: [],
    blocks: [{ text: "原文。", x: 0.1, y: 0.2, width: 0.5, height: 0.2 }],
  }],
  paragraphs: [{
    id: "paragraph-1", paragraphIndex: 0, text: "原文。",
    segments: [{ pageIndex: 0, text: "原文。", x: 0.1, y: 0.2, width: 0.5, height: 0.2 }],
  }],
};

describe("D1ReviewWriter", () => {
  it("creates a draft and saves a custom assignment in one D1 batch", async () => {
    const batch = vi.fn().mockResolvedValue([]);
    const database = {
      prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({}) }),
      batch,
    } as unknown as D1Database;

    const created = await new D1ReviewWriter(database).create("teacher-1", { config, studentName: "小明" });

    expect(created.revision).toBe(0);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0][0]).toHaveLength(2);
  });

  it("deletes saved assignments only within the active account", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const database = {
      prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ run }) }),
    } as unknown as D1Database;

    await expect(new D1ReviewWriter(database).deleteSavedAssignment("teacher-1", "assignment-1")).resolves.toBe(true);
    expect(database.prepare).toHaveBeenCalledWith(expect.stringContaining("owner_id"));
  });

  it("uses the expected revision when editing a review", async () => {
    const queries: string[] = [];
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const database = {
      prepare: vi.fn((query: string) => {
        queries.push(query);
        return ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(query.startsWith("SELECT student_name") ? {
            student_name: "小明", config: JSON.stringify(config), report: null, status: "draft", revision: 4,
            analysis_run_id: null,
          } : null),
          run,
        })),
      }); }),
    } as unknown as D1Database;

    await expect(new D1ReviewWriter(database).update("teacher-1", "review-1", {
      expectedRevision: 4, studentName: "小红",
    })).resolves.toEqual({ revision: 5 });
    expect(run).toHaveBeenCalledOnce();
    const update = queries.find((query) => query.includes("UPDATE reviews SET"));
    expect(update).not.toContain("image_revision");
    expect(update).not.toContain("ocr_checkpoint");
  });

  it("atomically rejects teacher edits while the review is being analyzed", async () => {
    const run = vi.fn();
    const batch = vi.fn();
    const database = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(query.startsWith("SELECT student_name") ? {
            student_name: "小明",
            config: JSON.stringify(config),
            report: JSON.stringify(report),
            status: "analyzing",
            revision: 4,
            analysis_run_id: "job-running",
          } : null),
          run,
        })),
      })),
      batch,
    } as unknown as D1Database;

    await expect(new D1ReviewWriter(database).update("teacher-1", "review-1", {
      expectedRevision: 4,
      studentName: "小红",
      report,
      annotations: [],
    })).rejects.toMatchObject({ name: "RevisionConflictError" });

    expect(run).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it("guards the teacher update itself against a concurrently started analysis", async () => {
    const statements: Array<{ sql: string }> = [];
    const run = vi.fn().mockResolvedValue({ meta: { changes: 0 } });
    const database = {
      prepare: vi.fn((sql: string) => {
        const statement = {
          sql,
          bind() { return statement; },
          first: vi.fn().mockResolvedValue(sql.startsWith("SELECT student_name") ? {
            student_name: "小明",
            config: JSON.stringify(config),
            report: null,
            status: "draft",
            revision: 4,
            analysis_run_id: null,
          } : null),
          run,
        };
        statements.push(statement);
        return statement;
      }),
    } as unknown as D1Database;

    await expect(new D1ReviewWriter(database).update("teacher-1", "review-1", {
      expectedRevision: 4,
      studentName: "小红",
    })).rejects.toMatchObject({ name: "RevisionConflictError" });

    const update = statements.find(({ sql }) => sql.includes("UPDATE reviews SET"));
    expect(update?.sql).toContain("analysis_run_id IS NULL");
  });

  it("allows teacher draft edits that no longer satisfy AI generation constraints", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const database = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(query.startsWith("SELECT student_name") ? {
            student_name: "小明", config: JSON.stringify(config), report: null, status: "draft", revision: 4,
            analysis_run_id: null,
          } : null),
          run,
        })),
      })),
    } as unknown as D1Database;

    await expect(new D1ReviewWriter(database).update("teacher-1", "review-1", {
      expectedRevision: 4,
      report: invalidReport,
    })).resolves.toEqual({ revision: 5 });
    expect(run).toHaveBeenCalledOnce();
  });

  it("marks a completed review as exported only for its owner", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const database = {
      prepare: vi.fn((query: string) => ({ bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(query.includes("SELECT revision") ? {
          revision: 7,
          report: JSON.stringify(paragraphReport),
          image_revision: 3,
          ocr_checkpoint: JSON.stringify(checkpoint),
          report_ocr_revision: 1,
          teacher_reviewed_at: Date.parse("2026-08-27T09:00:00.000Z"),
        } : null),
        all: vi.fn().mockResolvedValue({ results: [{ position: 0, width: 1000, height: 1500 }] }),
        run,
      })) })),
    } as unknown as D1Database;

    await expect(new D1ReviewWriter(database).markExported("teacher-1", "review-1")).resolves.toBe(true);

    expect(database.prepare).toHaveBeenCalledWith(expect.stringContaining("status = 'exported'"));
    expect(database.prepare).toHaveBeenCalledWith(expect.stringContaining("owner_id"));
    expect(database.prepare).toHaveBeenCalledWith(expect.stringContaining("revision = ?"));
  });

  it("does not mark a legacy report exported as a new paragraph delivery", async () => {
    const run = vi.fn();
    const database = {
      prepare: vi.fn((query: string) => ({ bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(query.includes("SELECT revision") ? {
          revision: 7,
          report: JSON.stringify(report),
          image_revision: 3,
          ocr_checkpoint: JSON.stringify(checkpoint),
          report_ocr_revision: 1,
          teacher_reviewed_at: Date.parse("2026-08-27T09:00:00.000Z"),
        } : null),
        all: vi.fn().mockResolvedValue({ results: [{ position: 0, width: 1000, height: 1500 }] }),
        run,
      })) })),
    } as unknown as D1Database;

    await expect(new D1ReviewWriter(database).markExported("teacher-1", "review-1"))
      .resolves.toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("atomically saves teacher edits and the reviewed timestamp with revision guards", async () => {
    const statements: Array<{ sql: string; bindings: unknown[] }> = [];
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
            sql.includes("SELECT config")
              ? { config: JSON.stringify(config), revision: 4 }
              : { id: "review-1" },
          ),
        };
        statements.push(statement);
        return statement;
      }),
      batch: vi.fn().mockResolvedValue([{ meta: { changes: 1 } }]),
    } as unknown as D1Database;

    await expect(new D1ReviewWriter(database).completeTeacherReview("teacher-1", "review-1", {
      expectedRevision: 4,
      studentName: "张小明",
      report,
      annotations: [],
    })).resolves.toEqual({ revision: 5 });

    const update = statements.find(({ sql }) => sql.includes("UPDATE reviews SET"));
    expect(update?.sql).toContain("teacher_reviewed_at = ?");
    expect(update?.sql).toContain("revision = revision + 1");
    expect(update?.sql).toContain("revision = ?");
    expect(statements.some(({ sql }) => sql.includes("DELETE FROM annotations") && sql.includes("EXISTS"))).toBe(true);
  });

  it("rejects completed teacher reviews that violate the stored assignment config", async () => {
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 1 } }]);
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue({ config: JSON.stringify(config), revision: 4 }),
        })),
      })),
      batch,
    } as unknown as D1Database;

    await expect(new D1ReviewWriter(database).completeTeacherReview("teacher-1", "review-1", {
      expectedRevision: 4,
      studentName: "张小明",
      report: invalidReport,
      annotations: [],
    })).rejects.toThrow(/sample paragraphs invalid/u);
    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects stale completed reviews before validating their sample content", async () => {
    const batch = vi.fn().mockResolvedValue([{ meta: { changes: 1 } }]);
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue({ config: JSON.stringify(config), revision: 5 }),
        })),
      })),
      batch,
    } as unknown as D1Database;

    await expect(new D1ReviewWriter(database).completeTeacherReview("teacher-1", "review-1", {
      expectedRevision: 4,
      studentName: "张小明",
      report: invalidReport,
      annotations: [],
    })).rejects.toMatchObject({ name: "RevisionConflictError" });
    expect(batch).not.toHaveBeenCalled();
  });

  it("returns only the deleted review's stored image paths", async () => {
    const database = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          all: vi.fn().mockResolvedValue({ results: query.includes("original_path") ? [{ original_path: "images/original.jpg", annotation_path: "images/annotation.jpg", ai_path: "images/ai.jpg" }] : [] }),
          first: vi.fn().mockResolvedValue(query.startsWith("SELECT id") ? { id: "review-1" } : null),
        })),
      })),
      batch: vi.fn().mockResolvedValue([]),
    } as unknown as D1Database;

    await expect(new D1ReviewWriter(database).deleteReview("teacher-1", "review-1")).resolves.toEqual([
      "images/original.jpg", "images/annotation.jpg", "images/ai.jpg",
    ]);
  });
});
