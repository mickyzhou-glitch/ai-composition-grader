import { describe, expect, it } from "vitest";

import { assessOcrProofreading, OCR_PLACEHOLDER_RATIO_THRESHOLD } from "./ocr-quality";

const page = (overrides: Partial<{ pageIndex: number; text: string; readable: boolean; warnings: string[] }> = {}) => ({
  pageIndex: 0, text: "", readable: true, warnings: [], ...overrides,
});

describe("识别原文校对提示判定", () => {
  it("无警告、占位符低于阈值时不提示", () => {
    const text = `${"我".repeat(99)}□`;
    expect(assessOcrProofreading({ pages: [page({ text })], paragraphs: [{ text }] })).toEqual({
      needsProofread: false, reasons: [], placeholderCount: 1, placeholderRatio: 0.01,
    });
    expect(assessOcrProofreading(null).needsProofread).toBe(false);
  });

  it("占位符占比达到阈值时提示并说明比例", () => {
    expect(OCR_PLACEHOLDER_RATIO_THRESHOLD).toBe(0.03);
    const text = `${"我".repeat(97)}□□□`;
    const result = assessOcrProofreading({ pages: [page({ text })], paragraphs: [{ text: "我".repeat(47) + "□" }, { text: `${"他".repeat(50)}□□` }] });
    expect(result.needsProofread).toBe(true);
    expect(result.placeholderCount).toBe(3);
    expect(result.reasons).toEqual(["看不清的字（「□」）共 3 个，占正文 3%，超过 3%"]);
  });

  it("没有自然段时按页正文计算，空白不计入分母", () => {
    const result = assessOcrProofreading({ pages: [page({ text: "我 □\n\n他" })] });
    expect(result.placeholderRatio).toBeCloseTo(1 / 3);
    expect(result.needsProofread).toBe(true);
  });

  it("模型 warnings 或任一页 readable=false 时提示，并列出原因", () => {
    const result = assessOcrProofreading({
      pages: [
        page({ text: "正文", warnings: ["第三行字迹模糊"] }),
        page({ pageIndex: 1, text: "正文", readable: false, warnings: [] }),
      ],
      paragraphs: [{ text: "正文正文" }],
    });
    expect(result.needsProofread).toBe(true);
    expect(result.reasons).toEqual(["模型警告：第 2 页无法完整辨认", "模型警告：第 1 页：第三行字迹模糊"]);
  });
});
