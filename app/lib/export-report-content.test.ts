import { describe, expect, it } from "vitest";

import { applyEssayToParagraphReviews } from "@/src/domain/essay-paragraph-sync";
import type { ParagraphEvaluationReport } from "@/src/domain/contracts";

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
    expect(content.pages[0]?.paragraphs).toHaveLength(1);
    expect(runs.filter((run) => run.text.startsWith("修改动作："))).toHaveLength(1);
    expect(visible).toContain("修改动作：1. 写清迈步的感觉\n2. 保留灯光这一句\n");
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

  it("结构段归组后按组合并原文做逐句下划线，并标出原文范围", () => {
    const source = review();
    const originals = ["甲句。", "乙句。", "丙句。"];
    source.ocr = {
      version: 2,
      ocrRevision: 1,
      editedAt: null,
      pages: [{ pageIndex: 0, text: originals.join(""), readable: true, warnings: [] }],
      paragraphs: originals.map((text, index) => ({
        id: `paragraph-${index + 1}`,
        paragraphIndex: index,
        text,
        segments: [{ pageIndex: 0, x: 0.1, y: 0.1 + index * 0.1, width: 0.5, height: 0.08 }],
      })),
    };
    source.report = {
      ...(source.report as object),
      rewrittenEssay: ["甲句。新的经过。", "丙句。"],
      paragraphReviews: [
        {
          paragraphId: "paragraph-1",
          sourceParagraphStart: 1,
          sourceParagraphEnd: 2,
          suggestions: [{ advice: "合并前两段。" }],
          revisedText: "甲句。新的经过。",
        },
        {
          paragraphId: "paragraph-3",
          sourceParagraphStart: 3,
          sourceParagraphEnd: 3,
          suggestions: [{ advice: "保留结尾。" }],
          revisedText: "丙句。",
        },
      ],
    } as ExportReviewSource["report"];

    const content = buildExportReportContent(source);
    expect(content.pages[0]?.paragraphs).toHaveLength(2);
    expect(content.pages[0]?.paragraphs[0]?.sourceLabel).toBe("对应原文第 1–2 段");
    expect(content.pages[0]?.paragraphs[0]?.revisionRuns).toEqual([
      { text: "甲句。", changed: false },
      { text: "新的经过。", changed: true },
    ]);
    expect(exportParagraphRuns(content.pages[0]!.paragraphs[0]!).map((run) => run.text).join(""))
      .toContain("对应原文第 1–2 段");
  });

  it("同段多条建议合并后框数仍等于段数", () => {
    const source = review();
    const paragraphs = ["开篇。", "经过。", "转折。", "感悟。", "收束。"];
    source.ocr = {
      version: 2,
      ocrRevision: 1,
      editedAt: null,
      pages: [{ pageIndex: 0, text: paragraphs.join(""), readable: true, warnings: [] }],
      paragraphs: paragraphs.map((text, index) => ({
        id: `paragraph-${index + 1}`,
        paragraphIndex: index,
        text,
        segments: [{ pageIndex: 0, x: 0.1, y: 0.05 + index * 0.1, width: 0.5, height: 0.08 }],
      })),
    };
    source.report = {
      ...(source.report as object),
      paragraphReviews: paragraphs.map((text, index) => ({
        paragraphId: `paragraph-${index + 1}`,
        suggestions: index === 0
          ? [{ advice: "补听觉" }, { advice: "补动作" }, { advice: "收束主题" }]
          : [{ advice: "本段无需修改" }],
        revisedText: index === 0 ? "开篇改后。经过保留。" : text,
      })),
    } as ExportReviewSource["report"];

    const content = buildExportReportContent(source);
    const boxes = content.pages[0]?.paragraphs ?? [];
    expect(boxes).toHaveLength(paragraphs.length);
    const first = exportParagraphRuns(boxes[0]!).map((run) => run.text).join("");
    expect(first).toContain("修改动作：1. 补听觉\n2. 补动作\n3. 收束主题\n");
    expect(first.match(/改后全段：/gu)).toHaveLength(1);
    expect(first).toContain("开篇改后。");
    expect(exportParagraphRuns(boxes[1]!).map((run) => run.text).join("")).toContain("修改动作：本段无需修改");
  });

  it("同步到逐段后导出改后全段使用范文，并按同步后的文本重算下划线", () => {
    const source = review();
    const essay = ["我终于走上台。灯光很亮。"];
    source.report = {
      ...(source.report as object),
      rewrittenEssay: essay,
      paragraphReviews: [{
        paragraphId: "paragraph-1",
        suggestions: [{ advice: "写清迈步" }],
        revisedText: "我慢慢走上台。灯光很亮。",
      }],
    } as ExportReviewSource["report"];
    source.report = applyEssayToParagraphReviews(source.report as ParagraphEvaluationReport);

    const content = buildExportReportContent(source);
    const paragraph = content.pages[0]?.paragraphs[0];
    expect(paragraph?.revisionRuns).toEqual([
      { text: "我终于走上台。", changed: true },
      { text: "灯光很亮。", changed: false },
    ]);
    expect(exportParagraphRuns(paragraph!).map((run) => run.text).join("")).toContain("我终于走上台。灯光很亮。");
  });

  it("原文段数少于范文时，同步到逐段后导出不报错，无对应原文的段整段划线", () => {
    const source = review();
    const originals = ["甲句。", "乙句。"];
    source.ocr = {
      version: 2,
      ocrRevision: 1,
      editedAt: null,
      pages: [{ pageIndex: 0, text: originals.join(""), readable: true, warnings: [] }],
      paragraphs: originals.map((text, index) => ({
        id: `paragraph-${index + 1}`,
        paragraphIndex: index,
        text,
        segments: [{ pageIndex: 0, x: 0.1, y: 0.2 + index * 0.2, width: 0.5, height: 0.1 }],
      })),
    };
    const essay = ["甲句。", "新增句。", "乙句。"];
    source.report = applyEssayToParagraphReviews({
      ...(source.report as ParagraphEvaluationReport),
      rewrittenEssay: essay,
      paragraphReviews: originals.map((text, index) => ({
        paragraphId: `paragraph-${index + 1}`,
        suggestions: [{ advice: "本段无需修改" }],
        revisedText: text,
      })),
    }, ["paragraph-1", "paragraph-2"]);

    const content = buildExportReportContent(source);
    const exported = content.pages.flatMap((page) => page.paragraphs);
    expect(exported).toHaveLength(3);
    expect(exported[1]?.sourceLabel).toBe("原文无对应段，整段新增");
    expect(exported[1]?.revisionRuns).toEqual([{ text: "新增句。", changed: true }]);
    expect(exported[0]?.revisionRuns).toEqual([{ text: "甲句。", changed: false }]);
  });

  it("导出使用已保存的改后全段，未同步的旧差异保持原样", () => {
    const source = review();
    const originals = ["甲句。", "乙句。"];
    source.ocr = {
      version: 2,
      ocrRevision: 1,
      editedAt: null,
      pages: [{ pageIndex: 0, text: originals.join(""), readable: true, warnings: [] }],
      paragraphs: originals.map((text, index) => ({
        id: `paragraph-${index + 1}`,
        paragraphIndex: index,
        text,
        segments: [{ pageIndex: 0, x: 0.1, y: 0.2 + index * 0.2, width: 0.5, height: 0.1 }],
      })),
    };
    const stored = {
      ...(source.report as ParagraphEvaluationReport),
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
    };
    source.report = {
      ...stored,
      rewrittenEssay: ["新甲。", "范文乙。"],
      paragraphReviews: stored.paragraphReviews.map((review, index) => (
        index === 0 ? { ...review, revisedText: "新甲。" } : review
      )),
    };

    const content = buildExportReportContent(source);
    const paragraphs = content.pages[0]?.paragraphs ?? [];
    expect(paragraphs).toHaveLength(2);
    expect(exportParagraphRuns(paragraphs[0]!).map((run) => run.text).join("")).toContain("新甲。");
    expect(exportParagraphRuns(paragraphs[1]!).map((run) => run.text).join("")).toContain("旧乙。");
    expect(paragraphs[1]?.revisionRuns.map((run) => run.text).join("")).toBe("旧乙。");
  });
});
