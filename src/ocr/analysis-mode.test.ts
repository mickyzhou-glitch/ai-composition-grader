import { describe, expect, it } from "vitest";

import type { OcrCheckpoint } from "./contracts";
import { analysisModeForCheckpoint } from "./analysis-mode";

const v1Checkpoint: OcrCheckpoint = {
  version: 1,
  sourceRevision: 1,
  ocrRevision: 0,
  editedAt: null,
  pages: [{ pageIndex: 0, text: "原文", readable: true, warnings: [], blocks: [] }],
};

const v2Checkpoint: OcrCheckpoint = {
  version: 2,
  sourceRevision: 1,
  ocrRevision: 0,
  editedAt: null,
  pages: [{ pageIndex: 0, text: "原文", readable: true, warnings: [], blocks: [] }],
  paragraphs: [{
    id: "paragraph-1",
    paragraphIndex: 0,
    text: "原文",
    segments: [{ pageIndex: 0, text: "原文", x: 0.1, y: 0.1, width: 0.3, height: 0.1 }],
  }],
};

describe("analysisModeForCheckpoint", () => {
  it("keeps full analysis for a missing or v1 checkpoint", () => {
    expect(analysisModeForCheckpoint("full", null)).toBe("full");
    expect(analysisModeForCheckpoint("full", v1Checkpoint)).toBe("full");
  });

  it("allows content_only only for an OCR v2 checkpoint", () => {
    expect(analysisModeForCheckpoint("content_only", v2Checkpoint)).toBe("content_only");
  });

  it.each([null, v1Checkpoint])(
    "rejects content_only without OCR v2",
    (checkpoint) => {
      expect(() => analysisModeForCheckpoint("content_only", checkpoint))
        .toThrow(expect.objectContaining({ code: "OCR_V2_REQUIRED" }));
    },
  );
});
