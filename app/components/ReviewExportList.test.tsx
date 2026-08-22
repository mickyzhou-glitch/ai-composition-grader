import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReviewExportList } from "./ReviewExportList";

const report = {
  grade: "B+",
  diagnostics: {
    authenticityAndRelevance: { finding: "时间顺序可信。", action: "保留真实细节。" },
    structure: { finding: "转折略突然。", action: "补充因果过渡。" },
  },
};

describe("ReviewExportList", () => {
  it("shows reviewed article metadata and both logic comments", () => {
    render(<ReviewExportList reviews={[{
      id: "review-1",
      studentName: "张小明",
      config: { title: "为自己鼓掌" },
      report,
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
    } as never]} selectedIds={new Set(["review-1"])} onToggle={vi.fn()} onReturnToReview={vi.fn()} />);

    expect(screen.getByText("张小明")).toBeInTheDocument();
    expect(screen.getByText("B+")).toBeInTheDocument();
    expect(screen.getByText(/时间顺序可信/)).toBeInTheDocument();
    expect(screen.getByText(/补充因果过渡/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "选择张小明的作文导出" })).toBeChecked();
  });
});
