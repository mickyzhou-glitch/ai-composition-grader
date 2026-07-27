import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ReviewRecord } from "@/src/db/review-repository";
import { PrintReview } from "./PrintReview";

const review: ReviewRecord = {
  id: "review-1",
  ownerId: "local-admin",
  status: "ready_for_review",
  studentName: "",
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
  it("将优点与需要修改内容分成两页，再输出逐页三栏学习页", () => {
    const structuredReview: ReviewRecord = {
      ...review,
      report: {
        ...review.report!,
        personalizedComment: [
          "选材真实贴近自己的生活",
          "礼物线索贯穿全文始终",
          "人物动作描写具体生动",
          "结尾感受能够回扣题目",
        ].join("\n"),
        painPoints: [
          "开头加入对比突出礼物珍贵",
          "第三段补充人物心理变化",
          "段落之间增加自然过渡句",
          "结尾写清这份礼物的意义",
        ],
      },
    };
    const { container } = render(<PrintReview review={structuredReview} imageSources={["data:image/jpeg;base64,one", "data:image/jpeg;base64,two"]} />);

    expect(container.firstElementChild).toHaveAttribute("data-print-ready", "true");
    expect(
      Array.from(container.querySelectorAll("[data-print-section]")).map(
        (node) => node.getAttribute("data-print-section"),
      ),
    ).toEqual(["strengths", "improvements", "feedback-page-1", "feedback-page-2"]);
    expect(container.querySelectorAll('[data-page-kind="feedback"]')).toHaveLength(2);
    expect(container.querySelector('[data-print-section="strengths"]')).toHaveTextContent("优点");
    expect(container.querySelector('[data-print-section="strengths"]')).toHaveTextContent("一、选材真实贴近自己的生活");
    expect(container.querySelector('[data-print-section="strengths"]')).toHaveTextContent("四、结尾感受能够回扣题目");
    expect(container.querySelector('[data-print-section="improvements"]')).toHaveTextContent("需要修改");
    expect(container.querySelector('[data-print-section="improvements"]')).toHaveTextContent("一、开头加入对比突出礼物珍贵");
    expect(container.querySelector('[data-print-section="improvements"]')).toHaveTextContent("四、结尾写清这份礼物的意义");
    expect(container.querySelector('[data-print-section="feedback-page-2"]')).toHaveAttribute("data-print-final", "true");
    expect(container.querySelector("footer")).toBeNull();
    expect(screen.getByText("优点")).toBeInTheDocument();
    expect(screen.queryByText(/总体评价/)).not.toBeInTheDocument();
    expect(screen.queryByText("35")).not.toBeInTheDocument();
    expect(screen.queryByText("逐页红批")).not.toBeInTheDocument();
    expect(screen.queryByText("分项明细")).not.toBeInTheDocument();
  });

  it("原文不绘制红圈或下划线，左侧给建议，右侧给彩色范文", () => {
    const { container } = render(<PrintReview review={review} imageSources={["data:image/jpeg;base64,one", "data:image/jpeg;base64,two"]} />);
    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute("src", "data:image/jpeg;base64,one");
    expect(images[1]).toHaveAttribute("src", "data:image/jpeg;base64,two");
    expect(container.querySelector("[data-issue-underline]")).toBeNull();
    expect(container.querySelector("[data-issue-circle]")).toBeNull();
    expect(screen.getByLabelText("第 1 页考场范文")).toHaveTextContent("第 1 段示范正文");
    expect(screen.getByLabelText("第 2 页考场范文")).toHaveTextContent("第 5 段示范正文");
    expect(screen.getByLabelText("第 1 页段落修改建议")).toHaveTextContent("第 1 段红色修改建议");
  });

  it("总体评价文字过多时切换超紧凑字号并保持独立单页", () => {
    const longReview: ReviewRecord = {
      ...review,
      report: {
        ...review.report!,
        themeReason: "围绕成长经历展开。".repeat(100),
        personalizedComment: "细节真实，情感自然。".repeat(100),
        painPoints: ["转折略快。".repeat(200)],
      },
    };

    const { container } = render(
      <PrintReview
        review={longReview}
        imageSources={["data:image/jpeg;base64,one", "data:image/jpeg;base64,two"]}
      />,
    );

    const summaries = container.querySelectorAll('[data-page-kind="summary"]');
    expect(summaries).toHaveLength(2);
    summaries.forEach((summary) => {
      expect(summary).toHaveAttribute("data-summary-density", "dense");
      expect(summary.className).toContain("summaryDense");
    });
  });

  it("按实际条数编号且支持超过四条", () => {
    const variableReview: ReviewRecord = {
      ...review,
      report: {
        ...review.report!,
        personalizedComment: [
          "选材真实贴近自己的生活",
          "礼物线索贯穿全文始终",
        ].join("\n"),
        painPoints: [
          "开头加入对比突出礼物珍贵",
          "第三段补充人物心理变化",
          "段落之间增加自然过渡句",
          "结尾写清这份礼物的意义",
          "删去与中心无关的软件介绍",
        ],
      },
    };

    const { container } = render(
      <PrintReview
        review={variableReview}
        imageSources={["data:image/jpeg;base64,one", "data:image/jpeg;base64,two"]}
      />,
    );

    expect(container.querySelector('[data-print-section="strengths"]')).toHaveTextContent(
      "二、礼物线索贯穿全文始终",
    );
    expect(container.querySelector('[data-print-section="strengths"]')).not.toHaveTextContent("三、");
    expect(container.querySelector('[data-print-section="improvements"]')).toHaveTextContent(
      "五、删去与中心无关的软件介绍",
    );
  });

  it("将个性化评语中明确的改进段落移到需要修改页", () => {
    const mixedReview: ReviewRecord = {
      ...review,
      report: {
        ...review.report!,
        personalizedComment: "你把礼物和成长经历联系起来，原因写得很充实。现在最需要调整的是段落安排：把内容分成五段，并补一句自然的过渡。",
      },
    };

    const { container } = render(
      <PrintReview
        review={mixedReview}
        imageSources={["data:image/jpeg;base64,one", "data:image/jpeg;base64,two"]}
      />,
    );

    expect(container.querySelector('[data-print-section="strengths"]')).toHaveTextContent("原因写得很充实");
    expect(container.querySelector('[data-print-section="strengths"]')).not.toHaveTextContent("段落安排");
    expect(container.querySelector('[data-print-section="improvements"]')).toHaveTextContent("段落安排");
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
