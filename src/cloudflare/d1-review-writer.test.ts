import { describe, expect, it, vi } from "vitest";

import { D1ReviewWriter } from "./d1-review-writer";

const config = {
  title: "自定义题目", grade: "六年级", writingRequirements: "叙事", targetCharacters: 600,
  structureRequirements: "完整", scoringFocus: "细节", templateType: "custom" as const,
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

  it("marks a completed review as exported only for its owner", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
    const database = {
      prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ run }) }),
    } as unknown as D1Database;

    await expect(new D1ReviewWriter(database).markExported("teacher-1", "review-1")).resolves.toBe(true);

    expect(database.prepare).toHaveBeenCalledWith(expect.stringContaining("status = 'exported'"));
    expect(database.prepare).toHaveBeenCalledWith(expect.stringContaining("owner_id"));
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
