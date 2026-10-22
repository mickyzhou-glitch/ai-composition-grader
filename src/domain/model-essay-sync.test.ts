import { describe, expect, it } from "vitest";

import type { ParagraphEvaluationReport } from "./contracts";
import {
  explicitStructureParagraphCount,
  modelEssayParagraphCount,
  ocrParagraphIdsFromCheckpoint,
  planModelEssaySync,
} from "./model-essay-sync";
import { paragraphReviewCoverageMessage } from "./paragraph-review-groups";

const diagnostics = {
  authenticityAndRelevance: { finding: "真实", action: "保留" },
  materialAndDetails: { finding: "细节少", action: "补动作" },
  structure: { finding: "完整", action: "保留" },
  language: { finding: "普通", action: "改具体" },
};

function report(essay: string[], revised: string[]): ParagraphEvaluationReport {
  return {
    version: 2,
    themeFit: "fits",
    themeReason: "切题",
    personalizedComment: "真实",
    painPoints: [],
    commonIssues: [],
    revisionSuggestions: [],
    grade: "A-",
    diagnostics,
    rewrittenEssay: essay,
    paragraphReviews: revised.map((revisedText, index) => ({
      paragraphId: `paragraph-${index + 1}`,
      suggestions: [{ advice: index === 0 ? "补细节" : "本段无需修改" }],
      revisedText,
    })),
    parentFeedbacks: [],
  };
}

function reviewed(source: Parameters<typeof planModelEssaySync>[0]) {
  return planModelEssaySync({
    teacherReviewedAt: "2026-08-22T06:00:00.000Z",
    ...source,
  });
}

