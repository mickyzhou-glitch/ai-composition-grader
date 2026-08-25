import { describe, expect, it } from "vitest";

import {
  createOcrCheckpointV2,
  isOcrCheckpointV2,
  ocrCheckpointSchema,
  ocrCheckpointV1Schema,
  ocrCheckpointV2Schema,
  ocrParagraphSchema,
  ocrParagraphSegmentSchema,
  reviewAnnotationAnchorSchema,
  type OcrCheckpointV2,
  type OcrPage,
} from "./contracts";

type BuilderInput = Parameters<typeof createOcrCheckpointV2>[0];

function page(pageIndex: number, text: string): OcrPage {
  return {
    pageIndex,
    text,
    readable: true,
    warnings: [],
    blocks: [{ text, x: 0.1, y: 0.1, width: 0.8, height: 0.1 }],
  };
}

function checkpointV1() {
  return {
    version: 1 as const,
    sourceRevision: 2,
    ocrRevision: 0,
    editedAt: null,
    pages: [page(0, "我终于明白了。")],
  };
}

function checkpointV2(): OcrCheckpointV2 {
  return {
    version: 2,
    sourceRevision: 3,
    ocrRevision: 0,
    editedAt: null,
    pages: [page(0, "第一段文字。")],
    paragraphs: [{
      id: "paragraph-1",
      paragraphIndex: 0,
      text: "第一段文字。",
      segments: [{
        pageIndex: 0,
        text: "第一段\n文字。",
        x: 0.1,
        y: 0.2,
        width: 0.5,
        height: 0.08,
      }],
    }],
  };
}

function parseV2(value: unknown): OcrCheckpointV2 {
  return ocrCheckpointV2Schema.parse(value);
}

function buildV2(input: BuilderInput): OcrCheckpointV2 {
  return createOcrCheckpointV2(input);
}

