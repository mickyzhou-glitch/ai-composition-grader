import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OcrTextEditor } from "./OcrTextEditor";

function json(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ ok: true, data }), {
    headers: { "content-type": "application/json" },
  }));
}

describe("OcrTextEditor", () => {
  afterEach(() => vi.restoreAllMocks());

  it("逐段编辑识别原文并按期望 OCR 版本保存", async () => {
    const savedReview = { id: "review-1", ocr: { ocrRevision: 3, pages: [] }, reportStale: true };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => json(savedReview));
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<OcrTextEditor
      reviewId="review-1"
      ocr={{
        version: 2,
        ocrRevision: 2,
        editedAt: null,
        pages: [
          { pageIndex: 0, text: "第一页原文", readable: true, warnings: [] },
          { pageIndex: 1, text: "第二页原文", readable: true, warnings: [] },
        ],
        paragraphs: [
          {
            id: "paragraph-1",
            paragraphIndex: 0,
            text: "第一段原文",
            segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.08 }],
          },
          {
            id: "paragraph-2",
            paragraphIndex: 1,
            text: "第二段原文",
            segments: [{ pageIndex: 1, x: 0.1, y: 0.2, width: 0.5, height: 0.08 }],
          },
        ],
      }}
      disabled={false}
      onSaved={onSaved}
    />);

    const firstParagraph = screen.getByRole("textbox", { name: "第 1 段识别原文" });
    await user.clear(firstParagraph);
    await user.type(firstParagraph, "老师修正后的第一段");
    await user.click(screen.getByRole("button", { name: "保存识别原文" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/reviews/review-1/ocr");
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      expectedOcrRevision: 2,
      paragraphs: [
        { paragraphId: "paragraph-1", text: "老师修正后的第一段" },
        { paragraphId: "paragraph-2", text: "第二段原文" },
      ],
    });
    expect(onSaved).toHaveBeenCalledWith(savedReview);
  });

  it("保存失败时保留教师尚未提交的文本", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      error: { code: "OCR_REVISION_CONFLICT", message: "识别原文已被更新" },
    }), { status: 409, headers: { "content-type": "application/json" } }));
    const user = userEvent.setup();
    render(<OcrTextEditor
      reviewId="review-1"
      ocr={{
        version: 2,
        ocrRevision: 1,
        editedAt: null,
        pages: [{ pageIndex: 0, text: "原文", readable: true, warnings: [] }],
        paragraphs: [{
          id: "paragraph-1",
          paragraphIndex: 0,
          text: "原文",
          segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.08 }],
        }],
      }}
      disabled={false}
      onSaved={vi.fn()}
    />);

    const editor = screen.getByRole("textbox", { name: "第 1 段识别原文" });
    await user.clear(editor);
    await user.type(editor, "尚未保存的修正");
    await user.click(screen.getByRole("button", { name: "保存识别原文" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("识别原文已被更新");
    expect(editor).toHaveValue("尚未保存的修正");
  });

  it("v1 检查点只读展示且不伪装成自然段编辑", () => {
    render(<OcrTextEditor
      reviewId="review-1"
      ocr={{
        version: 1,
        ocrRevision: 0,
        editedAt: null,
        pages: [{ pageIndex: 0, text: "旧版逐页原文", readable: true, warnings: [] }],
      }}
      disabled={false}
      onSaved={vi.fn()}
    />);

    expect(screen.getByText("旧版逐页原文")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存识别原文" })).not.toBeInTheDocument();
  });
});
