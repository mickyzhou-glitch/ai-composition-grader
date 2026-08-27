import { describe, expect, it, vi } from "vitest";

import { buildRevisionRuns } from "@/src/revisions/revision-diff";
import { DELIVERY_STYLE } from "@/src/delivery/contracts";
import { buildDeliveryDocument, DeliveryBuildError } from "./delivery-document";

const report = {
  version: 2 as const,
  themeFit: "fits" as const,
  themeReason: "切题。",
  personalizedComment: "真诚。",
  painPoints: [], commonIssues: [], revisionSuggestions: [],
  grade: "A" as const,
  diagnostics: {
    authenticityAndRelevance: { finding: "真实。", action: "保留。" },
    materialAndDetails: { finding: "具体。", action: "保留。" },
    structure: { finding: "完整。", action: "保留。" },
    language: { finding: "通顺。", action: "保留。" },
  },
  paragraphReviews: [
    {
      paragraphId: "paragraph-1",
      suggestions: [{ problem: "略短", advice: "补充", example: "补充动作。" }],
      revisedText: "第一段修改稿。",
    },
    {
      paragraphId: "paragraph-2",
      suggestions: [{ problem: "保留", advice: "保留原文", example: "自然。" }],
      revisedText: "第二段原文。",
    },
  ],
  parentFeedbacks: [],
};

const review = {
  id: "review-1",
  studentName: "小明",
  config: { title: "我的一天" },
  report,
  teacherReviewedAt: "2026-08-27T09:00:00.000Z",
  reportStale: false,
  images: [
    { id: 11, position: 0, width: 1000, height: 1500 },
    { id: 12, position: 1, width: 1000, height: 1500 },
  ],
  ocr: {
    version: 2 as const,
    ocrRevision: 2,
    editedAt: "2026-08-27T08:00:00.000Z",
    pages: [
      { pageIndex: 0, text: "第一页", readable: true, warnings: [] },
      { pageIndex: 1, text: "第二页", readable: true, warnings: [] },
    ],
    paragraphs: [
      {
        id: "paragraph-1", paragraphIndex: 0, text: "第一段原文。",
        segments: [
          { pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.2 },
          { pageIndex: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.2 },
        ],
      },
      {
        id: "paragraph-2", paragraphIndex: 1, text: "第二段原文。",
        segments: [{ pageIndex: 0, x: 0.1, y: 0.6, width: 0.5, height: 0.2 }],
      },
    ],
  },
};

function dependencies(failPage?: number) {
  const close = [vi.fn(), vi.fn()];
  const fetchImage = vi.fn(async (url: string) => new Blob([url]));
  const createObjectURL = vi.fn((blob: Blob) => `blob:${blob.size}:${createObjectURL.mock.calls.length}`);
  const revokeObjectURL = vi.fn();
  const decodeBitmap = vi.fn(async (_blob: Blob, objectUrl: string) => {
    const pageIndex = objectUrl.endsWith(":1") ? 0 : 1;
    return { width: 1000, height: 1500, close: close[pageIndex], pageIndex };
  });
  const cropImage = vi.fn(async (bitmap: { width: number; height: number; pageIndex?: number }) => {
    if (bitmap.pageIndex === failPage) throw new Error("canvas failed");
    return { bytes: new Uint8Array([(bitmap.pageIndex ?? 0) + 1]), width: 520, height: 330 };
  });
  return { fetchImage, createObjectURL, revokeObjectURL, decodeBitmap, cropImage, close };
}

describe("buildDeliveryDocument", () => {
  it("shares the fixed A4 delivery style", () => {
    expect(DELIVERY_STYLE).toEqual({
      page: { widthMm: 210, heightMm: 297, marginXmm: 18, marginYmm: 16 },
      colors: { text: "171717", change: "C91F32", suggestion: "FFF0BD" },
      fontPt: { title: 16, section: 11, suggestion: 10.5, revision: 11.5 },
    });
  });

  it("builds ordered paragraphs and loads each ai image once", async () => {
    const deps = dependencies();
    const document = await buildDeliveryDocument(review, deps);

    expect(document).toMatchObject({ title: "我的一天", studentName: "小明" });
    expect(document.paragraphs.map(({ paragraphNumber }) => paragraphNumber)).toEqual([1, 2]);
    expect(document.paragraphs[0]).toMatchObject({
      paragraphNumber: 1,
      crops: [{ pageIndex: 0 }, { pageIndex: 1 }],
      suggestions: report.paragraphReviews[0].suggestions,
      revisionRuns: buildRevisionRuns("第一段原文。", "第一段修改稿。"),
    });
    expect(deps.fetchImage).toHaveBeenCalledTimes(2);
    expect(deps.fetchImage).toHaveBeenCalledWith("/api/reviews/review-1/files?imageId=11&variant=ai");
    expect(deps.cropImage).toHaveBeenCalledTimes(3);
    expect(deps.close.every((close) => close.mock.calls.length === 1)).toBe(true);
    expect(deps.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("fails atomically with paragraph/page context and always releases resources", async () => {
    const deps = dependencies(1);

    await expect(buildDeliveryDocument(review, deps)).rejects.toEqual(new DeliveryBuildError(
      "CROP_FAILED",
      "第 1 段第 2 页裁图失败",
    ));
    expect(deps.close.every((close) => close.mock.calls.length === 1)).toBe(true);
    expect(deps.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
});