describe("OCR contracts", () => {
  it("keeps the explicit version 1 schema and accepts existing checkpoints", () => {
    expect(ocrCheckpointV1Schema.parse(checkpointV1())).toEqual(checkpointV1());
    expect(ocrCheckpointSchema.parse(checkpointV1())).toEqual(checkpointV1());
  });

  it("requires version 1 pages to use continuous zero-based indexes", () => {
    expect(() => ocrCheckpointSchema.parse({
      ...checkpointV1(),
      pages: [{ ...checkpointV1().pages[0], pageIndex: 1 }],
    })).toThrow(/continuous/i);
  });

  it("rejects version 1 blocks that extend beyond the page", () => {
    expect(() => ocrCheckpointSchema.parse({
      ...checkpointV1(),
      pages: [{
        ...checkpointV1().pages[0],
        blocks: [{ text: "越界", x: 0.8, y: 0.4, width: 0.3, height: 0.05 }],
      }],
    })).toThrow(/page/i);
  });

  it("accepts a version 2 checkpoint with one single-page paragraph", () => {
    expect(parseV2(checkpointV2())).toEqual(checkpointV2());
    expect(ocrCheckpointSchema.parse(checkpointV2())).toEqual(checkpointV2());
  });

  it("identifies only valid version 2 checkpoints", () => {
    expect(isOcrCheckpointV2(checkpointV2())).toBe(true);
    expect(isOcrCheckpointV2(checkpointV1())).toBe(false);
    expect(isOcrCheckpointV2({ version: 2 })).toBe(false);
  });

  it("requires version 2 pages to use continuous zero-based indexes", () => {
    const value = checkpointV2();
    value.pages = [page(1, value.pages[0].text)];
    value.paragraphs[0].segments[0].pageIndex = 1;

    expect(() => parseV2(value)).toThrow(/continuous/i);
  });

  it("accepts one paragraph whose source segments cross a page boundary", () => {
    const value: OcrCheckpointV2 = {
      ...checkpointV2(),
      pages: [page(0, "跨页段落的上半部"), page(1, "与下半部。")],
      paragraphs: [{
        id: "paragraph-1",
        paragraphIndex: 0,
        text: "跨页段落的上半部与下半部。",
        segments: [
          { pageIndex: 0, text: "跨页段落的上半部", x: 0.1, y: 0.86, width: 0.7, height: 0.08 },
          { pageIndex: 1, text: "与下半部。", x: 0.1, y: 0.04, width: 0.5, height: 0.08 },
        ],
      }],
    };

    const parsed = parseV2(value);

    expect(parsed.paragraphs[0].id).toBe("paragraph-1");
    expect(parsed.paragraphs[0].segments.map(({ pageIndex }) => pageIndex)).toEqual([0, 1]);
  });

  it("builds stable sequential IDs and ignores arbitrary model IDs", () => {
    const value = buildV2({
      sourceRevision: 4,
      pages: [page(0, "第一段。第二段。")],
      paragraphs: [
        {
          id: { model: "hallucinated-id" },
          paragraphIndex: 0,
          text: "第一段。",
          segments: [{ pageIndex: 0, text: "第一段。", x: 0.1, y: 0.2, width: 0.4, height: 0.08 }],
        },
        {
          id: "paragraph-9000",
          paragraphIndex: 1,
          text: "第二段。",
          segments: [{ pageIndex: 0, text: "第二段。", x: 0.1, y: 0.5, width: 0.4, height: 0.08 }],
        },
      ],
    });

    expect(value).toMatchObject({ version: 2, ocrRevision: 0, editedAt: null });
    expect(value.paragraphs.map(({ id }) => id)).toEqual(["paragraph-1", "paragraph-2"]);
  });

  it("allows teacher-edited text while preserving source pages and segments", () => {
    const original = buildV2({
      sourceRevision: 3,
      pages: checkpointV2().pages,
      paragraphs: checkpointV2().paragraphs,
    });
    const edited = parseV2({
      ...original,
      ocrRevision: 1,
      editedAt: "2026-08-25T08:00:00.000Z",
      paragraphs: original.paragraphs.map((paragraph) => ({
        ...paragraph,
        text: "教师修订后的段落。",
      })),
    });

    expect(edited.paragraphs[0].text).toBe("教师修订后的段落。");
    expect(edited.pages).toEqual(original.pages);
    expect(edited.paragraphs[0].segments).toEqual(original.paragraphs[0].segments);
  });

  it("rejects an empty paragraph", () => {
    const value = checkpointV2();
    value.paragraphs[0].text = " \n ";

    expect(() => parseV2(value)).toThrow();
  });

  it("rejects discontinuous paragraph indexes", () => {
    const value = checkpointV2();
    value.paragraphs.push({
      id: "paragraph-2",
      paragraphIndex: 2,
      text: "第二段。",
      segments: [{ pageIndex: 0, text: "第二段。", x: 0.1, y: 0.5, width: 0.4, height: 0.08 }],
    });

    expect(() => parseV2(value)).toThrow(/continuous/i);
  });

  it("rejects paragraph segments that extend beyond the page", () => {
    const value = checkpointV2();
    value.paragraphs[0].segments[0] = {
      ...value.paragraphs[0].segments[0],
      x: 0.8,
      width: 0.3,
    };

    expect(() => parseV2(value)).toThrow(/page/i);
  });

  it("rejects paragraph segments that reference a missing page", () => {
    const value = checkpointV2();
    value.paragraphs[0].segments[0].pageIndex = 1;

    expect(() => parseV2(value)).toThrow(/existing page/i);
  });

  it("rejects paragraph segments in decreasing page or vertical reading order", () => {
    const value = checkpointV2();
    value.paragraphs[0].text = "后面前面";
    value.paragraphs[0].segments = [
      { pageIndex: 0, text: "后面", x: 0.1, y: 0.6, width: 0.3, height: 0.08 },
      { pageIndex: 0, text: "前面", x: 0.1, y: 0.2, width: 0.3, height: 0.08 },
    ];

    expect(() => parseV2(value)).toThrow(/reading order/i);
  });

  it("uses increasing x as the deterministic order for segments sharing one y", () => {
    const value = checkpointV2();
    value.paragraphs[0].text = "右左";
    value.paragraphs[0].segments = [
      { pageIndex: 0, text: "右", x: 0.6, y: 0.2, width: 0.2, height: 0.08 },
      { pageIndex: 0, text: "左", x: 0.1, y: 0.2, width: 0.2, height: 0.08 },
    ];

    expect(() => parseV2(value)).toThrow(/reading order/i);
  });

  it("rejects overlapping regions from different paragraphs on one page", () => {
    const value = checkpointV2();
    value.paragraphs.push({
      id: "paragraph-2",
      paragraphIndex: 1,
      text: "重叠的第二段。",
      segments: [{ pageIndex: 0, text: "重叠的第二段。", x: 0.5, y: 0.24, width: 0.4, height: 0.08 }],
    });

    expect(() => parseV2(value)).toThrow(/overlap/i);
  });

  it("allows regions from different paragraphs to touch at an edge", () => {
    const value = checkpointV2();
    value.paragraphs.push({
      id: "paragraph-2",
      paragraphIndex: 1,
      text: "相接的第二段。",
      segments: [{ pageIndex: 0, text: "相接的第二段。", x: 0.6, y: 0.2, width: 0.3, height: 0.08 }],
    });

    expect(parseV2(value)).toEqual(value);
  });

  it("rejects initial paragraph text that differs from its ordered segment text", () => {
    const value = checkpointV2();
    value.paragraphs[0].text = "不一致的初始文字。";

    expect(() => parseV2(value)).toThrow(/segment text/i);
  });

  it("keeps all new version 2 schemas strict", () => {
    expect(() => ocrParagraphSegmentSchema.parse({
      ...checkpointV2().paragraphs[0].segments[0],
      confidence: 0.99,
    })).toThrow();
    expect(() => ocrParagraphSchema.parse({
      ...checkpointV2().paragraphs[0],
      modelLabel: "intro",
    })).toThrow();
    expect(() => parseV2({ ...checkpointV2(), modelName: "untrusted" })).toThrow();
  });

  it("requires stable paragraph IDs", () => {
    const value = checkpointV2();
    value.paragraphs[0].id = "model-paragraph-id";

    expect(() => parseV2(value)).toThrow();
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
