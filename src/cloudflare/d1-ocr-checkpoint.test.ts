import { describe, expect, it, vi } from "vitest";

import type { OcrCheckpoint } from "../ocr/contracts";
import { D1OcrCheckpointRepository } from "./d1-ocr-checkpoint";

const checkpoint: OcrCheckpoint = {
  version: 1,
  sourceRevision: 3,
  ocrRevision: 0,
  editedAt: null,
  pages: [{
    pageIndex: 0,
    text: "我终于明白了。",
    readable: true,
    warnings: [],
    blocks: [{ text: "我终于明白了。", x: 0.2, y: 0.4, width: 0.3, height: 0.05 }],
  }],
};

function statement(result: { first?: unknown; changes?: number }) {
  const prepared = {
    bindings: [] as unknown[],
    bind(...bindings: unknown[]) {
      prepared.bindings = bindings;
      return prepared;
    },
    first: vi.fn(async () => result.first ?? null),
    run: vi.fn(async () => ({ meta: { changes: result.changes ?? 1 } })),
  };
  return prepared;
}

describe("D1OcrCheckpointRepository", () => {
  it("saves recognized OCR only for the captured image revision", async () => {
    const saved = statement({ changes: 1 });
    const database = { prepare: vi.fn(() => saved) } as unknown as D1Database;

    await expect(new D1OcrCheckpointRepository(database).saveRecognized(
      "owner-1", "review-1", 3, checkpoint.pages,
    )).resolves.toEqual(checkpoint);
    expect(saved.bindings).toEqual([
      JSON.stringify(checkpoint),
      "review-1",
      "owner-1",
      3,
    ]);
  });

  it("increments OCR revision while preserving internal blocks", async () => {
    const read = statement({ first: { image_revision: 3, ocr_checkpoint: JSON.stringify(checkpoint) } });
    const update = statement({ changes: 1 });
    const database = {
      prepare: vi.fn((sql: string) => sql.trimStart().startsWith("SELECT") ? read : update),
    } as unknown as D1Database;

    const result = await new D1OcrCheckpointRepository(database).editTexts(
      "owner-1", "review-1", 0, [{ pageIndex: 0, text: "教师修正后的正文。" }],
    );

    expect(result.ocrRevision).toBe(1);
    expect(result.pages[0].text).toBe("教师修正后的正文。");
    expect(result.pages[0].blocks).toEqual(checkpoint.pages[0].blocks);
  });

  it("returns a stable conflict when the expected OCR revision is stale", async () => {
    const read = statement({ first: { image_revision: 3, ocr_checkpoint: JSON.stringify(checkpoint) } });
    const database = { prepare: vi.fn(() => read) } as unknown as D1Database;

    await expect(new D1OcrCheckpointRepository(database).editTexts(
      "owner-1", "review-1", 2, [{ pageIndex: 0, text: "正文" }],
    )).rejects.toMatchObject({ code: "OCR_REVISION_CONFLICT", status: 409 });
  });

  it("omits original coordinate blocks from the browser view", () => {
    const view = D1OcrCheckpointRepository.publicView(checkpoint);

    expect(view).toEqual({
      ocrRevision: 0,
      editedAt: null,
      pages: [{ pageIndex: 0, text: "我终于明白了。", readable: true, warnings: [] }],
    });
    expect(JSON.stringify(view)).not.toContain("blocks");
  });
});
