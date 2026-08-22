import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReportEditor } from "./ReportEditor";

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
  it("按实际条数展示优点和需要修改", () => {
    render(
      <ReportEditor
        report={{
          ...report,
          personalizedComment: [
            "选材真实贴近自己的生活",
            "礼物线索贯穿全文始终",
          ].join("\n"),
          painPoints: [
            "开头加入对比突出礼物珍贵",
            "第三段补充人物心理变化",
            "段落之间增加自然过渡句",
          ],
        }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByText("总体评价")).not.toBeInTheDocument();
    expect(screen.queryByText("个性评语")).not.toBeInTheDocument();
    expect(screen.queryByText("关键痛点")).not.toBeInTheDocument();
    expect(screen.queryByText("共性问题")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "优点" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "需要修改" })).toBeInTheDocument();
    expect(screen.getByLabelText("优点一")).toHaveValue("选材真实贴近自己的生活");
    expect(screen.getByLabelText("优点二")).toHaveValue("礼物线索贯穿全文始终");
    expect(screen.queryByLabelText("优点三")).not.toBeInTheDocument();
    expect(screen.getByLabelText("需要修改一")).toHaveValue("开头加入对比突出礼物珍贵");
    expect(screen.getByLabelText("需要修改三")).toHaveValue("段落之间增加自然过渡句");
    expect(screen.queryByLabelText("需要修改四")).not.toBeInTheDocument();
  });

  it("支持新增、删除和分别使用 AI 重新生成", () => {
    const onChange = vi.fn();
    const onRewriteFeedback = vi.fn(async () => undefined);
    render(
      <ReportEditor
        report={{
          ...report,
          personalizedComment: "选材真实贴近自己的生活\n礼物线索贯穿全文始终",
          painPoints: ["开头加入对比突出礼物珍贵", "第三段补充人物心理变化"],
        }}
        onChange={onChange}
        onRewriteFeedback={onRewriteFeedback}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "删除优点二" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      personalizedComment: "选材真实贴近自己的生活",
    }));

    fireEvent.click(screen.getByRole("button", { name: "新增优点" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      personalizedComment: "选材真实贴近自己的生活\n礼物线索贯穿全文始终\n",
    }));

    fireEvent.click(screen.getByRole("button", { name: "AI 重新生成优点" }));
    fireEvent.click(screen.getByRole("button", { name: "AI 重新生成需要修改" }));
    expect(onRewriteFeedback).toHaveBeenNthCalledWith(1, "strengths");
    expect(onRewriteFeedback).toHaveBeenNthCalledWith(2, "improvements");
  });

  it("显示七档等级与四维诊断，偏题时自动改为 C", () => {
    const onChange = vi.fn();
    render(<ReportEditor report={report} onChange={onChange} />);

    expect(screen.getByRole("combobox", { name: "作文等级" })).toHaveValue("C");
    expect(screen.getByLabelText("素材与细节精准定位")).toBeInTheDocument();
    expect(screen.getByText("生活常识与真实度")).toBeInTheDocument();
    expect(screen.getByText("前后逻辑与结构")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "主题判断" }), { target: { value: "off_topic" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ themeFit: "off_topic", grade: "C" }));
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
