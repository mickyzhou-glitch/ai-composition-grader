import { describe, expect, it, vi } from "vitest";

import type { VisionOcrResult } from "../ai/vision-ocr-adapter";
import type { OcrCheckpointV1, OcrCheckpointV2 } from "../ocr/contracts";
import { D1OcrCheckpointRepository } from "./d1-ocr-checkpoint";

const recognizedWithModelIds = {
  model: "vision-model-must-not-be-persisted",
  pages: [
    {
      pageIndex: 0,
      text: "跨页段落的上半部",
      readable: true,
      warnings: [],
      blocks: [{ text: "跨页段落的上半部", x: 0.1, y: 0.82, width: 0.7, height: 0.08 }],
    },
    {
      pageIndex: 1,
      text: "与下半部。\n第二段。",
      readable: true,
      warnings: [],
      blocks: [{ text: "与下半部。第二段。", x: 0.1, y: 0.04, width: 0.7, height: 0.12 }],
    },
  ],
  paragraphs: [
    {
      id: "model-paragraph-a",
      paragraphIndex: 0,
      text: "跨页段落的上半部与下半部。",
      segments: [
        { pageIndex: 0, text: "跨页段落的上半部", x: 0.1, y: 0.82, width: 0.7, height: 0.08 },
        { pageIndex: 1, text: "与下半部。", x: 0.1, y: 0.04, width: 0.5, height: 0.08 },
      ],
    },
    {
      id: "model-paragraph-b",
      paragraphIndex: 1,
      text: "第二段。",
      segments: [
        { pageIndex: 1, text: "第二段。", x: 0.1, y: 0.3, width: 0.4, height: 0.08 },
      ],
    },
  ],
};

const recognized: VisionOcrResult = recognizedWithModelIds;

const checkpointV2: OcrCheckpointV2 = {
  version: 2,
  sourceRevision: 3,
  ocrRevision: 0,
  editedAt: null,
  pages: recognized.pages,
  paragraphs: recognized.paragraphs.map(({ paragraphIndex, text, segments }, index) => ({
    id: `paragraph-${index + 1}`,
    paragraphIndex,
    text,
    segments,
  })),
};

