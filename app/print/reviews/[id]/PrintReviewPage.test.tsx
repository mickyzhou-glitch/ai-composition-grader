import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PrintReviewPage } from "./PrintReviewPage";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  buildDeliveryDocument: vi.fn(),
}));

vi.mock("@/app/lib/api", () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
  errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
}));

vi.mock("@/app/lib/delivery-document", () => ({
  buildDeliveryDocument: (...args: unknown[]) => mocks.buildDeliveryDocument(...args),
}));

const review = {
  id: "review-1",
  status: "ready_for_review",
  studentName: "小明",
  config: { title: "为自己鼓掌", templateType: "custom" },
  report: { version: 2, paragraphReviews: [{ paragraphId: "paragraph-1" }] },
  revision: 1,
  teacherReviewedAt: "2026-08-22T06:00:00.000Z",
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
  images: [{ id: 7, position: 0, originalName: "essay.jpg", mimeType: "image/jpeg", width: 100, height: 100, rotation: 0, crop: null }],
  annotations: [],
  ocr: { version: 2, ocrRevision: 1, editedAt: null, pages: [], paragraphs: [] },
  reportStale: false,
  hasPdf: false,
  pdfFilename: null,
};

const delivery = {
  title: "为自己鼓掌",
  studentName: "小明",
  paragraphs: [{
    paragraphNumber: 1,
    crops: [{ pageIndex: 0, bytes: new Uint8Array([1, 2, 3]), width: 1200, height: 260 }],
    suggestions: [{ problem: "保留", advice: "保留原句", example: "原句" }],
    revisionRuns: [{ kind: "unchanged", text: "原句" }],
  }],
};

describe("PrintReviewPage", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.buildDeliveryDocument.mockReset();
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  it("构建共享交付模型并在裁图解码后标记打印就绪", async () => {
    let finishDecode!: () => void;
    const decode = new Promise<void>((resolve) => { finishDecode = resolve; });
    const createObjectURL = vi.fn(() => "blob:crop-1");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    vi.stubGlobal("Image", class {
      src = "";
      decode = vi.fn(() => decode);
    });
    mocks.apiFetch.mockResolvedValue(review);
    mocks.buildDeliveryDocument.mockResolvedValue(delivery);

    const { container, unmount } = render(<PrintReviewPage reviewId="review-1" />);

    await waitFor(() => expect(mocks.buildDeliveryDocument).toHaveBeenCalledWith(review));
    expect(container.querySelector('[data-print-ready="true"]')).toBeNull();
    finishDecode();

    expect(await screen.findByRole("heading", { name: "为自己鼓掌" })).toBeVisible();
    expect(container.querySelector('[data-print-ready="true"]')).not.toBeNull();
    expect(screen.getByRole("img", { name: "第 1 段原文裁图，第 1 页" }))
      .toHaveAttribute("src", "blob:crop-1");
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:crop-1");
  });
});
