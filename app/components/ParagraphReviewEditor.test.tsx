import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./ParagraphCropPreview", () => ({
  ParagraphCropPreview: ({ paragraphNumber }: { paragraphNumber: number }) => (
    <div data-testid={`crop-${paragraphNumber}`}>原文裁图 {paragraphNumber}</div>
  ),
}));

import { ParagraphReviewEditor } from "./ParagraphReviewEditor";

const ocr = {
  version: 2 as const,
  ocrRevision: 1,
  editedAt: null,
  pages: [{ pageIndex: 0, text: "原文", readable: true, warnings: [] }],
  paragraphs: [{
    id: "paragraph-1",
    paragraphIndex: 0,
    text: "我很高兴。",
    segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
  }],
};

const report = {
  version: 2 as const,
  themeFit: "fits" as const,
  themeReason: "切题",
  personalizedComment: "真实",
  painPoints: [],
  commonIssues: [],
  revisionSuggestions: [],
  grade: "A-" as const,
  diagnostics: {
    authenticityAndRelevance: { finding: "真实", action: "保留" },
    materialAndDetails: { finding: "细节少", action: "补动作" },
    structure: { finding: "完整", action: "保留" },
    language: { finding: "普通", action: "改具体" },
  },
  paragraphReviews: [{
    paragraphId: "paragraph-1",
    suggestions: [{ problem: "描写普通", advice: "补充程度", example: "我非常高兴。" }],
    revisedText: "我非常高兴！",
  }],
  parentFeedbacks: [] as [],
};

describe("ParagraphReviewEditor", () => {
  it("完整范文按目标五段展示并保存，与原文点评段数独立", () => {
    const rewrittenEssay = ["开篇。", "抑的铺垫。", "扬的事件详写。", "真相。", "结尾。"];
    const onChange = vi.fn();
    render(<ParagraphReviewEditor reviewId="review-1" report={{ ...report, rewrittenEssay }} ocr={ocr} images={[]} disabled={false} onChange={onChange} showCharacterCounts />);
    expect(screen.getByRole("heading", { name: "按要求重写的完整范文" })).toBeInTheDocument();
    expect(screen.getAllByLabelText(/完整范文第 \d 段/u)).toHaveLength(5);
    fireEvent.change(screen.getByLabelText("完整范文第 3 段"), { target: { value: "扬的事件补充细节。" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      rewrittenEssay: [rewrittenEssay[0], rewrittenEssay[1], "扬的事件补充细节。", rewrittenEssay[3], rewrittenEssay[4]],
      paragraphReviews: report.paragraphReviews,
    }));
  });

  it("每段严格按裁图、建议、修改稿顺序展示并即时更新整句标色预览", () => {
    const onChange = vi.fn();
    const { container } = render(<ParagraphReviewEditor
      reviewId="review-1"
      report={report}
      ocr={ocr}
      images={[{ id: 1, position: 0 }]}
      disabled={false}
      onChange={onChange}
    />);

    const paragraph = container.querySelector("[data-paragraph-id='paragraph-1']")!;
    const text = paragraph.textContent ?? "";
    expect(text.indexOf("第 1 段")).toBeLessThan(text.indexOf("原文裁图 1"));
    expect(text.indexOf("原文裁图 1")).toBeLessThan(text.indexOf("【修改建议】"));
    expect(text.indexOf("【修改建议】")).toBeLessThan(text.indexOf("【修改后段落】"));
    expect(screen.getByLabelText("第 1 段第 1 条问题描述")).toHaveValue("描写普通");
    expect(screen.getByLabelText("第 1 段第 1 条修改动作")).toHaveValue("补充程度");
    expect(screen.getByLabelText("第 1 段第 1 条修改示例")).toHaveValue("我非常高兴。");
    expect(paragraph.querySelector("del")).toBeNull();
    expect(screen.getByLabelText("示范文整句标色预览")).toHaveTextContent("我非常高兴！");
    expect(paragraph.querySelector(".revision-preview__changed-sentence")).toHaveStyle({ color: "#1F4E78" });

    fireEvent.change(screen.getByLabelText("第 1 段完整修改稿"), {
      target: { value: "我很高兴。" },
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      paragraphReviews: [expect.objectContaining({ revisedText: "我很高兴。" })],
    }));
  });

  it("建议保持 1 至 4 条并支持保留项保存", () => {
    const onChange = vi.fn();
    render(<ParagraphReviewEditor
      reviewId="review-1"
      report={{
        ...report,
        paragraphReviews: [{
          ...report.paragraphReviews[0],
          suggestions: [{ problem: "保留", advice: "保留真实感受", example: "我很高兴。" }],
        }],
      }}
      ocr={ocr}
      images={[{ id: 1, position: 0 }]}
      disabled={false}
      onChange={onChange}
    />);

    expect(screen.getByLabelText("第 1 段第 1 条问题描述")).toHaveValue("保留");
    expect(screen.getByRole("button", { name: "删除第 1 段第 1 条建议" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "新增第 1 段建议" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      paragraphReviews: [expect.objectContaining({ suggestions: expect.arrayContaining([
        expect.objectContaining({ problem: "保留" }),
        { problem: "", advice: "", example: "" },
      ]) })],
    }));
  });

  it("批量审核可以隐藏建议编辑，改示范文时仍保留原建议", () => {
    const onChange = vi.fn();
    render(<ParagraphReviewEditor
      reviewId="review-1"
      report={report}
      ocr={ocr}
      images={[]}
      disabled={false}
      onChange={onChange}
      showSuggestions={false}
      showCharacterCounts
      revisionHeading="示范文"
      revisionLabel="完整示范文"
    />);

    expect(screen.queryByText("【修改建议】")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("第 1 段第 1 条问题描述")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除第 1 段第 1 条建议" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "新增第 1 段建议" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "第 1 段" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("第 1 段完整示范文"), {
      target: { value: "我听见了雨声。" },
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      paragraphReviews: [expect.objectContaining({
        suggestions: report.paragraphReviews[0].suggestions,
        revisedText: "我听见了雨声。",
      })],
    }));
  });

  it("把可选要求交给同一段重写回调", () => {
    const onRewriteParagraph = vi.fn(async () => undefined);
    render(<ParagraphReviewEditor
      reviewId="review-1"
      report={report}
      ocr={ocr}
      images={[{ id: 1, position: 0 }]}
      disabled={false}
      onChange={vi.fn()}
      onRewriteParagraph={onRewriteParagraph}
    />);

    fireEvent.change(screen.getByLabelText("第 1 段 AI 修改要求"), {
      target: { value: "补充听觉细节" },
    });
    fireEvent.click(screen.getByRole("button", { name: "按要求重写第 1 段" }));
    expect(onRewriteParagraph).toHaveBeenCalledWith("paragraph-1", "补充听觉细节");
  });
});
