import { describe, expect, it } from "vitest";

import type { DeliveryDocument, DeliveryParagraph } from "@/src/delivery/contracts";
import { paginateDeliveryDocument } from "./delivery-pagination";

const measureText = (text: string, fontPt: number) => (
  Array.from(text).length * fontPt * 0.18
);

function paragraph(
  paragraphNumber: number,
  options: {
    crops?: Array<{ width: number; height: number }>;
    suggestionCount?: number;
    suggestionText?: string;
    revisionText?: string;
  } = {},
): DeliveryParagraph {
  const suggestionText = options.suggestionText ?? "补充一处具体动作";
  return {
    paragraphNumber,
    crops: (options.crops ?? [{ width: 1200, height: 300 }]).map((crop, index) => ({
      pageIndex: index,
      bytes: new Uint8Array([paragraphNumber, index]),
      ...crop,
    })),
    suggestions: Array.from({ length: options.suggestionCount ?? 1 }, () => ({
      problem: suggestionText,
      advice: suggestionText,
      example: suggestionText,
    })),
    revisionRuns: [{
      kind: "unchanged",
      text: options.revisionText ?? "我终于鼓起勇气走上了舞台。".repeat(4),
    }],
  };
}

function documentWith(...paragraphs: DeliveryParagraph[]): DeliveryDocument {
  return { title: "为自己鼓掌", studentName: "张小明", paragraphs };
}

describe("交付文档分页", () => {
  it("让文档标题跟随首图，并让建议和修改稿标题跟随必要内容", () => {
    const pages = paginateDeliveryDocument(documentWith(paragraph(1)), { measureText });

    expect(pages).toHaveLength(1);
    expect(pages[0].hasDocumentTitle).toBe(true);
    expect(pages[0].blocks.map(({ kind }) => kind)).toEqual([
      "paragraph-heading",
      "crop",
      "suggestion-heading",
      "suggestion",
      "revision-heading",
      "revision-lines",
    ]);
    expect(pages[0].blocks[0]).toMatchObject({
      kind: "paragraph-heading",
      paragraphNumber: 1,
      continued: false,
    });
    expect(pages[0].blocks.find(({ kind }) => kind === "revision-lines"))
      .toMatchObject({ kind: "revision-lines", lineCount: expect.any(Number) });
  });

  it("完整段落能放入空页但放不进当前剩余空间时整体换页", () => {
    const pages = paginateDeliveryDocument(documentWith(
      paragraph(1, { crops: [{ width: 900, height: 600 }] }),
      paragraph(2, { crops: [{ width: 900, height: 600 }] }),
    ), { measureText });

    const firstParagraphPages = pages.flatMap((page, pageIndex) => (
      page.blocks.some((block) => block.kind === "paragraph-heading" && block.paragraphNumber === 1)
        ? [pageIndex]
        : []
    ));
    const secondParagraphPages = pages.flatMap((page, pageIndex) => (
      page.blocks.some((block) => block.kind === "paragraph-heading" && block.paragraphNumber === 2)
        ? [pageIndex]
        : []
    ));
    expect(firstParagraphPages).toEqual([0]);
    expect(secondParagraphPages).toEqual([1]);
    expect(pages[1].blocks.every((block) => (
      block.kind !== "paragraph-heading" || block.continued === false
    ))).toBe(true);
    expect(pages[0].remainingHeightMm).toBeLessThan(
      pages[1].blocks.reduce((sum, block) => sum + block.heightMm, 0),
    );
  });

  it("超长段落拆页时重复段落、建议和修改稿续标题", () => {
    const longText = "把具体的动作、声音和心理变化写清楚。".repeat(18);
    const pages = paginateDeliveryDocument(documentWith(paragraph(1, {
      crops: [
        { width: 600, height: 900 },
        { width: 600, height: 900 },
        { width: 600, height: 900 },
      ],
      suggestionCount: 4,
      suggestionText: longText,
      revisionText: longText.repeat(12),
    })), { measureText });

    expect(pages.length).toBeGreaterThan(2);
    for (const page of pages.slice(1)) {
      expect(page.blocks[0]).toMatchObject({
        kind: "paragraph-heading",
        paragraphNumber: 1,
        continued: true,
      });
    }
    expect(pages.some((page) => page.blocks.some((block) => (
      block.kind === "suggestion-heading" && block.continued
    )))).toBe(true);
    expect(pages.some((page) => page.blocks.some((block) => (
      block.kind === "revision-heading" && block.continued
    )))).toBe(true);
  });

  it("普通页剩余空白小于下一个本可整体放下的段落", () => {
    const pages = paginateDeliveryDocument(documentWith(
      paragraph(1, { crops: [{ width: 1000, height: 520 }] }),
      paragraph(2, { crops: [{ width: 1000, height: 520 }] }),
      paragraph(3, { crops: [{ width: 1000, height: 520 }] }),
    ), { measureText });

    expect(pages.length).toBeGreaterThan(1);
    for (let index = 0; index < pages.length - 1; index += 1) {
      const nextPage = pages[index + 1];
      const nextUnitHeight = nextPage.blocks.reduce((sum, block) => sum + block.heightMm, 0);
      expect(pages[index].remainingHeightMm).toBeLessThan(nextUnitHeight);
    }
  });
});
