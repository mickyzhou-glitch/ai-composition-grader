import { describe, expect, it } from "vitest";

import {
  createOcrCheckpointV2,
  isOcrCheckpointV2,
  ocrCheckpointSchema,
  ocrCheckpointV1Schema,
  ocrCheckpointV2Schema,
  paragraphAnnotationAnchorSchema,
  ocrParagraphSchema,
  ocrParagraphSegmentSchema,
  reviewAnnotationAnchorSchema,
  type OcrCheckpoint,
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

  it("identifies parsed version 2 checkpoints by their version only", () => {
    const parsedV2 = ocrCheckpointSchema.parse(checkpointV2());
    let pagesReadCount = 0;
    const checkpointWithObservablePages: OcrCheckpoint = {
      ...parsedV2,
      get pages() {
        pagesReadCount += 1;
        return parsedV2.pages;
      },
    };

    expect(isOcrCheckpointV2(checkpointWithObservablePages)).toBe(true);
    expect(pagesReadCount).toBe(0);
    expect(isOcrCheckpointV2(ocrCheckpointSchema.parse(checkpointV1()))).toBe(false);

    if (false) {
      // @ts-expect-error The guard accepts only checkpoints parsed at the schema boundary.
      isOcrCheckpointV2({ version: 2 });
    }
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

  it("rejects a well-formed paragraph ID that does not match its order", () => {
    const value = checkpointV2();
    value.paragraphs.push({
      id: "paragraph-3",
      paragraphIndex: 1,
      text: "第二段。",
      segments: [{ pageIndex: 0, text: "第二段。", x: 0.1, y: 0.5, width: 0.4, height: 0.08 }],
    });

    expect(() => parseV2(value)).toThrow(/stable id/i);
  });

  it("rejects duplicate well-formed paragraph IDs", () => {
    const value = checkpointV2();
    value.paragraphs.push({
      id: "paragraph-1",
      paragraphIndex: 1,
      text: "第二段。",
      segments: [{ pageIndex: 0, text: "第二段。", x: 0.1, y: 0.5, width: 0.4, height: 0.08 }],
    });

    expect(() => parseV2(value)).toThrow(/stable id/i);
  });

  it("validates invalid candidates without reading model IDs", () => {
    let modelIdReadCount = 0;
    const invalidParagraph = {
      get id(): unknown {
        modelIdReadCount += 1;
        return "paragraph-1";
      },
      paragraphIndex: 1,
      text: "索引无效的段落。",
      segments: [{
        pageIndex: 0,
        text: "索引无效的段落。",
        x: 0.1,
        y: 0.2,
        width: 0.5,
        height: 0.08,
      }],
    };

    expect(() => buildV2({
      sourceRevision: 4,
      pages: [page(0, "索引无效的段落。")],
      paragraphs: [invalidParagraph],
    })).toThrow(/continuous/i);
    expect(modelIdReadCount).toBe(0);
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

  it("rejects paragraph segments in decreasing page order", () => {
    const value = checkpointV2();
    value.pages = [page(0, "第一页"), page(1, "第二页")];
    value.paragraphs[0].text = "第二页第一页";
    value.paragraphs[0].segments = [
      { pageIndex: 1, text: "第二页", x: 0.1, y: 0.2, width: 0.3, height: 0.08 },
      { pageIndex: 0, text: "第一页", x: 0.1, y: 0.6, width: 0.3, height: 0.08 },
    ];

    expect(() => parseV2(value)).toThrow(/reading order/i);
  });

  it("rejects paragraph segments in decreasing vertical order on one page", () => {
    const value = checkpointV2();
    value.paragraphs[0].text = "后面前面";
    value.paragraphs[0].segments = [
      { pageIndex: 0, text: "后面", x: 0.1, y: 0.6, width: 0.3, height: 0.08 },
      { pageIndex: 0, text: "前面", x: 0.1, y: 0.2, width: 0.3, height: 0.08 },
    ];

    expect(() => parseV2(value)).toThrow(/reading order/i);
  });

  it("accepts left-to-right segments on one line despite slight y jitter", () => {
    const value = checkpointV2();
    value.paragraphs[0].text = "左边右边";
    value.paragraphs[0].segments = [
      { pageIndex: 0, text: "左边", x: 0.1, y: 0.203, width: 0.2, height: 0.08 },
      { pageIndex: 0, text: "右边", x: 0.4, y: 0.2, width: 0.2, height: 0.08 },
    ];

    expect(parseV2(value)).toEqual(value);
  });

  it("rejects right-to-left segments on one line despite slight y jitter", () => {
    const value = checkpointV2();
    value.paragraphs[0].text = "右左";
    value.paragraphs[0].segments = [
      { pageIndex: 0, text: "右", x: 0.6, y: 0.2, width: 0.2, height: 0.08 },
      { pageIndex: 0, text: "左", x: 0.1, y: 0.203, width: 0.2, height: 0.08 },
    ];

    expect(() => parseV2(value)).toThrow(/reading order/i);
  });

  it("accepts vertically ordered adjacent lines whose boxes overlap slightly", () => {
    const value = checkpointV2();
    value.paragraphs[0].text = "上行下行";
    value.paragraphs[0].segments = [
      { pageIndex: 0, text: "上行", x: 0.6, y: 0.2, width: 0.2, height: 0.08 },
      { pageIndex: 0, text: "下行", x: 0.1, y: 0.279_5, width: 0.2, height: 0.08 },
    ];

    expect(parseV2(value)).toEqual(value);
  });

  it("rejects reversed adjacent lines whose boxes overlap slightly", () => {
    const value = checkpointV2();
    value.paragraphs[0].text = "下行上行";
    value.paragraphs[0].segments = [
      { pageIndex: 0, text: "下行", x: 0.1, y: 0.279_5, width: 0.2, height: 0.08 },
      { pageIndex: 0, text: "上行", x: 0.6, y: 0.2, width: 0.2, height: 0.08 },
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

  it("allows decimal regions from different paragraphs to touch at an edge", () => {
    const value = checkpointV2();
    value.paragraphs[0].segments[0].width = 0.2;
    value.paragraphs.push({
      id: "paragraph-2",
      paragraphIndex: 1,
      text: "相接的第二段。",
      segments: [{ pageIndex: 0, text: "相接的第二段。", x: 0.3, y: 0.2, width: 0.3, height: 0.08 }],
    });

    expect(parseV2(value)).toEqual(value);
  });

  it("rejects a real overlap slightly larger than the coordinate tolerance", () => {
    const value = checkpointV2();
    value.paragraphs[0].segments[0].width = 0.2;
    value.paragraphs.push({
      id: "paragraph-2",
      paragraphIndex: 1,
      text: "轻微重叠的第二段。",
      segments: [{
        pageIndex: 0,
        text: "轻微重叠的第二段。",
        x: 0.299_998,
        y: 0.2,
        width: 0.3,
        height: 0.08,
      }],
    });

    expect(() => parseV2(value)).toThrow(/overlap/i);
  });

  it("rejects initial paragraph text that differs from its ordered segment text", () => {
    const value = checkpointV2();
    value.paragraphs[0].text = "不一致的初始文字。";

    expect(() => parseV2(value)).toThrow(/segment text/i);
  });

  it("accepts layout line breaks while preserving English and numeric word boundaries", () => {
    const value = checkpointV2();
    value.paragraphs[0].text = "我用 AI assistant 批改 2 essays。";
    value.paragraphs[0].segments[0].text = "我用 AI\nassistant\n批改 2\nessays。";

    expect(parseV2(value)).toEqual(value);
  });

  it("rejects mixed Chinese text when English or numeric word boundaries disappear", () => {
    const value = checkpointV2();
    value.paragraphs[0].text = "我用 AI assistant 批改 2 essays。";
    value.paragraphs[0].segments[0].text = "我用 AIassistant 批改 2essays。";

    expect(() => parseV2(value)).toThrow(/segment text/i);
  });

  it("accepts an English word boundary across page segments", () => {
    const value = checkpointV2();
    value.pages = [page(0, "AI"), page(1, "assistant")];
    value.paragraphs[0].text = "AI assistant";
    value.paragraphs[0].segments = [
      { pageIndex: 0, text: "AI", x: 0.1, y: 0.86, width: 0.2, height: 0.08 },
      { pageIndex: 1, text: "assistant", x: 0.1, y: 0.04, width: 0.4, height: 0.08 },
    ];

    expect(parseV2(value)).toEqual(value);
  });

  it("accepts a numeric word boundary across two segments", () => {
    const value = checkpointV2();
    value.paragraphs[0].text = "2026 08";
    value.paragraphs[0].segments = [
      { pageIndex: 0, text: "2026", x: 0.1, y: 0.2, width: 0.2, height: 0.08 },
      { pageIndex: 0, text: "08", x: 0.4, y: 0.2, width: 0.2, height: 0.08 },
    ];

    expect(parseV2(value)).toEqual(value);
  });

  it("rejects a missing English boundary represented by two segments", () => {
    const value = checkpointV2();
    value.paragraphs[0].text = "AIassistant";
    value.paragraphs[0].segments = [
      { pageIndex: 0, text: "AI", x: 0.1, y: 0.2, width: 0.2, height: 0.08 },
      { pageIndex: 0, text: "assistant", x: 0.4, y: 0.2, width: 0.4, height: 0.08 },
    ];

    expect(() => parseV2(value)).toThrow(/segment text/i);
  });

  it("keeps Chinese text continuous across two segments", () => {
    const value = checkpointV2();
    value.paragraphs[0].text = "第一段";
    value.paragraphs[0].segments = [
      { pageIndex: 0, text: "第一", x: 0.1, y: 0.2, width: 0.2, height: 0.08 },
      { pageIndex: 0, text: "段", x: 0.4, y: 0.2, width: 0.2, height: 0.08 },
    ];

    expect(parseV2(value)).toEqual(value);
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

  it("accepts strict paragraph annotation anchors without page coordinates", () => {
    const anchor = {
      paragraphId: "paragraph-1",
      category: "structure" as const,
      anchorText: "我终于明白了",
      comment: "这里需要回扣题目",
      isHighlight: false,
    };

    expect(paragraphAnnotationAnchorSchema.parse(anchor)).toEqual(anchor);
    expect(() => paragraphAnnotationAnchorSchema.parse({ ...anchor, pageIndex: 0 })).toThrow();
    expect(() => paragraphAnnotationAnchorSchema.parse({ ...anchor, anchorText: " " })).toThrow();
  });
});
