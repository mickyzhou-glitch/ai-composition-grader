import { describe, expect, it, vi } from "vitest";

import { D1ImageWriter } from "./d1-image-writer";

describe("D1ImageWriter", () => {
  it("advances the image revision and clears OCR when replacing images", async () => {
    const prepared: Array<{ sql: string }> = [];
    const prepare = vi.fn((sql: string) => {
      prepared.push({ sql });
      return {
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(sql.includes("SELECT revision") ? { revision: 2 } : null),
          run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
          all: vi.fn().mockResolvedValue({ results: [{ id: 7, position: 0 }] }),
        })),
      };
    });
    const database = { prepare, batch: vi.fn().mockResolvedValue([]) } as unknown as D1Database;

    await new D1ImageWriter(database).replace("owner-1", "review-1", 2, [{
      originalName: "essay.jpg",
      mimeType: "image/jpeg",
      width: 100,
      height: 200,
      path: "images/essay.jpg",
    }], true);

    const update = prepared.find(({ sql }) => sql.includes("UPDATE reviews SET"));
    expect(update?.sql).toContain("image_revision = image_revision + 1");
    expect(update?.sql).toContain("ocr_checkpoint = NULL");
    expect(update?.sql).toContain("report_ocr_revision = NULL");
    expect(update?.sql).toContain("teacher_reviewed_at = NULL");
    expect(update?.sql).not.toContain("expires_at");
  });
});
