import { describe, expect, it } from "vitest";

import { ocrCheckpointSchema, reviewAnnotationAnchorSchema } from "./contracts";

function checkpoint() {
  return {
    version: 1 as const,
    sourceRevision: 2,
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
}

describe("OCR contracts", () => {
  it("accepts a versioned checkpoint with normalized blocks", () => {
    expect(ocrCheckpointSchema.parse(checkpoint())).toEqual(checkpoint());
  });

  it("requires pages to use continuous zero-based indexes", () => {
    expect(() => ocrCheckpointSchema.parse({
      ...checkpoint(),
      pages: [{ ...checkpoint().pages[0], pageIndex: 1 }],
    })).toThrow(/continuous/i);
  });

  it("rejects blocks that extend beyond the page", () => {
    expect(() => ocrCheckpointSchema.parse({
      ...checkpoint(),
      pages: [{
        ...checkpoint().pages[0],
        blocks: [{ text: "越界", x: 0.8, y: 0.4, width: 0.3, height: 0.05 }],
      }],
    })).toThrow(/page/i);
  });

  it("rejects unknown fields and model-supplied coordinates on anchors", () => {
    expect(() => reviewAnnotationAnchorSchema.parse({
      pageIndex: 0,
      category: "structure",
      anchorText: "我终于明白了",
      comment: "这里需要回扣题目",
      isHighlight: false,
      x: 0.2,
    })).toThrow();
  });
});
