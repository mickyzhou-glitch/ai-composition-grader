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
  sampleParagraphs: Array.from({ length: 5 }, (_, index) => `第${index + 1}段`),
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
});
