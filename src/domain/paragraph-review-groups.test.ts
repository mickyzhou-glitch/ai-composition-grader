import { describe, expect, it } from "vitest";

import {
  paragraphReviewCoverageMessage,
  resolveReviewGroups,
  sourceParagraphLabel,
} from "./paragraph-review-groups";

const paragraphs = ["甲句。", "乙句。", "丙句。", "丁句。"].map((text, index) => ({
  id: `paragraph-${index + 1}`,
  paragraphIndex: index,
  text,
  segments: [{ pageIndex: index < 2 ? 0 : 1 }],
}));

describe("paragraph review groups", () => {
  it("旧报告没有原文范围时仍要求与自然段一一对应", () => {
    const reviews = paragraphs.map((paragraph) => ({ paragraphId: paragraph.id }));
    expect(paragraphReviewCoverageMessage(reviews, paragraphs.map(({ id }) => id))).toBeNull();
    expect(paragraphReviewCoverageMessage(reviews.slice(0, 2), paragraphs.map(({ id }) => id)))
      .toMatch(/exactly match/u);
  });

  it("结构段把连续原文归成一组，并标出起止段", () => {
    const reviews = [
      { paragraphId: "paragraph-1", sourceParagraphStart: 1, sourceParagraphEnd: 2 },
      { paragraphId: "paragraph-3", sourceParagraphStart: 3, sourceParagraphEnd: 3 },
      { paragraphId: "paragraph-4", sourceParagraphStart: 4, sourceParagraphEnd: 4 },
    ];
    expect(paragraphReviewCoverageMessage(reviews, paragraphs.map(({ id }) => id))).toBeNull();
    expect(sourceParagraphLabel(1, 2)).toBe("对应原文第 1–2 段");
    const groups = resolveReviewGroups(reviews.map((review) => ({
      ...review,
      suggestions: [{ advice: "合并改写" }],
      revisedText: "改后。",
    })), paragraphs);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({
      sourceText: "甲句。乙句。",
      sourceLabel: "对应原文第 1–2 段",
      pageIndex: 0,
    });
    expect(groups[1]?.pageIndex).toBe(1);
  });

  it("漏段、重叠或只写一端时不能通过", () => {
    const ids = paragraphs.map(({ id }) => id);
    expect(paragraphReviewCoverageMessage([
      { paragraphId: "paragraph-1", sourceParagraphStart: 1, sourceParagraphEnd: 1 },
      { paragraphId: "paragraph-3", sourceParagraphStart: 3, sourceParagraphEnd: 4 },
    ], ids)).toMatch(/cover original/u);
    expect(paragraphReviewCoverageMessage([
      { paragraphId: "paragraph-1", sourceParagraphStart: 1 },
    ], ids)).toMatch(/cover original/u);
  });
});
