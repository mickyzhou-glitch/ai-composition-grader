import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PrintReviewPage } from "./PrintReviewPage";

const mockApiFetch = vi.fn();

vi.mock("@/app/lib/api", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const review = {
  id: "review-1",
  status: "ready_for_review",
  studentName: "小明",
  config: { title: "为自己鼓掌", templateType: "custom" },
  report: {
    grade: "A",
    scores: { themeIntent: 8, contentSelection: 8, structure: 7, languageExpression: 7, writingConventions: 3, total: 33, level: "二类作文" },
    personalizedComment: "表达清晰。现在最需要改进的是细节描写。",
    painPoints: [],
    sampleParagraphs: [],
  },
  revision: 1,
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
  images: [{ id: 7, position: 0, originalName: "essay.jpg", mimeType: "image/jpeg", width: 100, height: 100, rotation: 0, crop: null }],
  annotations: [],
  hasPdf: false,
  pdfFilename: null,
};

describe("PrintReviewPage", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("loads the review and original images through the API", async () => {
    mockApiFetch.mockResolvedValue(review);

    render(<PrintReviewPage reviewId="review-1" />);

    await waitFor(() => expect(mockApiFetch).toHaveBeenCalledWith("/api/reviews/review-1"));
    expect(await screen.findByText("优点")).toBeVisible();
    expect(screen.getByAltText("第 1 页原作文")).toHaveAttribute(
      "src",
      "/api/reviews/review-1/files?imageId=7&variant=original",
    );
  });
});
