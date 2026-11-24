// @vitest-environment node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { assignmentConfigSchema, type ParagraphEvaluationReport } from "../domain/contracts";
import {
  exportBenchmarkModelInputs,
  QUALITY_BENCHMARK_SAMPLES,
} from "./benchmark-samples";
import {
  BlindComparisonValidationError,
  createBlindComparisonPack,
  summarizeBlindDecisions,
  type BenchmarkVariantOutput,
} from "./blind-comparison";

function mockReportForSample(
  sampleIndex: number,
  paragraphCount: number,
  tag: string,
): ParagraphEvaluationReport {
  return {
    version: 2,
    themeFit: sampleIndex === 3 ? "off_topic" : "fits",
    grade: sampleIndex === 3 ? "C" : "B+",
    painPoints: [],
    commonIssues: [],
    revisionSuggestions: [],
    parentFeedbacks: [],
    paragraphReviews: Array.from({ length: paragraphCount }, (_, idx) => ({
      paragraphId: `paragraph-${idx + 1}`,
      suggestions: [{ advice: `${tag}建议动作${idx + 1}`, revisedQuotes: [] }],
      revisedText: `${tag}改后第${idx + 1}段正文。`,
    })),
  };
}

describe("批改质量 12 篇固定样文与双版本盲评对照", () => {
  it("包含 12 篇纯虚构样文，且导出的纯模型输入严格剥离 teacherExpectations 防评判泄露", () => {
    expect(QUALITY_BENCHMARK_SAMPLES).toHaveLength(12);

    const ids = new Set<string>();
    const categories = new Set<string>();
    const grades = new Set<string>();

    for (const sample of QUALITY_BENCHMARK_SAMPLES) {
      expect(sample.fictional).toBe(true);
      expect(ids.has(sample.id)).toBe(false);
      ids.add(sample.id);
      categories.add(sample.category);
      grades.add(sample.config.grade);

      expect(() => assignmentConfigSchema.parse(sample.config)).not.toThrow();
      expect(sample.paragraphs.length).toBeGreaterThanOrEqual(3);
      sample.paragraphs.forEach((paragraph, idx) => {
        expect(paragraph.id).toBe(`paragraph-${idx + 1}`);
        expect(paragraph.text.trim().length).toBeGreaterThan(10);
      });

      expect(sample.teacherExpectations.mustPreserveFacts.length).toBeGreaterThan(0);
      expect(sample.teacherExpectations.knownPitfalls.length).toBeGreaterThan(0);
    }

    expect(categories.has("cross_page")).toBe(true);
    expect(categories.has("colloquial")).toBe(true);
    expect(categories.has("off_topic_or_partial")).toBe(true);
    expect(categories.has("logic_check")).toBe(true);
    expect(grades.size).toBeGreaterThanOrEqual(5);

    const modelInputs = exportBenchmarkModelInputs();
    expect(modelInputs).toHaveLength(12);
    const serializedInputs = JSON.stringify(modelInputs);
    expect(serializedInputs).not.toContain("teacherExpectations");
    expect(serializedInputs).not.toContain("mustPreserveFacts");
    expect(serializedInputs).not.toContain("knownPitfalls");
    expect(serializedInputs).not.toContain("focusCheckpoints");
    expect(serializedInputs).not.toContain("acceptableThemeFit");
    expect(serializedInputs).not.toMatch(/off-topic|off_topic|contradiction|colloquial|linebreak|cross-page|hollow|grouping/iu);
    for (const entry of modelInputs) {
      expect(entry.id).toMatch(/^essay-\d{2}$/u);
      expect(Object.keys(entry).sort()).toEqual(["config", "id", "paragraphs"]);
    }
  });

  it("盲评模板默认为未填写状态；原样汇总空白模板、漏评或重复样文均会报错拒绝生成结论", () => {
    const baselineOutputs: BenchmarkVariantOutput[] = QUALITY_BENCHMARK_SAMPLES.map((sample, index) => ({
      sampleId: sample.id,
      report: mockReportForSample(index, sample.paragraphs.length, "旧版内容"),
    }));
    const candidateOutputs: BenchmarkVariantOutput[] = QUALITY_BENCHMARK_SAMPLES.map((sample, index) => ({
      sampleId: sample.id,
      report: mockReportForSample(index, sample.paragraphs.length, "新版内容"),
    }));

    const pack = createBlindComparisonPack({
      samples: QUALITY_BENCHMARK_SAMPLES,
      baselineOutputs,
      candidateOutputs,
      seed: "prompt-v2-vs-v3",
      baselineLabel: "secret-model-alpha",
      candidateLabel: "secret-model-beta",
    });

    expect(pack.blindSheetMarkdown).not.toContain("secret-model-alpha");
    expect(pack.blindSheetMarkdown).not.toContain("secret-model-beta");
    expect(pack.blindSheetMarkdown).toContain(pack.manifest.packId);
    expect(pack.decisionsTemplate.packId).toBe(pack.manifest.packId);
    expect(pack.decisionsTemplate.decisions[0]?.preferred).toBeNull();
    expect(pack.decisionsTemplate.decisions[0]?.甲.misjudgedSource).toBeNull();

    // 0. 传入空 assignments 的伪造/残缺 manifest 与空决策数组 -> 必须对照 12 篇固定基准拒绝汇总
    try {
      summarizeBlindDecisions({ ...pack.manifest, assignments: [] }, { packId: pack.manifest.packId, decisions: [] });
      expect.unreachable("should have rejected empty manifest assignments");
    } catch (error) {
      expect(error).toBeInstanceOf(BlindComparisonValidationError);
      const validation = error as BlindComparisonValidationError;
      expect(validation.details.missingSampleIds).toHaveLength(12);
    }

    // 1. 直接原样汇总未填写的空白模板 -> 必须抛出验证异常且列出全部 12 篇未填完样文
    expect(() => summarizeBlindDecisions(pack.manifest, pack.decisionsTemplate)).toThrow(BlindComparisonValidationError);
    try {
      summarizeBlindDecisions(pack.manifest, pack.decisionsTemplate);
    } catch (error) {
      expect(error).toBeInstanceOf(BlindComparisonValidationError);
      const validation = error as BlindComparisonValidationError;
      expect(validation.details.incompleteSamples).toHaveLength(12);
    }

    // 2. 构造完整有效评价并验证揭盲统计
    const validDecisionItems = pack.manifest.assignments.map((assignment, index) => {
      const candidateSlot = assignment.slotMap.甲 === "candidate" ? "甲" : "乙";
      const baselineSlot = candidateSlot === "甲" ? "乙" : "甲";
      const templateItem = pack.decisionsTemplate.decisions[index]!;
      return {
        sampleId: assignment.sampleId,
        contentDigest: templateItem.contentDigest,
        [candidateSlot]: {
          misjudgedSource: false,
          preservedStudentIntent: true,
          actionableForStudent: true,
        },
        [baselineSlot]: {
          misjudgedSource: index < 3,
          preservedStudentIntent: index >= 2,
          actionableForStudent: index >= 4,
        },
        preferred: index === 11 ? ("tie" as const) : candidateSlot,
      } as {
        sampleId: string;
        contentDigest: string;
        甲: { misjudgedSource: boolean; preservedStudentIntent: boolean; actionableForStudent: boolean };
        乙: { misjudgedSource: boolean; preservedStudentIntent: boolean; actionableForStudent: boolean };
        preferred: "甲" | "乙" | "tie";
      };
    });
    const validDecisions = {
      packId: pack.manifest.packId,
      decisions: validDecisionItems,
    };

    // 3. 重复第 1 篇并漏掉第 2 篇（总数仍为 12）-> 必须报错指出重复与缺失 ID
    const duplicatedAndMissing = {
      packId: pack.manifest.packId,
      decisions: [validDecisionItems[0]!, ...validDecisionItems.slice(0, 1), ...validDecisionItems.slice(2)],
    };
    expect(duplicatedAndMissing.decisions).toHaveLength(12);
    try {
      summarizeBlindDecisions(pack.manifest, duplicatedAndMissing);
      expect.unreachable("should have rejected duplicate and missing sample IDs");
    } catch (error) {
      expect(error).toBeInstanceOf(BlindComparisonValidationError);
      const validation = error as BlindComparisonValidationError;
      expect(validation.details.duplicateSampleIds).toEqual([validDecisionItems[0]!.sampleId]);
      expect(validation.details.missingSampleIds).toEqual([validDecisionItems[1]!.sampleId]);
    }

    // 3.5 篡改揭盲清单的甲/乙槽位映射（与 seed 确定性映射不符）-> 必须拦截报错，防止颠倒候选与基线胜率
    const swappedManifest = {
      ...pack.manifest,
      assignments: pack.manifest.assignments.map((assignment, idx) => (
        idx === 0
          ? {
              ...assignment,
              slotMap: {
                甲: assignment.slotMap.乙,
                乙: assignment.slotMap.甲,
              },
            }
          : assignment
      )),
    };
    expect(() => summarizeBlindDecisions(swappedManifest, validDecisions)).toThrow(BlindComparisonValidationError);

    // 3.6 跨评审包防混用：同一套 12 篇样文生成另一轮合法清单（不同 seed 或不同输出），混交第一轮评分表必须明确报错，绝不把 11 胜翻成负结论
    const round2PackDifferentSeed = createBlindComparisonPack({
      samples: QUALITY_BENCHMARK_SAMPLES,
      baselineOutputs,
      candidateOutputs,
      seed: "prompt-round-2-opposite-seed",
      baselineLabel: "secret-model-alpha",
      candidateLabel: "secret-model-beta",
    });
    expect(round2PackDifferentSeed.manifest.packId).not.toBe(pack.manifest.packId);
    expect(() => summarizeBlindDecisions(round2PackDifferentSeed.manifest, validDecisions)).toThrow(BlindComparisonValidationError);

    const round3PackSameSeedDifferentOutput = createBlindComparisonPack({
      samples: QUALITY_BENCHMARK_SAMPLES,
      baselineOutputs,
      candidateOutputs: QUALITY_BENCHMARK_SAMPLES.map((sample, index) => ({
        sampleId: sample.id,
        report: mockReportForSample(index, sample.paragraphs.length, "第三轮新版内容"),
      })),
      seed: "prompt-v2-vs-v3",
    });
    expect(round3PackSameSeedDifferentOutput.manifest.packId).not.toBe(pack.manifest.packId);
    expect(() => summarizeBlindDecisions(round3PackSameSeedDifferentOutput.manifest, validDecisions)).toThrow(BlindComparisonValidationError);

    // 3.7 生成器输入严格校验：传入「12 篇 + 1 条重复 ID + 1 条未知 ID」必须明确报错，绝不静默覆盖或产出残缺对照包
    expect(() => createBlindComparisonPack({
      samples: QUALITY_BENCHMARK_SAMPLES,
      baselineOutputs: [
        ...baselineOutputs,
        { sampleId: QUALITY_BENCHMARK_SAMPLES[0]!.id, report: mockReportForSample(0, QUALITY_BENCHMARK_SAMPLES[0]!.paragraphs.length, "静默覆盖版") },
        { sampleId: "essay-99-unknown", report: mockReportForSample(0, 3, "未知样文") },
      ],
      candidateOutputs,
      seed: "strict-input-check",
    })).toThrow(BlindComparisonValidationError);

    // 3.8 匿名对照表完整性：两版仅在审题理由（themeReason）、四维诊断或具体问题（problem）有差异时，盲评 Markdown 表必须可见全部差异且不泄露身份
    const subtleDiffPack = createBlindComparisonPack({
      samples: QUALITY_BENCHMARK_SAMPLES,
      baselineOutputs: QUALITY_BENCHMARK_SAMPLES.map((sample, index) => ({
        sampleId: sample.id,
        report: {
          ...mockReportForSample(index, sample.paragraphs.length, "同文正文"),
          themeReason: index === 0 ? "旧版独有审题理由：围绕舞台紧张展开。" : "常规切题。",
          diagnostics: {
            authenticityAndRelevance: { finding: "旧版真实性发现", action: "旧版真实性动作" },
            materialAndDetails: { finding: "选材一般", action: "补细节" },
            structure: { finding: "结构平直", action: "补波澜" },
            language: { finding: "语言自然", action: "保留" },
          },
          paragraphReviews: sample.paragraphs.map((_, idx) => ({
            paragraphId: `paragraph-${idx + 1}`,
            suggestions: [{ problem: "旧版指出段落铺垫偏慢", advice: "精简前两句", example: "旧版参考示例句", revisedQuotes: [] }],
            revisedText: `同文第${idx + 1}段。`,
          })),
        },
      })),
      candidateOutputs: QUALITY_BENCHMARK_SAMPLES.map((sample, index) => ({
        sampleId: sample.id,
        report: {
          ...mockReportForSample(index, sample.paragraphs.length, "同文正文"),
          themeReason: index === 0 ? "新版独有审题理由：紧扣犹豫后的突破。" : "常规切题。",
          diagnostics: {
            authenticityAndRelevance: { finding: "新版真实性发现", action: "新版真实性动作" },
            materialAndDetails: { finding: "选材一般", action: "补细节" },
            structure: { finding: "结构平直", action: "补波澜" },
            language: { finding: "语言自然", action: "保留" },
          },
          paragraphReviews: sample.paragraphs.map((_, idx) => ({
            paragraphId: `paragraph-${idx + 1}`,
            suggestions: [{ problem: "新版指出动作链缺失", advice: "精简前两句", example: "新版参考示例句", revisedQuotes: [] }],
            revisedText: `同文第${idx + 1}段。`,
          })),
        },
      })),
      seed: "subtle-diff-seed",
      baselineLabel: "hidden-base-v1",
      candidateLabel: "hidden-cand-v2",
    });
    expect(subtleDiffPack.blindSheetMarkdown).toContain("旧版独有审题理由：围绕舞台紧张展开。");
    expect(subtleDiffPack.blindSheetMarkdown).toContain("新版独有审题理由：紧扣犹豫后的突破。");
    expect(subtleDiffPack.blindSheetMarkdown).toContain("旧版真实性发现");
    expect(subtleDiffPack.blindSheetMarkdown).toContain("新版真实性发现");
    expect(subtleDiffPack.blindSheetMarkdown).toContain("旧版指出段落铺垫偏慢");
    expect(subtleDiffPack.blindSheetMarkdown).toContain("新版指出动作链缺失");
    expect(subtleDiffPack.blindSheetMarkdown).not.toContain("hidden-base-v1");
    expect(subtleDiffPack.blindSheetMarkdown).not.toContain("hidden-cand-v2");

    // 3.9 报告契约严格校验：12 个 ID 全部正确但报告为 { version: 2, paragraphReviews: [] } 等违反契约对象时，函数与真实 CLI 均必须报错指明版本与样文 ID，不生成评审包
    const hollowOutputs = QUALITY_BENCHMARK_SAMPLES.map((sample) => ({
      sampleId: sample.id,
      report: { version: 2, paragraphReviews: [] } as unknown as ParagraphEvaluationReport,
    }));
    try {
      createBlindComparisonPack({
        samples: QUALITY_BENCHMARK_SAMPLES,
        baselineOutputs,
        candidateOutputs: hollowOutputs,
        candidateLabel: "hollow-cand-v9",
      });
      expect.unreachable("should have rejected invalid paragraph report contract");
    } catch (error) {
      expect(error).toBeInstanceOf(BlindComparisonValidationError);
      const validation = error as BlindComparisonValidationError;
      expect(validation.message).toContain("candidate: hollow-cand-v9");
      expect(validation.message).toContain("essay-01");
      expect(validation.details.incompleteSamples).toHaveLength(12);
    }

    const cliTmp = mkdtempSync(path.join(os.tmpdir(), "blind-cli-invalid-"));
    try {
      const basePath = path.join(cliTmp, "base.json");
      const candPath = path.join(cliTmp, "cand.json");
      const outPackDir = path.join(cliTmp, "out-pack");
      writeFileSync(basePath, JSON.stringify(hollowOutputs), "utf8");
      writeFileSync(candPath, JSON.stringify(hollowOutputs), "utf8");

      const cliRes = spawnSync(
        process.execPath,
        [
          path.resolve(__dirname, "../../node_modules/tsx/dist/cli.mjs"),
          path.resolve(__dirname, "../../scripts/compare-review-quality.ts"),
          "--baseline", basePath,
          "--candidate", candPath,
          "--out", outPackDir,
        ],
        { encoding: "utf8", cwd: path.resolve(__dirname, "../..") },
      );
      expect(cliRes.status).toBe(1);
      expect(cliRes.stderr).toContain("baseline");
      expect(cliRes.stderr).toContain("essay-01");
      expect(existsSync(outPackDir)).toBe(false);
    } finally {
      rmSync(cliTmp, { recursive: true, force: true });
    }

    // 3.95 版本标签身份防篡改与家长沟通反馈完整渲染：
    //   a) 保持报告、槽位和评分不变，仅对调 manifest 中的 baselineLabel 与 candidateLabel，揭盲必须拒绝汇总，绝不把候选 11 胜挂到基线名下；
    const swappedLabelsManifest = {
      ...pack.manifest,
      baselineLabel: pack.manifest.candidateLabel,
      candidateLabel: pack.manifest.baselineLabel,
    };
    expect(() => summarizeBlindDecisions(swappedLabelsManifest, validDecisions)).toThrow(BlindComparisonValidationError);

    //   b) 包含契约允许的三条结构化家长沟通反馈（warm / professional / concise）时，盲评表必须逐项呈现标题与正文，绝不出现 [object Object]
    const parentFeedbackPack = createBlindComparisonPack({
      samples: QUALITY_BENCHMARK_SAMPLES,
      baselineOutputs: QUALITY_BENCHMARK_SAMPLES.map((sample, index) => ({
        sampleId: sample.id,
        report: {
          ...mockReportForSample(index, sample.paragraphs.length, "旧版"),
          parentFeedbacks: index === 0 ? [
            { style: "warm", title: "旧版暖心鼓励标题", content: "旧版暖心反馈正文：肯定孩子敢于记录台前犹豫。" },
            { style: "professional", title: "旧版专业诊断标题", content: "旧版专业反馈正文：建议强化中段动作细节链。" },
            { style: "concise", title: "旧版简明行动标题", content: "旧版简明反馈正文：今晚补写两句手部动作。" },
          ] : [],
        },
      })),
      candidateOutputs: QUALITY_BENCHMARK_SAMPLES.map((sample, index) => ({
        sampleId: sample.id,
        report: {
          ...mockReportForSample(index, sample.paragraphs.length, "新版"),
          parentFeedbacks: index === 0 ? [
            { style: "warm", title: "新版暖心鼓励标题", content: "新版暖心反馈正文：先表扬真实心理描写。" },
            { style: "professional", title: "新版专业诊断标题", content: "新版专业反馈正文：转折段铺垫可再聚焦。" },
            { style: "concise", title: "新版简明行动标题", content: "新版简明反馈正文：对照第 2 段补一句呼吸变化。" },
          ] : [],
        },
      })),
      seed: "parent-feedback-render-seed",
      baselineLabel: "pf-base-v1",
      candidateLabel: "pf-cand-v2",
    });
    expect(parentFeedbackPack.blindSheetMarkdown).not.toContain("[object Object]");
    expect(parentFeedbackPack.blindSheetMarkdown).toContain("旧版暖心鼓励标题");
    expect(parentFeedbackPack.blindSheetMarkdown).toContain("旧版暖心反馈正文：肯定孩子敢于记录台前犹豫。");
    expect(parentFeedbackPack.blindSheetMarkdown).toContain("新版简明行动标题");
    expect(parentFeedbackPack.blindSheetMarkdown).toContain("新版简明反馈正文：对照第 2 段补一句呼吸变化。");

    // 4. 全部唯一且完整填写时正常揭盲汇总
    const summary = summarizeBlindDecisions(pack.manifest, validDecisions);
    expect(summary.totalSamples).toBe(12);
    expect(summary.ties).toBe(1);
    expect(summary.candidate).toEqual({
      totalEvaluated: 12,
      noMisjudgmentCount: 12,
      preservedIntentCount: 12,
      actionableCount: 12,
      preferredWins: 11,
    });
    expect(summary.baseline).toEqual({
      totalEvaluated: 12,
      noMisjudgmentCount: 9,
      preservedIntentCount: 10,
      actionableCount: 8,
      preferredWins: 0,
    });
  });
});
