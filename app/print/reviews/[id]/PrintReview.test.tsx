import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ReviewRecord } from "@/src/db/review-repository";
import { PrintReview } from "./PrintReview";

const review: ReviewRecord = {
  id: "review-1",
  ownerId: "local-admin",
  status: "ready_for_review",
  revision: 4,
  analysisRunId: null,
  pdfFilename: null,
  pdfPath: null,
  pdfRevision: null,
  exportedAt: null,
  config: {
    title: "为自己鼓掌",
    grade: "上海五四学制六年级",
    writingRequirements: "写一件亲身经历的事。",
    targetCharacters: 600,
    structureRequirements: "开头点题，结尾升华。",
    scoringFocus: "细节描写。",
    templateType: "preset_self_applause",
  },
  report: {
    themeFit: "fits",
    themeReason: "围绕成长经历展开。",
    personalizedComment: "细节真实，情感自然。",
    painPoints: ["转折略快"],
    commonIssues: ["长句较多"],
    revisionSuggestions: ["补充动作与心理变化"],
    scores: {
      themeIntent: 9,
      contentSelection: 8,
      structure: 7,
      languageExpression: 7,
      writingConventions: 4,
      total: 35,
      level: "优秀作文",
    },
    sampleParagraphs: Array.from({ length: 5 }, (_, index) => ({
      title: `第 ${index + 1} 段`,
      text: `第 ${index + 1} 段示范正文`,
      suggestion: `第 ${index + 1} 段红色修改建议`,
    })),
  },
  createdAt: new Date("2026-07-20T08:00:00.000Z"),
  updatedAt: new Date("2026-07-20T09:00:00.000Z"),
  images: [
    {
      id: 10,
      reviewId: "review-1",
      position: 0,
      originalName: "第一页.jpg",
      mimeType: "image/jpeg",
      originalPath: "images/private-original-1.jpg",
      annotationPath: "images/private-annotation-1.jpg",
      aiPath: "images/private-ai-1.jpg",
      width: 1200,
      height: 1600,
      rotation: 0,
      crop: null,
      createdAt: new Date("2026-07-20T08:00:00.000Z"),
    },
    {
      id: 11,
      reviewId: "review-1",
      position: 1,
      originalName: "第二页.jpg",
      mimeType: "image/jpeg",
      originalPath: "images/private-original-2.jpg",
      annotationPath: "images/private-annotation-2.jpg",
      aiPath: "images/private-ai-2.jpg",
      width: 1200,
      height: 1600,
      rotation: 0,
      crop: null,
      createdAt: new Date("2026-07-20T08:00:00.000Z"),
    },
  ],
  annotations: [
    { pageIndex: 1, x: 0.4, y: 0.2, category: "sentence", anchorText: "第三处", comment: "第三条", isHighlight: false },
    { pageIndex: 0, x: 0.2, y: 0.8, category: "expression", anchorText: "第二处", comment: "第二条", isHighlight: false },
    { pageIndex: 0, x: 0.3, y: 0.1, category: "typo", anchorText: "第一处", comment: "第一条", isHighlight: false },
  ],
};

describe("A4 打印稿", () => {
  it("学生版仅展示等级、总评、诊断与示范文，不展示朱批或分项分数", () => {
    const { container } = render(<PrintReview review={review} />);

    expect(container.firstElementChild).toHaveAttribute("data-print-ready", "true");
    expect(
      Array.from(container.querySelectorAll("[data-print-section]")).map(
        (node) => node.getAttribute("data-print-section"),
      ),
    ).toEqual([
      "summary",
      "theme",
      "pain-points",
      "common-issues",
      "suggestions",
      "sample-paragraphs",
    ]);
    expect(container.querySelectorAll('[data-page-kind="annotation"]')).toHaveLength(0);
    expect(container.querySelector("footer")).toBeNull();
    expect(screen.getByLabelText("作文等级")).toHaveTextContent("优秀作文");
    expect(screen.queryByText("35")).not.toBeInTheDocument();
    expect(screen.queryByText("逐页红批")).not.toBeInTheDocument();
    expect(screen.queryByText("分项明细")).not.toBeInTheDocument();
    expect(screen.getByText("细节真实，情感自然。")).toBeInTheDocument();
  });

  it("学生版不渲染作文图片、批注引线或批注正文", () => {
    const { container } = render(<PrintReview review={review} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelectorAll("[data-annotation-number]")).toHaveLength(0);
    expect(container.querySelectorAll("line[data-anchor-line]")).toHaveLength(0);
    expect(container.querySelectorAll("circle[data-anchor-point]")).toHaveLength(0);
    expect(screen.queryByText("第一条")).not.toBeInTheDocument();
  });

  it("每个结构化示范段落后紧跟修改建议", () => {
    render(<PrintReview review={review} />);

    const paragraphs = screen.getAllByTestId("sample-paragraph");
    expect(paragraphs).toHaveLength(5);
    paragraphs.forEach((paragraph, index) => {
      const scoped = within(paragraph);
      expect(scoped.getByRole("heading", { name: `第 ${index + 1} 段` })).toBeInTheDocument();
      const text = scoped.getByText(`第 ${index + 1} 段示范正文`);
      const suggestion = scoped.getByText(`第 ${index + 1} 段红色修改建议`);
      expect(text.compareDocumentPosition(suggestion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(suggestion).toHaveAttribute("data-suggestion", "true");
    });
  });
});