describe("以完整范文统一段落范文", () => {
  const essay = ["开篇改后。", "抑。", "扬。", "真相。", "结尾感悟。"];

  it("段数相同但文字不同时，只按完整范文覆盖改后全段", () => {
    const source = report(essay, ["开篇。", "抑。", "扬。", "真相。", "结尾。"]);
    source.paragraphReviews[0] = {
      ...source.paragraphReviews[0]!,
      sourceParagraphStart: 1,
      sourceParagraphEnd: 2,
    };
    const plan = reviewed({
      id: "review-text",
      studentName: "任思蔚",
      title: "那一刻，我长大了",
      structureRequirements: "严格五段",
      report: source,
    });
    expect(plan.status).toBe("change");
    if (plan.status !== "change") return;
    expect(plan.change.beforeEssayCount).toBe(5);
    expect(plan.change.beforeReviewCount).toBe(5);
    expect(plan.change.afterEssayCount).toBe(5);
    expect(plan.change.afterReviewCount).toBe(5);
    expect(plan.change.report.rewrittenEssay).toEqual(essay);
    expect(plan.change.report.paragraphReviews.map((item) => item.revisedText)).toEqual(essay);
    expect(plan.change.report.paragraphReviews[0]).toMatchObject({
      suggestions: [{ advice: "补细节" }],
      sourceParagraphStart: 1,
      sourceParagraphEnd: 2,
    });
    expect(plan.change.summary).toContain("内容不一致");
    expect(plan.change.summary).toContain("段数保持 5");
  });

  it("段数相同的七段即使结构要求写五段，也保持七段只改文字", () => {
    const seven = ["一。", "二。", "三。", "四。", "五。", "六。", "七。"];
    const plan = reviewed({
      id: "review-seven",
      studentName: "王若宁",
      title: "为自己鼓掌",
      structureRequirements: "严格五段",
      report: report(seven, ["旧一。", "二。", "三。", "四。", "五。", "六。", "七。"]),
    });
    expect(plan.status).toBe("change");
    if (plan.status !== "change") return;
    expect(plan.change.afterEssayCount).toBe(7);
    expect(plan.change.afterReviewCount).toBe(7);
    expect(plan.change.report.rewrittenEssay).toEqual(seven);
    expect(plan.change.report.paragraphReviews.map((item) => item.revisedText)).toEqual(seven);
  });

  it("完整范文已是五段、段落范文更多时，段落范文改成这五段并覆盖全部原文", () => {
    const plan = reviewed({
      id: "review-count",
      studentName: "喻佳妍",
      title: "那一刻，我长大了",
      structureRequirements: "严格五段",
      report: report(essay, ["旧一", "旧二", "旧三", "旧四", "旧五", "旧六", "旧七"]),
    });
    expect(plan.status).toBe("change");
    if (plan.status !== "change") return;
    expect(plan.change).toMatchObject({
      beforeEssayCount: 5,
      beforeReviewCount: 7,
      afterEssayCount: 5,
      afterReviewCount: 5,
    });
    expect(plan.change.report.rewrittenEssay).toEqual(essay);
    expect(plan.change.report.paragraphReviews.map((item) => item.revisedText)).toEqual(essay);
    const ids = Array.from({ length: 7 }, (_, index) => `paragraph-${index + 1}`);
    expect(paragraphReviewCoverageMessage(plan.change.report.paragraphReviews, ids)).toBeNull();
    expect(plan.change.report.paragraphReviews.map((item) => item.paragraphId)).toEqual([
      "paragraph-1",
      "paragraph-3",
      "paragraph-5",
      "paragraph-6",
      "paragraph-7",
    ]);
    expect(plan.change.report.paragraphReviews[0]?.suggestions).toEqual([
      { advice: "1. 补细节\n2. 本段无需修改" },
    ]);
    expect(plan.change.summary).toContain("段数不同");
    expect(plan.change.summary).toContain("正文不改");
  });

  it("两边段数都不是五段时，按完整范文切成五段且原文不丢字", () => {
    const longer = ["甲。", "乙。", "丙。", "丁。", "戊。", "己。", "庚。", "辛。"];
    const plan = reviewed({
      id: "review-merge",
      studentName: "刘忆欣",
      title: "那一刻，我长大了",
      report: report(longer, ["旧一", "旧二", "旧三"]),
      ocrParagraphIds: ["paragraph-1", "paragraph-2", "paragraph-3", "paragraph-4", "paragraph-5", "paragraph-6"],
    });
    expect(plan.status).toBe("change");
    if (plan.status !== "change") return;
    expect(plan.change.afterEssayCount).toBe(5);
    expect(plan.change.afterReviewCount).toBe(5);
    const next = plan.change.report.rewrittenEssay ?? [];
    expect(next.join("")).toBe(longer.join(""));
    expect(plan.change.report.paragraphReviews.map((item) => item.revisedText)).toEqual(next);
    expect(plan.change.summary).toContain("按原文切成 5 段");
  });

  it("结构要求写明三段时，段数不同按三段而不是五段", () => {
    expect(explicitStructureParagraphCount("改为三段")).toBe(3);
    expect(modelEssayParagraphCount("写一件事")).toBe(5);
    const plan = reviewed({
      id: "review-three",
      studentName: "徐嘉芊",
      title: "那一刻，我长大了",
      structureRequirements: "改为三段",
      report: report(["甲。乙。丙。丁。戊。"], ["旧一", "旧二"]),
      ocrParagraphIds: ["paragraph-1", "paragraph-2", "paragraph-3", "paragraph-4"],
    });
    expect(plan.status).toBe("change");
    if (plan.status !== "change") return;
    expect(plan.change.afterEssayCount).toBe(3);
    expect(plan.change.report.paragraphReviews.map((item) => item.revisedText)).toEqual(["甲。乙。", "丙。丁。", "戊。"]);
  });

  it("原文不足目标段数时不写入，已经一致或未审核的跳过", () => {
    const blocked = reviewed({
      id: "review-short",
      studentName: "杨宇宸",
      title: "那一刻，我长大了",
      report: report(["甲。乙。丙。丁。戊。己。"], ["只有一段", "另一段"]),
      ocrParagraphIds: ["paragraph-1", "paragraph-2", "paragraph-3"],
    });
    expect(blocked).toMatchObject({
      status: "blocked",
      reason: expect.stringContaining("原文只有 3 段"),
    });
    expect(reviewed({
      id: "review-same",
      studentName: "张宸熙",
      title: "那一刻，我长大了",
      report: report(essay, essay),
    })).toEqual({ status: "unchanged" });
    expect(planModelEssaySync({
      id: "review-open",
      studentName: "顾靖芊",
      title: "那一刻，我长大了",
      teacherReviewedAt: null,
      report: report(essay, ["旧"]),
    })).toEqual({ status: "out_of_scope" });
    expect(reviewed({
      id: "review-legacy",
      studentName: "王若宁",
      title: "为自己鼓掌",
      report: { sampleParagraphs: [{ title: "示例", text: "旧正文", suggestion: "补充" }] },
    })).toMatchObject({ status: "skipped" });
  });

  it("从 OCR 检查点读取原文段落 id", () => {
    expect(ocrParagraphIdsFromCheckpoint({
      paragraphs: [{ id: "paragraph-1" }, { text: "无 id" }],
    })).toEqual(["paragraph-1", "paragraph-2"]);
    expect(ocrParagraphIdsFromCheckpoint(null)).toBeNull();
  });
});
