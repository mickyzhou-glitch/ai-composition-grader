import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReviewExportList } from "./ReviewExportList";

const report = {
  version: 2,
  themeFit: "fits",
  themeReason: "切题。",
  personalizedComment: "真实。",
  painPoints: [],
  commonIssues: [],
  revisionSuggestions: [],
  grade: "B+",
  diagnostics: {
    authenticityAndRelevance: { finding: "时间顺序可信。", action: "保留真实细节。" },
    materialAndDetails: { finding: "细节具体。", action: "保留动作。" },
    structure: { finding: "转折略突然。", action: "补充因果过渡。" },
    language: { finding: "语言通顺。", action: "精简长句。" },
  },
  paragraphReviews: [{
    paragraphId: "paragraph-1",
    suggestions: [{ problem: "转折略突然", advice: "补充过渡", example: "于是，我继续努力。" }],
    revisedText: "我继续努力。",
  }],
  parentFeedbacks: [],
};

describe("ReviewExportList", () => {
  it("shows reviewed article metadata and both logic comments", () => {
    render(<ReviewExportList reviews={[{
      id: "review-1",
      studentName: "张小明",
      config: { title: "为自己鼓掌" },
      report,
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
      reportStale: false,
      ocr: {
        version: 2,
        ocrRevision: 0,
        editedAt: null,
        pages: [{ pageIndex: 0, text: "我努力。", readable: true, warnings: [] }],
        paragraphs: [{
          id: "paragraph-1", paragraphIndex: 0, text: "我努力。",
          segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.2 }],
        }],
      },
      images: [{ id: 1, position: 0, width: 1000, height: 1500 }],
    } as never]} selectedIds={new Set(["review-1"])} onToggle={vi.fn()} onReturnToReview={vi.fn()} />);

    expect(screen.getByText("张小明")).toBeInTheDocument();
    expect(screen.getByText("B+")).toBeInTheDocument();
    expect(screen.getByText(/时间顺序可信/)).toBeInTheDocument();
    expect(screen.getByText(/补充因果过渡/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "选择张小明的作文导出" })).toBeChecked();
  });

  it("disables legacy reports with the precise upgrade reason", () => {
    const legacyReport = {
      themeFit: "fits", themeReason: "切题", personalizedComment: "真实",
      painPoints: [], commonIssues: [], revisionSuggestions: [], parentFeedbacks: [],
      scores: { themeIntent: 8, contentSelection: 8, structure: 8, languageExpression: 8, writingConventions: 4, total: 36, level: "优秀作文" },
      sampleParagraphs: [{ title: "示范段", text: "示范正文", suggestion: "修改建议" }],
    };
    render(<ReviewExportList reviews={[{
      id: "legacy-1", studentName: "旧同学", config: { title: "旧作文" },
      report: legacyReport, teacherReviewedAt: "2026-08-22T06:00:00.000Z",
      reportStale: false, ocr: null, images: [],
    } as never]} selectedIds={new Set()} onToggle={vi.fn()} onReturnToReview={vi.fn()} />);

    expect(screen.getByRole("checkbox", { name: "选择旧同学的作文导出" })).toBeDisabled();
    expect(screen.getByText("旧版示范段落报告需要完整重新分析后才能导出新格式")).toBeVisible();
  });
});