const checkpointV1: OcrCheckpointV1 = {
  version: 1,
  sourceRevision: 3,
  ocrRevision: 0,
  editedAt: null,
  pages: [recognized.pages[0]],
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

function editingRepository(checkpoint: OcrCheckpointV1 | OcrCheckpointV2) {
  const read = statement({
    first: { image_revision: checkpoint.sourceRevision, ocr_checkpoint: JSON.stringify(checkpoint) },
  });
  const update = statement({ changes: 1 });
  const database = {
    prepare: vi.fn((sql: string) => sql.trimStart().startsWith("SELECT") ? read : update),
  } as unknown as D1Database;
  return { repository: new D1OcrCheckpointRepository(database), update };
}

describe("D1OcrCheckpointRepository", () => {
  it("saves a version 2 checkpoint with stable IDs and cross-page segments", async () => {
    const saved = statement({ changes: 1 });
    const database = { prepare: vi.fn(() => saved) } as unknown as D1Database;

    const checkpoint = await new D1OcrCheckpointRepository(database).saveRecognized(
      "owner-1", "review-1", 3, recognizedWithModelIds,
    );

    expect(checkpoint).toEqual(checkpointV2);
    expect(checkpoint.paragraphs.map(({ id }) => id)).toEqual(["paragraph-1", "paragraph-2"]);
    expect(checkpoint.paragraphs[0].segments.map(({ pageIndex }) => pageIndex)).toEqual([0, 1]);
    expect(JSON.stringify(checkpoint)).not.toContain("vision-model-must-not-be-persisted");
    expect(JSON.stringify(checkpoint)).not.toContain("model-paragraph");
    expect(JSON.parse(String(saved.bindings[0]))).toEqual(checkpointV2);
    expect(saved.bindings.slice(1)).toEqual(["review-1", "owner-1", 3]);
  });

  it("rejects a recognized result when the captured image revision changed", async () => {
    const saved = statement({ changes: 0 });
    const database = { prepare: vi.fn(() => saved) } as unknown as D1Database;

    await expect(new D1OcrCheckpointRepository(database).saveRecognized(
      "owner-1", "review-1", 3, recognized,
    )).rejects.toMatchObject({ code: "IMAGE_REVISION_CONFLICT", status: 409 });
  });

  it("edits every paragraph text while preserving source pages and segments", async () => {
    const { repository } = editingRepository(checkpointV2);

    const result = await repository.editParagraphTexts(
      "owner-1",
      "review-1",
      0,
      [
        { paragraphId: "paragraph-1", text: "  教师修正后的第一段。  " },
        { paragraphId: "paragraph-2", text: "教师修正后的第二段。" },
      ],
    );

    expect(result).toMatchObject({
      version: 2,
      sourceRevision: 3,
      ocrRevision: 1,
      paragraphs: [
        { id: "paragraph-1", text: "教师修正后的第一段。" },
        { id: "paragraph-2", text: "教师修正后的第二段。" },
      ],
    });
    expect(result.editedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    expect(result.pages).toEqual(checkpointV2.pages);
    expect(result.paragraphs.map(({ segments }) => segments)).toEqual(
      checkpointV2.paragraphs.map(({ segments }) => segments),
    );
  });

  it.each([
    ["missing", [{ paragraphId: "paragraph-1", text: "第一段" }]],
    ["duplicate", [
      { paragraphId: "paragraph-1", text: "第一段" },
      { paragraphId: "paragraph-1", text: "第二段" },
    ]],
    ["out of order", [
      { paragraphId: "paragraph-2", text: "第二段" },
      { paragraphId: "paragraph-1", text: "第一段" },
    ]],
    ["unknown", [
      { paragraphId: "paragraph-1", text: "第一段" },
      { paragraphId: "paragraph-99", text: "第二段" },
    ]],
    ["empty text", [
      { paragraphId: "paragraph-1", text: "第一段" },
      { paragraphId: "paragraph-2", text: " \n " },
    ]],
  ])("rejects %s paragraph edit payloads", async (_case, edits) => {
    const { repository } = editingRepository(checkpointV2);

    await expect(repository.editParagraphTexts("owner-1", "review-1", 0, edits))
      .rejects.toBeInstanceOf(Error);
  });

  it("requires OCR v2 instead of disguising page edits as paragraphs", async () => {
    const { repository } = editingRepository(checkpointV1);

    await expect(repository.editParagraphTexts(
      "owner-1", "review-1", 0, [{ paragraphId: "paragraph-1", text: "正文" }],
    )).rejects.toMatchObject({ code: "OCR_V2_REQUIRED", status: 409 });
  });

  it("returns a stable conflict when the expected OCR revision is stale", async () => {
    const { repository } = editingRepository(checkpointV2);

    await expect(repository.editParagraphTexts(
      "owner-1", "review-1", 2, checkpointV2.paragraphs.map(({ id, text }) => ({
        paragraphId: id,
        text,
      })),
    )).rejects.toMatchObject({ code: "OCR_REVISION_CONFLICT", status: 409 });
  });

  it("returns discriminated safe browser views for v1 and v2 checkpoints", () => {
    const v1 = D1OcrCheckpointRepository.publicView(checkpointV1);
    const v2 = D1OcrCheckpointRepository.publicView(checkpointV2);

    expect(v1).toEqual({
      version: 1,
      ocrRevision: 0,
      editedAt: null,
      pages: [{
        pageIndex: 0,
        text: "跨页段落的上半部",
        readable: true,
        warnings: [],
      }],
    });
    expect(v2).toMatchObject({ version: 2, ocrRevision: 0 });
    if (v2.version !== 2) throw new Error("expected OCR v2 public view");
    expect(v2.paragraphs[0]).toEqual({
        id: "paragraph-1",
        paragraphIndex: 0,
        text: "跨页段落的上半部与下半部。",
        segments: [
          { pageIndex: 0, x: 0.1, y: 0.82, width: 0.7, height: 0.08 },
          { pageIndex: 1, x: 0.1, y: 0.04, width: 0.5, height: 0.08 },
        ],
    });
    expect(JSON.stringify(v1)).not.toContain("blocks");
    expect(JSON.stringify(v2)).not.toContain("blocks");
    for (const paragraph of v2.paragraphs) {
      for (const segment of paragraph.segments) {
        expect(segment).not.toHaveProperty("text");
      }
    }
  });
});
