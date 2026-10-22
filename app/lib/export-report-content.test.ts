import { describe, expect, it } from "vitest";

import {
  buildExportReportContent,
  exportParagraphRuns,
  type ExportReviewSource,
} from "./export-report-content";

const diagnostics = {
  authenticityAndRelevance: { finding: "真实", action: "保留" },
  materialAndDetails: { finding: "细节少", action: "补动作" },
  structure: { finding: "完整", action: "保留" },
  language: { finding: "通顺", action: "保留" },
};

function review(): ExportReviewSource {
  return {
    id: "review-revised",
    studentName: "小明",
    config: { title: "登台" },
    teacherReviewedAt: "2026-08-22T06:00:00.000Z",
    reportStale: false,
    images: [{ id: 11, position: 0, width: 1200, height: 1600 }],
    ocr: {
      version: 2,
      ocrRevision: 1,
      editedAt: null,
      pages: [{ pageIndex: 0, text: "我慢慢走上台。灯光很亮。", readable: true, warnings: [] }],
      paragraphs: [{
        id: "paragraph-1",
        paragraphIndex: 0,
        text: "我慢慢走上台。灯光很亮。",
        segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
      }],
    },
    report: {
      version: 2,
      themeFit: "fits",
      themeReason: "切题",
      personalizedComment: "真实",
      painPoints: [],
      commonIssues: [],
      revisionSuggestions: [],
      grade: "A",
      diagnostics,
      paragraphReviews: [{
        paragraphId: "paragraph-1",
        suggestions: [
          { problem: "动作略快", advice: "写清迈步的感觉", example: "我听见自己的呼吸。" },
          { advice: "保留灯光这一句" },
        ],
        revisedText: "我终于走上台。灯光很亮。我听见自己的呼吸。",
      }],
      parentFeedbacks: [],
    },
  };
}

describe("导出段落只含修改动作和改后全段", () => {
  it("用与原段的逐句比对标记修改句和新增句", () => {
    const content = buildExportReportContent(review());
    const paragraph = content.pages[0]?.paragraphs[0];
    expect(paragraph?.revisionRuns).toEqual([
      { text: "我终于走上台。", changed: true },
      { text: "灯光很亮。", changed: false },
      { text: "我听见自己的呼吸。", changed: true },
    ]);

    const runs = exportParagraphRuns(paragraph!);
    const visible = runs.map((run) => run.text).join("");
    expect(visible).toContain("修改动作：写清迈步的感觉\n保留灯光这一句\n");
    expect(visible).toContain("改后全段：");
    expect(visible).toContain("我终于走上台。灯光很亮。我听见自己的呼吸。");
    expect(visible).not.toContain("动作略快");
    expect(visible).not.toContain("问题描述");
    expect(visible).not.toContain("修改示例");
    expect(visible).not.toContain("示范文本");
    expect(visible).not.toContain("修改建议");
    expect(runs.filter((run) => run.style === "changed").map((run) => run.text)).toEqual([
      "我终于走上台。",
      "我听见自己的呼吸。",
    ]);
    expect(runs.find((run) => run.text === "灯光很亮。")?.style).toBe("plain");
  });
});
