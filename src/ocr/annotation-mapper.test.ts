import { describe, expect, it } from "vitest";

import type { OcrCheckpoint, ReviewAnnotationAnchor } from "./contracts";
import { mapAnnotationAnchors } from "./annotation-mapper";

function checkpoint(blocks: OcrCheckpoint["pages"][number]["blocks"]): OcrCheckpoint {
  return {
    version: 1,
    sourceRevision: 2,
    ocrRevision: 0,
    editedAt: null,
    pages: [{
      pageIndex: 0,
      text: blocks.map(({ text }) => text).join(""),
      readable: true,
      warnings: [],
      blocks,
    }],
  };
}

const anchor: ReviewAnnotationAnchor = {
  pageIndex: 0,
  category: "structure",
  anchorText: "我终于明白了",
  comment: "这里需要回扣题目",
  isHighlight: false,
};

describe("mapAnnotationAnchors", () => {
  it("maps one unique normalized block match", () => {
    const result = mapAnnotationAnchors(checkpoint([
      { text: "我终于明白了。", x: 0.2, y: 0.4, width: 0.3, height: 0.05 },
    ]), [anchor]);

    expect(result).toEqual([{
      pageIndex: 0,
      x: 0.2,
      y: 0.4,
      category: "structure",
      anchorText: "我终于明白了",
      comment: "这里需要回扣题目",
      isHighlight: false,
    }]);
  });

  it("matches text split across adjacent blocks after whitespace and punctuation normalization", () => {
    const result = mapAnnotationAnchors(checkpoint([
      { text: "我终于 ", x: 0.1, y: 0.2, width: 0.2, height: 0.04 },
      { text: "明白了，", x: 0.32, y: 0.2, width: 0.2, height: 0.04 },
    ]), [{ ...anchor, anchorText: "我终于明白了," }]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ x: 0.1, y: 0.2 });
  });

  it("drops ambiguous repeated matches", () => {
    const result = mapAnnotationAnchors(checkpoint([
      { text: "我终于明白了", x: 0.1, y: 0.2, width: 0.2, height: 0.04 },
      { text: "我终于明白了", x: 0.1, y: 0.5, width: 0.2, height: 0.04 },
    ]), [anchor]);

    expect(result).toEqual([]);
  });

  it("drops text added by a teacher when it is absent from original blocks", () => {
    const result = mapAnnotationAnchors(checkpoint([
      { text: "原来的句子", x: 0.1, y: 0.2, width: 0.2, height: 0.04 },
    ]), [{ ...anchor, anchorText: "教师后来补写的句子" }]);

    expect(result).toEqual([]);
  });
});
