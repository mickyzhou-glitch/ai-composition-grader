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
    expect(text.indexOf("原文裁图 1")).toBeLessThan(text.indexOf("【修改动作】"));
    expect(text.indexOf("【修改动作】")).toBeLessThan(text.indexOf("【改后全段】"));
    expect(screen.queryByLabelText("第 1 段第 1 条问题描述")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("第 1 段第 1 条修改示例")).not.toBeInTheDocument();
    expect(screen.getByLabelText("第 1 段修改动作")).toHaveValue("补充程度");
    expect(screen.queryByText("描写普通")).not.toBeInTheDocument();
    expect(screen.queryByText("我非常高兴。")).not.toBeInTheDocument();
    expect(paragraph.querySelector("del")).toBeNull();
    expect(screen.getByLabelText("改后全段整句下划线预览")).toHaveTextContent("我非常高兴！");
    expect(paragraph.querySelector(".revision-preview__changed-sentence")).toHaveStyle({
      color: "#1F4E78",
      textDecoration: "underline",
    });

    fireEvent.change(screen.getByLabelText("第 1 段修改动作"), {
      target: { value: "写清高兴的程度" },
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      paragraphReviews: [expect.objectContaining({
        suggestions: [expect.objectContaining({ advice: "写清高兴的程度" })],
      })],
    }));

    fireEvent.change(screen.getByLabelText("第 1 段改后全段"), {
      target: { value: "我很高兴。" },
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      paragraphReviews: [expect.objectContaining({ revisedText: "我很高兴。" })],
    }));
  });

  it("同段多条建议仍是一个框，修改动作编号写在一起", () => {
    const onChange = vi.fn();
    const { container } = render(<ParagraphReviewEditor
      reviewId="review-1"
      report={{
        ...report,
        paragraphReviews: [{
          ...report.paragraphReviews[0],
          suggestions: [
            { advice: "补听觉" },
            { advice: "补动作" },
            { advice: "收束主题" },
          ],
          revisedText: "我听见呼吸声，终于走上台。",
        }],
      }}
      ocr={{
        ...ocr,
        paragraphs: [{ ...ocr.paragraphs[0], text: "我走上台。" }],
      }}
      images={[{ id: 1, position: 0 }]}
      disabled={false}
      onChange={onChange}
    />);

    expect(container.querySelectorAll(".paragraph-suggestion")).toHaveLength(1);
    expect(container.querySelectorAll("[data-paragraph-id]")).toHaveLength(1);
    expect(screen.getAllByRole("textbox", { name: /改后全段/u })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /新增第 \d+ 段建议/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /删除第 \d+ 段第 \d+ 条建议/u })).not.toBeInTheDocument();
    expect(screen.getByLabelText("第 1 段修改动作")).toHaveValue("1. 补听觉\n2. 补动作\n3. 收束主题");
    expect(screen.getByLabelText("改后全段整句下划线预览")).toHaveTextContent("我听见呼吸声，终于走上台。");

    fireEvent.change(screen.getByLabelText("第 1 段修改动作"), {
      target: { value: "1. 补听觉\n2. 写清迈步" },
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      paragraphReviews: [expect.objectContaining({
        suggestions: [{ advice: "1. 补听觉\n2. 写清迈步" }],
      })],
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

    expect(screen.queryByText("【修改动作】")).not.toBeInTheDocument();
    expect(screen.queryByText("【修改建议】")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("第 1 段修改动作")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("第 1 段第 1 条修改动作")).not.toBeInTheDocument();
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

  it("改后全段里未改的句子不下划线，修改和新增的整句下划线", () => {
    const { container } = render(<ParagraphReviewEditor
      reviewId="review-1"
      report={{
        ...report,
        paragraphReviews: [{
          ...report.paragraphReviews[0],
          revisedText: "我非常高兴！天很蓝。",
        }],
      }}
      ocr={{
        ...ocr,
        paragraphs: [{ ...ocr.paragraphs[0], text: "我很高兴。天很蓝。" }],
      }}
      images={[{ id: 1, position: 0 }]}
      disabled={false}
      onChange={vi.fn()}
    />);

    const paragraph = container.querySelector("[data-paragraph-id='paragraph-1']")!;
    const changed = [...paragraph.querySelectorAll(".revision-preview__changed-sentence")];
    expect(changed.map((node) => node.textContent)).toEqual(["我非常高兴！"]);
    expect(changed[0]).toHaveStyle({ textDecoration: "underline" });
    expect(paragraph.textContent).toContain("天很蓝。");
    expect(paragraph.querySelector(".revision-preview")?.textContent).toBe("我非常高兴！天很蓝。");
  });

  it("结构段归组后每组一个框，编辑一边不会改另一边，下划线对照合并后的原文", () => {
    const onChange = vi.fn();
    const essay = ["我很高兴。天很蓝。", "结尾保留。"];
    render(<ParagraphReviewEditor
      reviewId="review-1"
      report={{
        ...report,
        rewrittenEssay: essay,
        paragraphReviews: [
          {
            paragraphId: "paragraph-1",
            sourceParagraphStart: 1,
            sourceParagraphEnd: 2,
            suggestions: [{ advice: "合并前两段。" }],
            revisedText: essay[0],
          },
          {
            paragraphId: "paragraph-3",
            sourceParagraphStart: 3,
            sourceParagraphEnd: 3,
            suggestions: [{ advice: "保留结尾。" }],
            revisedText: essay[1],
          },
        ],
      }}
      ocr={{
        ...ocr,
        paragraphs: [
          { ...ocr.paragraphs[0], text: "我很高兴。" },
          {
            id: "paragraph-2",
            paragraphIndex: 1,
            text: "天很蓝。",
            segments: [{ pageIndex: 0, x: 0.1, y: 0.4, width: 0.5, height: 0.1 }],
          },
          {
            id: "paragraph-3",
            paragraphIndex: 2,
            text: "结尾保留。",
            segments: [{ pageIndex: 0, x: 0.1, y: 0.6, width: 0.5, height: 0.1 }],
          },
        ],
      }}
      images={[{ id: 1, position: 0 }]}
      disabled={false}
      onChange={onChange}
    />);

    expect(screen.getByText("对应原文第 1–2 段")).toBeInTheDocument();
    expect(screen.getByText("对应原文第 3 段")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox", { name: /改后全段/u })).toHaveLength(2);
    expect(screen.getAllByLabelText("改后全段整句下划线预览")[0]).toHaveTextContent("我很高兴。天很蓝。");
    expect(screen.queryByText("与逐段不一致")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("第 1 段改后全段"), {
      target: { value: "我非常高兴。天很蓝。" },
    });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
      rewrittenEssay: essay,
      paragraphReviews: [
        expect.objectContaining({ revisedText: "我非常高兴。天很蓝。" }),
        expect.objectContaining({ revisedText: "结尾保留。" }),
      ],
    }));

    fireEvent.change(screen.getByLabelText("完整范文第 2 段"), {
      target: { value: "结尾改过。" },
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      rewrittenEssay: [essay[0], "结尾改过。"],
      paragraphReviews: [
        expect.objectContaining({ revisedText: essay[0] }),
        expect.objectContaining({ revisedText: essay[1] }),
      ],
    }));
  });

  it("结构归组的旧差异不会在打开或编辑时自动改写", () => {
    const onChange = vi.fn();
    render(<ParagraphReviewEditor
      reviewId="review-1"
      report={{
        ...report,
        rewrittenEssay: ["范文甲。", "范文乙。"],
        paragraphReviews: [
          {
            paragraphId: "paragraph-1",
            sourceParagraphStart: 1,
            sourceParagraphEnd: 1,
            suggestions: [{ advice: "改开篇" }],
            revisedText: "旧甲。",
          },
          {
            paragraphId: "paragraph-2",
            sourceParagraphStart: 2,
            sourceParagraphEnd: 2,
            suggestions: [{ advice: "本段无需修改" }],
            revisedText: "旧乙。",
          },
        ],
      }}
      ocr={{
        ...ocr,
        paragraphs: [
          { ...ocr.paragraphs[0], text: "原文甲。" },
          {
            id: "paragraph-2",
            paragraphIndex: 1,
            text: "原文乙。",
            segments: [{ pageIndex: 0, x: 0.1, y: 0.4, width: 0.5, height: 0.1 }],
          },
        ],
      }}
      images={[]}
      disabled={false}
      onChange={onChange}
    />);

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("完整范文第 1 段")).toHaveValue("范文甲。");
    expect(screen.getByLabelText("第 1 段改后全段")).toHaveValue("旧甲。");
    expect(screen.getByText("与逐段不一致")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("第 1 段修改动作"), {
      target: { value: "补一个动作" },
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      rewrittenEssay: ["范文甲。", "范文乙。"],
      paragraphReviews: [
        expect.objectContaining({ revisedText: "旧甲。", suggestions: [{ advice: "补一个动作" }] }),
        expect.objectContaining({ revisedText: "旧乙。" }),
      ],
    }));

    fireEvent.change(screen.getByLabelText("第 2 段改后全段"), {
      target: { value: "新乙。" },
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      rewrittenEssay: ["范文甲。", "范文乙。"],
      paragraphReviews: [
        expect.objectContaining({ revisedText: "旧甲。" }),
        expect.objectContaining({ revisedText: "新乙。" }),
      ],
    }));
    expect(screen.getByText("与逐段不一致")).toBeInTheDocument();
  });

  it("同步到逐段以完整范文覆盖五段改后全段，并重算下划线和字数", () => {
    const essay = ["开篇改后。", "抑。", "扬的事件。", "真相。", "结尾。"];
    const sources = ["开篇。", "抑。", "扬。", "真相。", "结尾。"];
    const onChange = vi.fn();
    const { container, rerender } = render(<ParagraphReviewEditor
      reviewId="review-1"
      report={{
        ...report,
        rewrittenEssay: essay,
        paragraphReviews: sources.map((revisedText, index) => ({
          paragraphId: `paragraph-${index + 1}`,
          suggestions: [{ advice: index === 0 ? "写清开篇" : "本段无需修改" }],
          revisedText,
        })),
      }}
      ocr={{
        ...ocr,
        paragraphs: sources.map((text, index) => ({
          id: `paragraph-${index + 1}`,
          paragraphIndex: index,
          text,
          segments: [{ pageIndex: 0, x: 0.1, y: 0.1 + index * 0.1, width: 0.5, height: 0.08 }],
        })),
      }}
      images={[{ id: 1, position: 0 }]}
      disabled={false}
      onChange={onChange}
      showCharacterCounts
    />);

    expect(screen.getByRole("button", { name: "同步到逐段" })).toBeEnabled();
    expect(screen.getByText("与逐段不一致")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox", { name: /第 \d+ 段改后全段/u })).toHaveLength(5);
    fireEvent.change(screen.getByLabelText("完整范文第 3 段"), { target: { value: "扬的事件补充细节。" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      rewrittenEssay: [essay[0], essay[1], "扬的事件补充细节。", essay[3], essay[4]],
      paragraphReviews: expect.arrayContaining([
        expect.objectContaining({ revisedText: "开篇。" }),
      ]),
    }));

    fireEvent.click(screen.getByRole("button", { name: "同步到逐段" }));
    const synced = onChange.mock.calls.at(-1)?.[0];
    expect(synced.paragraphReviews.map((item: { revisedText: string }) => item.revisedText)).toEqual(essay);
    rerender(<ParagraphReviewEditor
      reviewId="review-1"
      report={synced}
      ocr={{
        ...ocr,
        paragraphs: sources.map((text, index) => ({
          id: `paragraph-${index + 1}`,
          paragraphIndex: index,
          text,
          segments: [{ pageIndex: 0, x: 0.1, y: 0.1 + index * 0.1, width: 0.5, height: 0.08 }],
        })),
      }}
      images={[{ id: 1, position: 0 }]}
      disabled={false}
      onChange={onChange}
      showCharacterCounts
    />);

    expect(screen.queryByText("与逐段不一致")).not.toBeInTheDocument();
    expect(screen.getByLabelText("第 1 段改后全段")).toHaveValue("开篇改后。");
    const firstParagraph = container.querySelector("[data-paragraph-id='paragraph-1']")!;
    expect(firstParagraph.querySelector(".revision-preview__changed-sentence")).toHaveTextContent("开篇改后。");
    expect(firstParagraph.textContent).toContain("改后全段");
    expect(firstParagraph.textContent).toMatch(/5\s*字/);
    const secondParagraph = container.querySelector("[data-paragraph-id='paragraph-2']")!;
    expect(secondParagraph.querySelector(".revision-preview__changed-sentence")).toBeNull();
    expect(secondParagraph.textContent).toMatch(/2\s*字/);
  });
});
