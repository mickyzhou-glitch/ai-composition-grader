import { describe, expect, it } from "vitest";

import { deliveryReadiness } from "./readiness";

const paragraphReport = {
  version: 2,
  themeFit: "fits",
  themeReason: "紧扣主题。",
  personalizedComment: "内容真实。",
  painPoints: [],
  commonIssues: [],
  revisionSuggestions: [],
  grade: "A",
  diagnostics: {
    authenticityAndRelevance: { finding: "真实。", action: "保留。" },
    materialAndDetails: { finding: "具体。", action: "保留。" },
    structure: { finding: "完整。", action: "保留。" },
    language: { finding: "通顺。", action: "保留。" },
  },
  paragraphReviews: [{
    paragraphId: "paragraph-1",
    suggestions: [{ problem: "保留", advice: "保留原文", example: "原文自然。" }],
    revisedText: "第一段修改稿。",
  }],
  parentFeedbacks: [],
};

const legacyReport = {
  ...paragraphReport,
  version: undefined,
  paragraphReviews: undefined,
  sampleParagraphs: [{ title: "示范", text: "示范段落。", suggestion: "补充细节。" }],
};

const ocrV2 = {
  version: 2,
  ocrRevision: 4,
  editedAt: "2026-08-27T08:00:00.000Z",
  pages: [{ pageIndex: 0, text: "第一段原文。", readable: true, warnings: [] }],
  paragraphs: [{
    id: "paragraph-1",
    paragraphIndex: 0,
    text: "第一段原文。",
    segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.3 }],
  }],
};

const completeReview = {
  report: paragraphReport,
  teacherReviewedAt: "2026-08-27T09:00:00.000Z",
  reportStale: false,
  ocr: ocrV2,
  images: [{ id: 11, position: 0, width: 1000, height: 1500 }],
  hasPdf: false,
};

describe("deliveryReadiness", () => {
  it("accepts only a complete reviewed paragraph delivery", () => {
    expect(deliveryReadiness(completeReview)).toEqual({ ready: true });
  });

  it("returns stable reasons for review, OCR, freshness, and legacy failures", () => {
    expect(deliveryReadiness({ ...completeReview, report: null })).toMatchObject({
      ready: false,
      code: "REPORT_MISSING",
    });
    expect(deliveryReadiness({ ...completeReview, teacherReviewedAt: null })).toMatchObject({
      ready: false,
      code: "TEACHER_REVIEW_REQUIRED",
    });
    expect(deliveryReadiness({
      ...completeReview,
      reportStale: true,
      ocr: { ...ocrV2, version: 1 },
    })).toMatchObject({
      ready: false,
      code: "OCR_V2_REQUIRED",
    });
    expect(deliveryReadiness({ ...completeReview, reportStale: true })).toMatchObject({
      ready: false,
      code: "REPORT_STALE",
    });
    expect(deliveryReadiness({ ...completeReview, report: legacyReport, hasPdf: true })).toEqual({
      ready: false,
      code: "LEGACY_REPORT",
      message: "旧版示范段落报告需要完整重新分析后才能导出新格式",
    });
  });

  it("rejects paragraph coverage and malformed paragraph reports", () => {
    expect(deliveryReadiness({
      ...completeReview,
      report: {
        ...paragraphReport,
        paragraphReviews: [{ ...paragraphReport.paragraphReviews[0], paragraphId: "paragraph-2" }],
      },
    })).toMatchObject({ ready: false, code: "PARAGRAPH_COVERAGE_MISMATCH" });
    expect(deliveryReadiness({
      ...completeReview,
      report: {
        ...paragraphReport,
        paragraphReviews: [{ ...paragraphReport.paragraphReviews[0], suggestions: [{}] }],
      },
    })).toMatchObject({ ready: false, code: "REPORT_INVALID" });
    expect(deliveryReadiness({
      ...completeReview,
      report: {
        ...paragraphReport,
        paragraphReviews: [{ ...paragraphReport.paragraphReviews[0], revisedText: "  " }],
      },
    })).toMatchObject({ ready: false, code: "REPORT_INVALID" });
  });

  it("rejects missing, invalid, and unmapped crop regions", () => {
    const paragraph = ocrV2.paragraphs[0];
    expect(deliveryReadiness({
      ...completeReview,
      ocr: { ...ocrV2, paragraphs: [{ ...paragraph, segments: [] }] },
    })).toMatchObject({ ready: false, code: "CROP_MISSING" });
    expect(deliveryReadiness({
      ...completeReview,
      ocr: {
        ...ocrV2,
        paragraphs: [{
          ...paragraph,
          segments: [{ ...paragraph.segments[0], x: 0.8, width: 0.3 }],
        }],
      },
    })).toMatchObject({ ready: false, code: "CROP_OUT_OF_BOUNDS" });
    expect(deliveryReadiness({
      ...completeReview,
      ocr: {
        ...ocrV2,
        pages: [...ocrV2.pages, { ...ocrV2.pages[0], pageIndex: 1 }],
        paragraphs: [{
          ...paragraph,
          segments: [{ ...paragraph.segments[0], pageIndex: 1 }],
        }],
      },
    })).toMatchObject({ ready: false, code: "IMAGE_PAGE_MISSING" });
  });
});
