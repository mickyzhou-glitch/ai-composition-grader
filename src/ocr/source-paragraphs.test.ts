// @vitest-environment node

import { describe, expect, it } from "vitest";

import { createOcrCheckpointV2, type OcrPage } from "./contracts";
import { alignParagraphsToSource, type SourceParagraph } from "./source-paragraphs";

function page(pageIndex: number, text: string): OcrPage {
  return {
    pageIndex,
    text,
    readable: true,
    warnings: [],
    blocks: [{ text: text.trim() || "空白", x: 0.1, y: 0.1, width: 0.8, height: 0.2 }],
  };
}

function paragraph(paragraphIndex: number, text: string, pageIndex = 0): SourceParagraph {
  return {
    paragraphIndex,
    text,
    segments: [{ pageIndex, text, x: 0.1, y: 0.2 + paragraphIndex * 0.1, width: 0.6, height: 0.08 }],
  };
}

const fiveLines = ["第一段。", "第二段。", "第三段。", "第四段。", "第五段。"];

describe("alignParagraphsToSource", () => {
  it("页文本有 5 个自然段而模型只给 3 段时拆成 5 段", () => {
    const pages = [page(0, fiveLines.join("\n"))];
    const merged = [
      paragraph(0, "第一段。第二段。"),
      paragraph(1, "第三段。"),
      paragraph(2, "第四段。第五段。"),
    ];

    const aligned = alignParagraphsToSource(pages, merged);

    expect(aligned).toHaveLength(5);
    expect(aligned.map((item) => item.text)).toEqual(fiveLines);
    expect(aligned.map((item) => item.paragraphIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(createOcrCheckpointV2({ sourceRevision: 1, pages, paragraphs: aligned }).paragraphs)
      .toHaveLength(5);
  });

  it("页文本被合成一行时，仍按段落文本里的换行拆开", () => {
    const pages = [page(0, fiveLines.join(""))];
    const merged = [
      paragraph(0, "第一段。\n第二段。"),
      paragraph(1, "第三段。"),
      paragraph(2, "第四段。\n第五段。"),
    ];

    const aligned = alignParagraphsToSource(pages, merged);

    expect(aligned.map((item) => item.text)).toEqual(fiveLines);
    expect(createOcrCheckpointV2({ sourceRevision: 1, pages, paragraphs: aligned }).paragraphs.map(({ id }) => id))
      .toEqual(["paragraph-1", "paragraph-2", "paragraph-3", "paragraph-4", "paragraph-5"]);
  });

  it("模型段数已经不少于原文时不合并，并保留原有定位", () => {
    const pages = [page(0, "一二三")];
    const paragraphs = fiveLines.map((text, index) => paragraph(index, text));

    expect(alignParagraphsToSource(pages, paragraphs)).toBe(paragraphs);
  });

  it("跨页未完句续写仍算一段，句号后的下一段分开", () => {
    const pages = [
      page(0, "第一段还没写完"),
      page(1, "就换页了。\n第二段。"),
    ];
    const merged = [paragraph(0, "第一段还没写完就换页了。第二段。")];

    const aligned = alignParagraphsToSource(pages, merged);

    expect(aligned.map((item) => item.text)).toEqual(["第一段还没写完就换页了。", "第二段。"]);
    expect(aligned[0].segments.map((segment) => segment.pageIndex)).toEqual([0, 1]);
    expect(createOcrCheckpointV2({ sourceRevision: 1, pages, paragraphs: aligned }).paragraphs).toHaveLength(2);
  });

  it("下页另起缩进时即使上页没有句号也不并段", () => {
    const pages = [
      page(0, "第一段没写完"),
      page(1, "　　第二段。"),
    ];

    const aligned = alignParagraphsToSource(pages, [paragraph(0, "第一段没写完第二段。")]);

    expect(aligned.map((item) => item.text)).toEqual(["第一段没写完", "第二段。"]);
  });

  it("模型已正确识别的跨页段保持原样", () => {
    const pages = [page(0, "跨页段落的上半部"), page(1, "与下半部。")];
    const paragraphs: SourceParagraph[] = [{
      paragraphIndex: 0,
      text: "跨页段落的上半部与下半部。",
      segments: [
        { pageIndex: 0, text: "跨页段落的上半部", x: 0.1, y: 0.86, width: 0.7, height: 0.08 },
        { pageIndex: 1, text: "与下半部。", x: 0.1, y: 0.04, width: 0.5, height: 0.08 },
      ],
    }];

    expect(alignParagraphsToSource(pages, paragraphs)).toBe(paragraphs);
  });
});
