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

  it("改后全段预览按修改动作摘录划单线/波浪线；教师改动作措辞时保留摘录", () => {
    const onChange = vi.fn();
    const { container } = render(<ParagraphReviewEditor
      reviewId="review-1"
      report={{
        ...report,
        paragraphReviews: [{
          ...report.paragraphReviews[0],
          suggestions: [{ advice: "1. 补听觉\n2. 写清迈步", revisedQuotes: ["我听见呼吸声，", "终于走上台。"] }],
          revisedText: "我听见呼吸声，终于走上台。",
        }],
      }}
      ocr={{ ...ocr, paragraphs: [{ ...ocr.paragraphs[0], text: "我走上台。" }] }}
      images={[{ id: 1, position: 0 }]}
      disabled={false}
      onChange={onChange}
    />);

    const underlines = [...container.querySelectorAll("[data-underline]")].map((node) => [node.textContent, node.getAttribute("data-underline")]);
    expect(underlines).toEqual([["我听见呼吸声，", "single"], ["终于走上台。", "wave"]]);

    fireEvent.change(screen.getByLabelText("第 1 段修改动作"), {
      target: { value: "1. 补呼吸声\n2. 写清迈步" },
    });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      paragraphReviews: [expect.objectContaining({
        suggestions: [{ advice: "1. 补呼吸声\n2. 写清迈步", revisedQuotes: ["我听见呼吸声，", "终于走上台。"] }],
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

  it("结构段归组后每组一个框，编辑任一边实时同步另一边，下划线对照合并后的原文", () => {
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
      rewrittenEssay: ["我非常高兴。天很蓝。", "结尾保留。"],
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
        expect.objectContaining({ revisedText: "结尾改过。" }),
      ],
    }));
  });

  it("编辑改后全段时以 revisedText 为权威实时刷新完整范文", () => {
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
    expect(screen.queryByRole("button", { name: "同步到逐段" })).not.toBeInTheDocument();

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
      rewrittenEssay: ["旧甲。", "新乙。"],
      paragraphReviews: [
        expect.objectContaining({ revisedText: "旧甲。" }),
        expect.objectContaining({ revisedText: "新乙。" }),
      ],
    }));
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

    expect(screen.getByRole("button", { name: "保留完整范文（5 段）" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "同步到逐段" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("textbox", { name: /第 \d+ 段改后全段/u })).toHaveLength(5);
    expect(screen.getByLabelText("完整范文第 3 段")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保留完整范文（5 段）" }));
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

  it("支持手动拖选文字与按句点选标线（单横线/波浪线/点划线/取消标线），并支持增删修改动作", () => {
    const paragraphText = "“良言一句三冬暖。”一句温暖贴心的话，能在寒冬里焐热一颗心。我以前却不这么想。那时我最怕数学金老师。";
    let currentReport = {
      ...report,
      paragraphReviews: [{
        paragraphId: "paragraph-1",
        suggestions: [{
          advice: "1. 第一段只保留名言引入、简单解释名言、点出人物金老师，再加一句过渡；\n2. 换用与“温暖关心”主旨贴切的名言“良言一句三冬暖”。",
        }],
        revisedText: paragraphText,
      }],
    };
    const onChange = vi.fn((next) => {
      currentReport = next;
    });
    const sourceOcr = {
      ...ocr,
      paragraphs: [{ ...ocr.paragraphs[0], text: "常言道失败乃成功之母。我最怕金老师。" }],
    };

    const { container, rerender } = render(
      <ParagraphReviewEditor
        reviewId="review-1"
        report={currentReport}
        ocr={sourceOcr}
        images={[]}
        disabled={false}
        onChange={onChange}
        showSourceCrops={false}
        showCharacterCounts
      />,
    );

    // 初始无 revisedQuotes 时整段退回单线
    expect([...container.querySelectorAll("[data-underline]")].map((el) => el.getAttribute("data-underline"))).toEqual(["single"]);

    // 1) 在改后全段输入框中选中开头名言，点击「划第 2 条·波浪线」
    const textarea = screen.getByLabelText("第 1 段改后全段") as HTMLTextAreaElement;
    textarea.setSelectionRange(0, "“良言一句三冬暖。”".length);
    fireEvent.select(textarea);
    fireEvent.click(screen.getByRole("button", { name: "第 1 段选中文字划第 2 条标线" }));
    rerender(
      <ParagraphReviewEditor
        reviewId="review-1"
        report={currentReport}
        ocr={sourceOcr}
        images={[]}
        disabled={false}
        onChange={onChange}
        showSourceCrops={false}
        showCharacterCounts
      />,
    );

    // 2) 打开「按句调整标线」面板，把第 4 句设为「不划」
    fireEvent.click(screen.getByRole("button", { name: "第 1 段按句调整标线" }));
    fireEvent.click(screen.getByRole("button", { name: "第 1 段第 4 句设为不划线" }));
    rerender(
      <ParagraphReviewEditor
        reviewId="review-1"
        report={currentReport}
        ocr={sourceOcr}
        images={[]}
        disabled={false}
        onChange={onChange}
        showSourceCrops={false}
        showCharacterCounts
      />,
    );

    expect(currentReport.paragraphReviews[0]!.suggestions[0]).toMatchObject({
      advice: "1. 第一段只保留名言引入、简单解释名言、点出人物金老师，再加一句过渡；\n2. 换用与“温暖关心”主旨贴切的名言“良言一句三冬暖”。",
      revisedQuotes: [
        "一句温暖贴心的话，能在寒冬里焐热一颗心。我以前却不这么想。",
        "“良言一句三冬暖。”",
      ],
    });
    expect([...container.querySelectorAll("[data-underline]")].map((el) => [
      el.textContent,
      el.getAttribute("data-underline"),
    ])).toEqual([
      ["“良言一句三冬暖。”", "wave"],
      ["一句温暖贴心的话，能在寒冬里焐热一颗心。我以前却不这么想。", "single"],
    ]);
    // 修改动作预览条同步显示对应红线线型
    expect([...container.querySelectorAll("[data-action-underline]")].map((el) => el.getAttribute("data-action-underline"))).toEqual([
      "single",
      "wave",
    ]);

    // 3) 点击「+ 加一条动作」仅进入输入草稿态，未输入前不污染底层 report；输入第 3 条后把第 3 句设为点划线
    fireEvent.click(screen.getByRole("button", { name: "第 1 段新增一条修改动作" }));
    expect(currentReport.paragraphReviews[0]!.suggestions[0]!.advice).not.toContain("请填写新增修改动作");
    fireEvent.change(screen.getByLabelText("第 1 段修改动作"), {
      target: {
        value: "1. 第一段只保留名言引入、简单解释名言、点出人物金老师，再加一句过渡；\n2. 换用与“温暖关心”主旨贴切的名言“良言一句三冬暖”；\n3. 点出转折心理。",
      },
    });
    rerender(
      <ParagraphReviewEditor
        reviewId="review-1"
        report={currentReport}
        ocr={sourceOcr}
        images={[]}
        disabled={false}
        onChange={onChange}
        showSourceCrops={false}
        showCharacterCounts
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "第 1 段第 3 句设为第 3 条标线" }));
    rerender(
      <ParagraphReviewEditor
        reviewId="review-1"
        report={currentReport}
        ocr={sourceOcr}
        images={[]}
        disabled={false}
        onChange={onChange}
        showSourceCrops={false}
        showCharacterCounts
      />,
    );
    expect([...container.querySelectorAll("[data-underline]")].map((el) => [
      el.textContent,
      el.getAttribute("data-underline"),
    ])).toEqual([
      ["“良言一句三冬暖。”", "wave"],
      ["一句温暖贴心的话，能在寒冬里焐热一颗心。", "single"],
      ["我以前却不这么想。", "dotDotDash"],
    ]);

    // 4) 在改后全段内微调划线句文字，三条标线自动跟随更新而不退回全段单线
    fireEvent.change(screen.getByLabelText("第 1 段改后全段"), {
      target: { value: paragraphText.replace("焐热", "温暖") },
    });
    rerender(
      <ParagraphReviewEditor
        reviewId="review-1"
        report={currentReport}
        ocr={sourceOcr}
        images={[]}
        disabled={false}
        onChange={onChange}
        showSourceCrops={false}
        showCharacterCounts
      />,
    );
    expect([...container.querySelectorAll("[data-underline]")].map((el) => [
      el.textContent,
      el.getAttribute("data-underline"),
    ])).toEqual([
      ["“良言一句三冬暖。”", "wave"],
      ["一句温暖贴心的话，能在寒冬里温暖一颗心。", "single"],
      ["我以前却不这么想。", "dotDotDash"],
    ]);

    // 5) 清空全段标线后全段无下划线，不退回整段自动单线
    fireEvent.click(screen.getByRole("button", { name: "第 1 段清空全段标线" }));
    rerender(
      <ParagraphReviewEditor
        reviewId="review-1"
        report={currentReport}
        ocr={sourceOcr}
        images={[]}
        disabled={false}
        onChange={onChange}
        showSourceCrops={false}
        showCharacterCounts
      />,
    );
    expect(container.querySelectorAll("[data-underline]")).toHaveLength(0);
  });

  it("修改动作框支持回车换行不回弹、清空后底层报告自动落为合法无需修改，且选区折叠或范文变更后立即失效", () => {
    let currentReport = {
      ...report,
      rewrittenEssay: ["清晨下雨。"],
      paragraphReviews: [{
        paragraphId: "paragraph-1",
        suggestions: [{ advice: "补细节" }],
        revisedText: "清晨下雨。",
      }],
    };
    const onChange = vi.fn((next) => {
      currentReport = next;
    });
    const { rerender } = render(
      <ParagraphReviewEditor
        reviewId="review-1"
        report={currentReport}
        ocr={ocr}
        images={[]}
        disabled={false}
        onChange={onChange}
      />,
    );

    // 1) 在「补细节」末尾按回车换行，受控框保留尾随换行，可继续输入第 2 条
    const actionBox = screen.getByLabelText("第 1 段修改动作") as HTMLTextAreaElement;
    fireEvent.change(actionBox, { target: { value: "补细节\n" } });
    rerender(<ParagraphReviewEditor reviewId="review-1" report={currentReport} ocr={ocr} images={[]} disabled={false} onChange={onChange} />);
    expect(screen.getByLabelText("第 1 段修改动作")).toHaveValue("补细节\n");

    // 2) 全选清空修改动作：聚焦态输入框显示空串，底层 report 写入合法的「本段无需修改」
    fireEvent.change(actionBox, { target: { value: "" } });
    rerender(<ParagraphReviewEditor reviewId="review-1" report={currentReport} ocr={ocr} images={[]} disabled={false} onChange={onChange} />);
    expect(screen.getByLabelText("第 1 段修改动作")).toHaveValue("");
    expect(currentReport.paragraphReviews[0]!.suggestions[0]!.advice).toBe("本段无需修改");
    fireEvent.blur(screen.getByLabelText("第 1 段修改动作"));
    expect(screen.getByLabelText("第 1 段修改动作")).toHaveValue("本段无需修改");

    // 3) 恢复动作后选中「下雨」，再折叠选区或修改顶部完整范文：划线按钮立即禁用，绝不误划错位文字
    fireEvent.change(screen.getByLabelText("第 1 段修改动作"), { target: { value: "补雨景" } });
    rerender(<ParagraphReviewEditor reviewId="review-1" report={currentReport} ocr={ocr} images={[]} disabled={false} onChange={onChange} />);

    const revBox = screen.getByLabelText("第 1 段改后全段") as HTMLTextAreaElement;
    revBox.setSelectionRange(2, 4);
    fireEvent.select(revBox);
    expect(screen.getByRole("button", { name: "第 1 段选中文字划第 1 条标线" })).toBeEnabled();

    // 单击折叠选区 -> 立即禁用
    revBox.setSelectionRange(2, 2);
    fireEvent.select(revBox);
    expect(screen.getByRole("button", { name: "第 1 段选中文字划第 1 条标线" })).toBeDisabled();

    // 再次选中后从顶部「完整范文」修改正文 -> 旧选区快照不匹配，划线按钮立即禁用
    revBox.setSelectionRange(2, 4);
    fireEvent.select(revBox);
    expect(screen.getByRole("button", { name: "第 1 段选中文字划第 1 条标线" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("完整范文第 1 段"), { target: { value: "今天清晨下雨。" } });
    rerender(<ParagraphReviewEditor reviewId="review-1" report={currentReport} ocr={ocr} images={[]} disabled={false} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "第 1 段选中文字划第 1 条标线" })).toBeDisabled();

    // 4) 粘贴 13 条连续编号动作后点「清空全段标线」，13 条全部清空，不退回整段自动单线
    const thirteenActions = Array.from({ length: 13 }, (_, idx) => `${idx + 1}. 动作${idx + 1}`).join("\n");
    fireEvent.change(screen.getByLabelText("第 1 段修改动作"), { target: { value: thirteenActions } });
    rerender(<ParagraphReviewEditor reviewId="review-1" report={currentReport} ocr={ocr} images={[]} disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "第 1 段清空全段标线" }));
    rerender(<ParagraphReviewEditor reviewId="review-1" report={currentReport} ocr={ocr} images={[]} disabled={false} onChange={onChange} />);
    expect(screen.getByLabelText("改后全段整句下划线预览").querySelectorAll("[data-underline]")).toHaveLength(0);
  });

  it("覆盖预览外单击折叠选区清零（M7）、跨学生同文切换隔离（M8）、选中删除首句保留次句标线（M3）及新增后按回车清理空编号（m1）", () => {
    let reportA = {
      ...report,
      paragraphReviews: [{
        paragraphId: "paragraph-1",
        suggestions: [{ advice: "补细节" }],
        revisedText: "甲。甲。",
      }],
    };
    let reportB = structuredClone(reportA);
    const onChangeA = vi.fn((next) => { reportA = next; });
    const onChangeB = vi.fn((next) => { reportB = next; });

    const { container, rerender } = render(
      <ParagraphReviewEditor
        reviewId="review-a"
        report={reportA}
        ocr={ocr}
        images={[]}
        disabled={false}
        onChange={onChangeA}
      />,
    );

    // m1: 点击「+ 加一条动作」后在 `2. ` 末尾再按回车产生空行，失焦后正式 advice 不残留 `2.`
    fireEvent.click(screen.getByRole("button", { name: "第 1 段新增一条修改动作" }));
    const actionBox = screen.getByLabelText("第 1 段修改动作") as HTMLTextAreaElement;
    fireEvent.change(actionBox, { target: { value: "1. 补细节\n2. \n" } });
    fireEvent.blur(actionBox);
    rerender(<ParagraphReviewEditor reviewId="review-a" report={reportA} ocr={ocr} images={[]} disabled={false} onChange={onChangeA} />);
    expect(reportA.paragraphReviews[0]!.suggestions[0]!.advice).toBe("补细节");
    expect(screen.getByLabelText("第 1 段修改动作")).toHaveValue("补细节");

    // M7: 在 RevisionPreview 选中文字后，DOM 选区在预览外折叠触发 selectionchange，划线按钮立即禁用
    const previewSpan = container.querySelector("[data-char-start]")!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(previewSpan.firstChild!, 0);
    range.setEnd(previewSpan.firstChild!, 2);
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(screen.getByLabelText("改后全段整句下划线预览"));
    expect(screen.getByRole("button", { name: "第 1 段选中文字划第 1 条标线" })).toBeEnabled();

    selection.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
    expect(screen.getByRole("button", { name: "第 1 段选中文字划第 1 条标线" })).toBeDisabled();

    // M8: 在学生 A 选中第 2 句，同实例切换到相同正文的另一篇 review-b 时，B 的划线按钮保持禁用
    const revBox = screen.getByLabelText("第 1 段改后全段") as HTMLTextAreaElement;
    revBox.setSelectionRange(2, 4);
    fireEvent.select(revBox);
    expect(screen.getByRole("button", { name: "第 1 段选中文字划第 1 条标线" })).toBeEnabled();

    rerender(<ParagraphReviewEditor reviewId="review-b" report={reportB} ocr={ocr} images={[]} disabled={false} onChange={onChangeB} />);
    expect(screen.getByRole("button", { name: "第 1 段选中文字划第 1 条标线" })).toBeDisabled();

    // R5-m2: 未在 review-b 做任何选区操作直接切回学生 A，旧选区已清空，划线按钮保持禁用直到重新选字
    rerender(<ParagraphReviewEditor reviewId="review-a" report={reportA} ocr={ocr} images={[]} disabled={false} onChange={onChangeA} />);
    expect(screen.getByRole("button", { name: "第 1 段选中文字划第 1 条标线" })).toBeDisabled();
    const revBoxA = screen.getByLabelText("第 1 段改后全段") as HTMLTextAreaElement;
    revBoxA.setSelectionRange(2, 4);
    fireEvent.select(revBoxA);
    fireEvent.click(screen.getByRole("button", { name: "第 1 段选中文字划第 1 条标线" }));
    rerender(<ParagraphReviewEditor reviewId="review-a" report={reportA} ocr={ocr} images={[]} disabled={false} onChange={onChangeA} />);

    revBoxA.setSelectionRange(0, 2);
    fireEvent.select(revBoxA);
    fireEvent.change(revBoxA, { target: { value: "甲。" } });
    rerender(<ParagraphReviewEditor reviewId="review-a" report={reportA} ocr={ocr} images={[]} disabled={false} onChange={onChangeA} />);
    expect([...container.querySelectorAll("[data-underline]")].map((el) => el.textContent)).toEqual(["甲。"]);
  });

  it("覆盖全选粘贴保留中间标线（R3-M1）、顶部完整范文删除前句保留后句标线（R3-M2）、小数 1.5 倍换行输入空编号不误删（R3-M3）及无需修改隐藏恢复按钮（R3-m2）", () => {
    let current = {
      ...report,
      rewrittenEssay: ["甲。风停了。乙。"],
      paragraphReviews: [{
        paragraphId: "paragraph-1",
        suggestions: [{
          advice: "1.5 倍",
          revisedQuotes: ["风停了。"],
          revisedRanges: [{ start: 2, end: 6, actionIndex: 0, text: "风停了。" }],
        }],
        revisedText: "甲。风停了。乙。",
      }],
    };
    const onChange = vi.fn((next) => { current = next; });
    const { container, rerender } = render(
      <ParagraphReviewEditor reviewId="review-r3" report={current} ocr={ocr} images={[]} disabled={false} onChange={onChange} />,
    );

    // R3-M3: 以「1.5 倍」开始，手动换行输入 `2. ` 再失焦，绝不把 `1.` 误删成 `5 倍`
    const actionBox = screen.getByLabelText("第 1 段修改动作") as HTMLTextAreaElement;
    fireEvent.change(actionBox, { target: { value: "1.5 倍\n2. " } });
    rerender(<ParagraphReviewEditor reviewId="review-r3" report={current} ocr={ocr} images={[]} disabled={false} onChange={onChange} />);
    expect(current.paragraphReviews[0]!.suggestions[0]!.advice).toBe("1.5 倍");
    fireEvent.blur(actionBox);
    rerender(<ParagraphReviewEditor reviewId="review-r3" report={current} ocr={ocr} images={[]} disabled={false} onChange={onChange} />);
    expect(screen.getByLabelText("第 1 段修改动作")).toHaveValue("1.5 倍");

    // R3-M1: 在「改后全段」全选并粘贴「丙。风停了。丁。」，中间「风停了。」标线完整保留
    const revBox = screen.getByLabelText("第 1 段改后全段") as HTMLTextAreaElement;
    revBox.setSelectionRange(0, current.paragraphReviews[0]!.revisedText.length);
    fireEvent.select(revBox);
    fireEvent.change(revBox, { target: { value: "丙。风停了。丁。" } });
    rerender(<ParagraphReviewEditor reviewId="review-r3" report={current} ocr={ocr} images={[]} disabled={false} onChange={onChange} />);
    expect([...container.querySelectorAll("[data-underline]")].map((el) => el.textContent)).toEqual(["风停了。"]);

    // R3-M2: 顶部「完整范文」有重复句「甲。甲。」且只划第 2 句，在顶部框选中第 1 句删除后保留剩余句标线
    current = {
      ...current,
      rewrittenEssay: ["甲。甲。"],
      paragraphReviews: [{
        paragraphId: "paragraph-1",
        suggestions: [{
          advice: "强调后句",
          revisedQuotes: ["甲。"],
          revisedRanges: [{ start: 2, end: 4, actionIndex: 0, text: "甲。" }],
        }],
        revisedText: "甲。甲。",
      }],
    };
    rerender(<ParagraphReviewEditor reviewId="review-r3" report={current} ocr={ocr} images={[]} disabled={false} onChange={onChange} />);
    const essayBox = screen.getByLabelText("完整范文第 1 段") as HTMLTextAreaElement;
    essayBox.setSelectionRange(0, 2);
    fireEvent.select(essayBox);
    fireEvent.change(essayBox, { target: { value: "甲。" } });
    rerender(<ParagraphReviewEditor reviewId="review-r3" report={current} ocr={ocr} images={[]} disabled={false} onChange={onChange} />);
    expect([...container.querySelectorAll("[data-underline]")].map((el) => el.textContent)).toEqual(["甲。"]);

    // R3-m2: 点「设为无需修改」后不显示「恢复自动标线」按钮
    fireEvent.click(screen.getByRole("button", { name: "第 1 段设为无需修改" }));
    rerender(<ParagraphReviewEditor reviewId="review-r3" report={current} ocr={ocr} images={[]} disabled={false} onChange={onChange} />);
    expect(screen.queryByRole("button", { name: "第 1 段恢复自动标线" })).not.toBeInTheDocument();
  });
});
