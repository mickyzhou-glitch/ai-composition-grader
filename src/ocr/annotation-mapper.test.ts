import { describe, expect, it } from "vitest";

import type { OcrCheckpointV2, ParagraphAnnotationAnchor } from "./contracts";
import { mapAnnotationAnchors } from "./annotation-mapper";

function checkpoint(): OcrCheckpointV2 {
  return {
    version: 2,
    sourceRevision: 2,
    ocrRevision: 0,
    editedAt: null,
    pages: [
      {
        pageIndex: 0,
        text: "这是开头。这是重复句。",
        readable: true,
        warnings: [],
        blocks: [
          { text: "这是开头。", x: 0.2, y: 0.3, width: 0.3, height: 0.05 },
          { text: "这是重复句。", x: 0.2, y: 0.5, width: 0.3, height: 0.05 },
        ],
      },
      {
        pageIndex: 1,
        text: "转折之后，我找到了答案。这是重复句。",
        readable: true,
        warnings: [],
        blocks: [
          { text: "转折之后，", x: 0.12, y: 0.08, width: 0.28, height: 0.05 },
          { text: "我找到了答案。", x: 0.42, y: 0.08, width: 0.35, height: 0.05 },
          { text: "这是重复句。", x: 0.12, y: 0.2, width: 0.3, height: 0.05 },
        ],
      },
    ],
    paragraphs: [{
      id: "paragraph-1",
      paragraphIndex: 0,
      text: "这是开头。这是重复句。转折之后，我找到了答案。这是重复句。",
      segments: [
        { pageIndex: 0, text: "这是开头。这是重复句。", x: 0.1, y: 0.25, width: 0.7, height: 0.35 },
        { pageIndex: 1, text: "转折之后，我找到了答案。这是重复句。", x: 0.1, y: 0.05, width: 0.75, height: 0.25 },
      ],
    }],
  };
}

const anchor: ParagraphAnnotationAnchor = {
  paragraphId: "paragraph-1",
  category: "structure",
  anchorText: "转折之后",
  comment: "补充因果",
  isHighlight: false,
};

describe("mapAnnotationAnchors", () => {
  it("maps a cross-page paragraph anchor through its unique segment and page blocks", () => {
    expect(mapAnnotationAnchors(checkpoint(), [anchor])).toEqual([{
      pageIndex: 1,
      x: 0.12,
      y: 0.08,
      category: "structure",
      anchorText: "转折之后",
      comment: "补充因果",
      isHighlight: false,
    }]);
  });

  it("matches text split across adjacent blocks after whitespace and punctuation normalization", () => {
    const result = mapAnnotationAnchors(
      checkpoint(),
      [{ ...anchor, anchorText: "转折之后, 我找到" }],
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ pageIndex: 1, x: 0.12, y: 0.08 });
  });

  it.each([
    [{ ...anchor, paragraphId: "paragraph-9" }, "an unknown paragraph"],
    [{ ...anchor, anchorText: "教师后来补写的句子" }, "text absent from original segments"],
    [{ ...anchor, anchorText: "这是重复句" }, "an anchor found in multiple segments"],
  ] satisfies Array<[ParagraphAnnotationAnchor, string]>)
  ("drops %s (%s)", (candidate) => {
    expect(mapAnnotationAnchors(checkpoint(), [candidate])).toEqual([]);
  });

  it("drops a segment match when page blocks contain ambiguous candidates", () => {
    const value = checkpoint();
    value.pages[1].blocks.push({ text: "转折之后，", x: 0.12, y: 0.7, width: 0.28, height: 0.05 });

    expect(mapAnnotationAnchors(value, [anchor])).toEqual([]);
  });
});
