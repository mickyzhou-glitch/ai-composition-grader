import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReportEditor, scoreSummary } from "./ReportEditor";

const report = {
  themeFit: "fits" as const,
  themeReason: "切合题意",
  personalizedComment: "细节真诚",
  painPoints: ["结尾略快"],
  commonIssues: ["句式单一"],
  revisionSuggestions: ["补充感受"],
  scores: {
    themeIntent: 8,
    contentSelection: 7,
    structure: 6,
    languageExpression: 5,
    writingConventions: 3,
    total: 29,
    level: "重写" as const,
  },
  sampleParagraphs: Array.from({ length: 5 }, (_, index) => ({
    title: `第${index + 1}段`,
    text: "示范正文",
    suggestion: "修改建议",
  })),
};

describe("ReportEditor", () => {
  it.each([
    [29, "重写"], [30, "二类作文"], [35, "二类作文"], [36, "优秀作文"], [40, "优秀作文"],
  ] as const)("总分 %i 对应 %s", (total, level) => {
    expect(scoreSummary([total, 0, 0, 0, 0])).toEqual({ total, level });
  });

  it("编辑分数时确定性更新 total 和 level", async () => {
    const onChange = vi.fn();
    render(<ReportEditor report={report} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("主题立意（0-10）"), { target: { value: "9" } });

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ scores: expect.objectContaining({ total: 30, level: "二类作文" }) }),
    );
  });

  it("分数截断为整数并在偏题时将总分压到重写区间", () => {
    const onChange = vi.fn();
    const highReport = {
      ...report,
      scores: {
        themeIntent: 10,
        contentSelection: 10,
        structure: 8,
        languageExpression: 8,
        writingConventions: 4,
        total: 40,
        level: "优秀作文" as const,
      },
    };
    render(<ReportEditor report={highReport} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText("主题立意（0-10）"), { target: { value: "8.9" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ scores: expect.objectContaining({ themeIntent: 8 }) }),
    );

    fireEvent.change(screen.getByRole("combobox", { name: "主题判断" }), { target: { value: "off_topic" } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        themeFit: "off_topic",
        scores: expect.objectContaining({ total: 29, level: "重写" }),
      }),
    );
  });

  it("提供整篇 AI 重写与按整体要求修改入口", () => {
    const onRewriteAllSamples = vi.fn(async () => undefined);
    render(<ReportEditor report={report} onChange={vi.fn()} onRewriteAllSamples={onRewriteAllSamples} />);

    fireEvent.click(screen.getByRole("button", { name: "AI 全文重新生成" }));
    expect(onRewriteAllSamples).toHaveBeenCalledWith();

    fireEvent.change(screen.getByLabelText("AI 整体修改要求"), { target: { value: "删去无关人物" } });
    fireEvent.click(screen.getByRole("button", { name: "AI 按整体要求修改" }));
    expect(onRewriteAllSamples).toHaveBeenLastCalledWith("删去无关人物");
  });
});
