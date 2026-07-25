import { render, screen } from "@testing-library/react";
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
    { pageIndex: 1, x: 0.4, y: 0.2, category: "structure", anchorText: "第三处", comment: "第三条", isHighlight: false },
    { pageIndex: 0, x: 0.2, y: 0.8, category: "structure", anchorText: "第二处", comment: "第二条", isHighlight: false },
    { pageIndex: 0, x: 0.3, y: 0.1, category: "typo", anchorText: "第一处", comment: "第一条", isHighlight: false },
  ],
};

describe("A4 打印稿", () => {
  it("只输出无标题的逐页三栏学习页", () => {
    const { container } = render(<PrintReview review={review} imageSources={["data:image/jpeg;base64,one", "data:image/jpeg;base64,two"]} />);

    expect(container.firstElementChild).toHaveAttribute("data-print-ready", "true");
    expect(
      Array.from(container.querySelectorAll("[data-print-section]")).map(
        (node) => node.getAttribute("data-print-section"),
      ),
    ).toEqual(["feedback-page-1", "feedback-page-2"]);
    expect(container.querySelectorAll('[data-page-kind="feedback"]')).toHaveLength(2);
    expect(container.querySelector("footer")).toBeNull();
    expect(screen.queryByText("作文批改报告")).not.toBeInTheDocument();
    expect(screen.queryByText("35")).not.toBeInTheDocument();
    expect(screen.queryByText("逐页红批")).not.toBeInTheDocument();
    expect(screen.queryByText("分项明细")).not.toBeInTheDocument();
    expect(screen.queryByText("细节真实，情感自然。")).not.toBeInTheDocument();
  });

  it("中间只标结构问题，左侧给建议，右侧给彩色范文", () => {
    const { container } = render(<PrintReview review={review} imageSources={["data:image/jpeg;base64,one", "data:image/jpeg;base64,two"]} />);
    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute("src", "data:image/jpeg;base64,one");
    expect(images[1]).toHaveAttribute("src", "data:image/jpeg;base64,two");
    expect(container.querySelectorAll("[data-issue-underline]")).toHaveLength(2);
    expect(Array.from(container.querySelectorAll("[data-annotation-number]")).map((node) => node.getAttribute("data-annotation-number"))).toEqual(["1", "2"]);
    expect(screen.getByLabelText("第 1 页考场范文")).toHaveTextContent("第 1 段示范正文");
    expect(screen.getByLabelText("第 2 页考场范文")).toHaveTextContent("第 5 段示范正文");
    expect(screen.getByLabelText("第 1 页段落修改建议")).toHaveTextContent("第 1 段红色修改建议");
  });

  it("完整示范文分配在左侧栏，修改建议只在原文右侧呈现", () => {
    render(<PrintReview review={review} imageSources={["data:image/jpeg;base64,one", "data:image/jpeg;base64,two"]} />);

    const paragraphs = screen.getAllByTestId("sample-paragraph");
    expect(paragraphs).toHaveLength(5);
    paragraphs.forEach((paragraph, index) => {
      expect(paragraph).toHaveTextContent(`第 ${index + 1} 段`);
      expect(paragraph).toHaveTextContent(`第 ${index + 1} 段示范正文`);
      expect(paragraph).not.toHaveTextContent(`第 ${index + 1} 段红色修改建议`);
    });
  });
});
