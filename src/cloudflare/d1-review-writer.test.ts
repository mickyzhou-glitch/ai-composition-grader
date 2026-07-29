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
});
