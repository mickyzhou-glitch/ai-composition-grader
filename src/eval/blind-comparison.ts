import { createHash } from "node:crypto";

import { deliveryReadiness } from "../delivery/readiness";
import {
  paragraphEvaluationReportSchema,
  type ParagraphEvaluationReport,
} from "../domain/contracts";
import {
  QUALITY_BENCHMARK_SAMPLES,
  type QualityBenchmarkSample,
} from "./benchmark-samples";

export type BlindSlot = "甲" | "乙";
export type VariantKey = "baseline" | "candidate";

export interface BenchmarkVariantOutput {
  sampleId: string;
  report: ParagraphEvaluationReport;
}

export interface BlindSampleAssignment {
  sampleId: string;
  slotMap: {
    甲: VariantKey;
    乙: VariantKey;
  };
  slotDigests: {
    甲: string;
    乙: string;
  };
}

export interface BlindComparisonManifest {
  version: 1;
  packId: string;
  createdAt: string;
  seed: string;
  baselineLabel: string;
  candidateLabel: string;
  assignments: BlindSampleAssignment[];
}

export interface TeacherSlotRating {
  /** 1. 是否误判原文（true = 存在误判，false = 无误判） */
  misjudgedSource: boolean;
  /** 2. 是否保留孩子原意（true = 保留原意，false = 改掉原意/成人腔替写） */
  preservedStudentIntent: boolean;
  /** 3. 学生看完是否知道下一步怎么改（true = 清楚可操作，false = 空泛不可操作） */
  actionableForStudent: boolean;
}

export interface TeacherSlotRatingDraft {
  misjudgedSource: boolean | null;
  preservedStudentIntent: boolean | null;
  actionableForStudent: boolean | null;
}

export interface TeacherSampleDecisionDraft {
  sampleId: string;
  contentDigest: string;
  甲: TeacherSlotRatingDraft;
  乙: TeacherSlotRatingDraft;
  preferred: BlindSlot | "tie" | null;
  note?: string;
}

export interface TeacherSampleDecision {
  sampleId: string;
  contentDigest: string;
  甲: TeacherSlotRating;
  乙: TeacherSlotRating;
  preferred: BlindSlot | "tie";
  note?: string;
}

export interface BlindDecisionsDocumentDraft {
  packId: string;
  decisions: TeacherSampleDecisionDraft[];
}

export interface BlindDecisionsDocument {
  packId: string;
  decisions: TeacherSampleDecision[];
}

export interface VariantScoreSummary {
  totalEvaluated: number;
  noMisjudgmentCount: number;
  preservedIntentCount: number;
  actionableCount: number;
  preferredWins: number;
}

export interface BlindComparisonSummary {
  totalSamples: number;
  ties: number;
  baseline: VariantScoreSummary;
  candidate: VariantScoreSummary;
  disclaimer: string;
}

export interface BlindDecisionValidationDetails {
  missingSampleIds: string[];
  duplicateSampleIds: string[];
  unknownSampleIds: string[];
  incompleteSamples: Array<{ sampleId: string; missingFields: string[] }>;
}

export class BlindComparisonValidationError extends Error {
  constructor(
    message: string,
    readonly details: BlindDecisionValidationDetails,
  ) {
    super(message);
    this.name = "BlindComparisonValidationError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries = keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function computeBlindPackId(
  seed: string,
  assignments: readonly BlindSampleAssignment[],
  labels: { baselineLabel: string; candidateLabel: string },
): string {
  const normalized = assignments.map((item) => ({
    sampleId: item.sampleId,
    slotMap: { 甲: item.slotMap.甲, 乙: item.slotMap.乙 },
    slotDigests: { 甲: item.slotDigests.甲, 乙: item.slotDigests.乙 },
  }));
  return `blindpack-${sha256Hex(canonicalJson({
    version: 1,
    seed,
    baselineLabel: labels.baselineLabel.trim(),
    candidateLabel: labels.candidateLabel.trim(),
    assignments: normalized,
  })).slice(0, 32)}`;
}

export function computeSampleDecisionDigest(
  packId: string,
  sampleId: string,
  slotDigests: { 甲: string; 乙: string },
): string {
  return sha256Hex(`${packId}:${sampleId}:${slotDigests.甲}:${slotDigests.乙}`).slice(0, 24);
}

function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function assignBlindSlots(sampleId: string, seed: string): { 甲: VariantKey; 乙: VariantKey } {
  const bit = hashSeed(`${seed}::${sampleId}`) & 1;
  return bit === 0
    ? { 甲: "baseline", 乙: "candidate" }
    : { 甲: "candidate", 乙: "baseline" };
}

function renderVariantBlock(slot: BlindSlot, report: ParagraphEvaluationReport): string {
  const lines: string[] = [
    `#### 版本${slot}`,
    `- **审题与等级**：\`${report.themeFit}\` · 等级 \`${report.grade ?? "未标"}\``,
  ];
  if (report.themeReason?.trim()) {
    lines.push(`- **审题理由**：${report.themeReason.trim()}`);
  }
  if (report.personalizedComment?.trim()) {
    lines.push(`- **个性化整体评语**：${report.personalizedComment.trim()}`);
  }
  if (report.diagnostics) {
    const d = report.diagnostics;
    lines.push("- **四维诊断**：");
    if (d.authenticityAndRelevance) {
      lines.push(`  - 真实与切题：${d.authenticityAndRelevance.finding} → 动作：${d.authenticityAndRelevance.action}`);
    }
    if (d.materialAndDetails) {
      lines.push(`  - 选材与细节：${d.materialAndDetails.finding} → 动作：${d.materialAndDetails.action}`);
    }
    if (d.structure) {
      lines.push(`  - 结构推进：${d.structure.finding} → 动作：${d.structure.action}`);
    }
    if (d.language) {
      lines.push(`  - 语言表达：${d.language.finding} → 动作：${d.language.action}`);
    }
  }
  if (report.painPoints && report.painPoints.length > 0) {
    lines.push(`- **核心痛点**：${report.painPoints.join("；")}`);
  }
  if (report.commonIssues && report.commonIssues.length > 0) {
    lines.push(`- **共性问题**：${report.commonIssues.join("；")}`);
  }
  if (report.revisionSuggestions && report.revisionSuggestions.length > 0) {
    lines.push(`- **整体修改建议**：${report.revisionSuggestions.join("；")}`);
  }
  if (report.parentFeedbacks && report.parentFeedbacks.length > 0) {
    const styleLabels: Record<string, string> = {
      warm: "温和鼓励版",
      professional: "专业客观版",
      concise: "简明行动版",
    };
    lines.push("- **家长沟通反馈**：");
    for (const feedback of report.parentFeedbacks) {
      const styleLabel = styleLabels[feedback.style] ?? feedback.style;
      lines.push(`  - 【${styleLabel}】${feedback.title}：${feedback.content}`);
    }
  }
  if (report.teacherGuidanceDraft?.trim()) {
    lines.push(`- **教师复核提示草稿**：${report.teacherGuidanceDraft.trim()}`);
  }
  report.paragraphReviews.forEach((item, index) => {
    const rangeLabel = item.noSourceParagraph
      ? "新增段落（无对应原文）"
      : item.sourceParagraphStart !== undefined && item.sourceParagraphEnd !== undefined
        ? (item.sourceParagraphStart === item.sourceParagraphEnd
            ? `对应原文第 ${item.sourceParagraphStart} 段`
            : `对应原文第 ${item.sourceParagraphStart}–${item.sourceParagraphEnd} 段`)
        : `对应 ${item.paragraphId}`;
    lines.push(`- **第 ${index + 1} 框（${rangeLabel}）**`);
    item.suggestions.forEach((suggestion, sIdx) => {
      const prefix = item.suggestions.length > 1 ? `建议 ${sIdx + 1}：` : "";
      if (suggestion.problem?.trim()) {
        lines.push(`  - ${prefix}具体问题：${suggestion.problem.trim()}`);
      }
      lines.push(`  - ${prefix}修改动作：${suggestion.advice}`);
      if (suggestion.example?.trim()) {
        lines.push(`  - ${prefix}参考示例：${suggestion.example.trim()}`);
      }
      if (suggestion.revisedQuotes && suggestion.revisedQuotes.length > 0) {
        const formattedQuotes = suggestion.revisedQuotes
          .map((quote) => (Array.isArray(quote) ? quote.filter(Boolean).join(" + ") : quote))
          .filter(Boolean);
        if (formattedQuotes.length > 0) {
          lines.push(`  - ${prefix}高亮改句：${formattedQuotes.join(" / ")}`);
        }
      }
    });
    lines.push(`  - 改后全段：${item.revisedText}`);
  });
  if (report.rewrittenEssay && report.rewrittenEssay.length > 0) {
    lines.push(`- **完整改后范文**：${report.rewrittenEssay.join(" / ")}`);
  }
  return lines.join("\n");
}

function validateVariantOutputsForPack(
  variantRole: string,
  outputs: readonly BenchmarkVariantOutput[],
  samples: readonly Pick<QualityBenchmarkSample, "id" | "paragraphs">[],
): Map<string, ParagraphEvaluationReport> {
  if (!Array.isArray(outputs) || samples.length === 0) {
    throw new BlindComparisonValidationError(
      `${variantRole}模型输出数据格式无效（必须为非空数组），拒绝生成盲评包`,
      {
        missingSampleIds: samples.map((s) => s.id),
        duplicateSampleIds: [],
        unknownSampleIds: [],
        incompleteSamples: [],
      },
    );
  }
  const expectedIds = samples.map((s) => s.id);
  const sampleById = new Map(samples.map((s) => [s.id, s]));
  const seenCounts = new Map<string, number>();
  const unknownSampleIds: string[] = [];
  const invalidReports: Array<{ sampleId: string; missingFields: string[] }> = [];
  const byId = new Map<string, ParagraphEvaluationReport>();

  for (const item of outputs) {
    const id = typeof item?.sampleId === "string" ? item.sampleId : "";
    const targetSample = sampleById.get(id);
    if (!targetSample) {
      unknownSampleIds.push(id || "<empty>");
      continue;
    }
    seenCounts.set(id, (seenCounts.get(id) ?? 0) + 1);
    const parsedReport = paragraphEvaluationReportSchema.safeParse(item.report);
    if (!parsedReport.success) {
      const issueFields = parsedReport.error.issues.map((issue) => (
        issue.path.length > 0 ? `report.${issue.path.join(".")}` : `report(${issue.message})`
      ));
      invalidReports.push({
        sampleId: id,
        missingFields: issueFields.length > 0 ? issueFields : ["report"],
      });
      continue;
    }
    const syntheticOcr = {
      version: 2 as const,
      ocrRevision: 1,
      editedAt: null,
      pages: [{
        pageIndex: 0,
        text: targetSample.paragraphs.map((p) => p.text).join("\n"),
        readable: true,
        warnings: [],
      }],
      paragraphs: targetSample.paragraphs.map((p, pIdx) => ({
        id: p.id,
        paragraphIndex: pIdx,
        text: p.text,
        segments: [{ pageIndex: 0, x: 0.1, y: 0.1, width: 0.8, height: 0.1 }],
      })),
    };
    const readiness = deliveryReadiness({
      report: parsedReport.data,
      teacherReviewedAt: "benchmark-check",
      reportStale: false,
      reportOcrRevision: 1,
      ocr: syntheticOcr,
      images: [{ position: 0 }],
    });
    if (!readiness.ready) {
      invalidReports.push({
        sampleId: id,
        missingFields: [`contract(${readiness.message})`],
      });
      continue;
    }
    if (!byId.has(id)) {
      byId.set(id, parsedReport.data);
    }
  }

  const missingSampleIds = expectedIds.filter((id) => !seenCounts.has(id));
  const duplicateSampleIds = [...seenCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);

  if (
    missingSampleIds.length > 0
    || duplicateSampleIds.length > 0
    || unknownSampleIds.length > 0
    || invalidReports.length > 0
  ) {
    const parts: string[] = [`${variantRole}输出未通过 12 篇基准样文与逐段报告契约校验，拒绝生成盲评包：`];
    if (missingSampleIds.length > 0) parts.push(`缺失样文(${missingSampleIds.length}): ${missingSampleIds.join(", ")}`);
    if (duplicateSampleIds.length > 0) parts.push(`重复样文(${duplicateSampleIds.length}): ${duplicateSampleIds.join(", ")}`);
    if (unknownSampleIds.length > 0) parts.push(`未知样文(${unknownSampleIds.length}): ${unknownSampleIds.join(", ")}`);
    if (invalidReports.length > 0) {
      parts.push(`报告契约不合法(${invalidReports.length}): ${invalidReports.map((r) => `${r.sampleId}[${r.missingFields.join(", ")}]`).join("; ")}`);
    }
    throw new BlindComparisonValidationError(parts.join("；"), {
      missingSampleIds,
      duplicateSampleIds,
      unknownSampleIds,
      incompleteSamples: invalidReports,
    });
  }

  return byId;
}

export function createBlindComparisonPack(input: {
  samples: readonly QualityBenchmarkSample[];
  baselineOutputs: readonly BenchmarkVariantOutput[];
  candidateOutputs: readonly BenchmarkVariantOutput[];
  seed?: string;
  baselineLabel?: string;
  candidateLabel?: string;
  createdAt?: string;
}): {
  manifest: BlindComparisonManifest;
  blindSheetMarkdown: string;
  decisionsTemplate: BlindDecisionsDocumentDraft;
} {
  const seed = input.seed ?? "2026-11-24-default-seed";
  const baselineLabel = (input.baselineLabel ?? "baseline").trim();
  const candidateLabel = (input.candidateLabel ?? "candidate").trim();
  if (!baselineLabel || !candidateLabel || baselineLabel === candidateLabel) {
    throw new BlindComparisonValidationError(
      "盲评对照包的基线版本标识（baselineLabel）与候选版本标识（candidateLabel）必须非空且互不相同，拒绝生成无法区分归属的评审包",
      {
        missingSampleIds: [],
        duplicateSampleIds: [],
        unknownSampleIds: [],
        incompleteSamples: [],
      },
    );
  }
  const baseName = input.baselineLabel ? `基线版（baseline: ${baselineLabel}）` : "基线版（baseline）";
  const candName = input.candidateLabel ? `候选版（candidate: ${candidateLabel}）` : "候选版（candidate）";
  const baselineById = validateVariantOutputsForPack(baseName, input.baselineOutputs, input.samples);
  const candidateById = validateVariantOutputsForPack(candName, input.candidateOutputs, input.samples);

  const assignments: BlindSampleAssignment[] = [];
  const bodySections: string[] = [];

  for (const [index, sample] of input.samples.entries()) {
    const baseReport = baselineById.get(sample.id);
    const candReport = candidateById.get(sample.id);
    if (!baseReport || !candReport) {
      throw new Error(`Missing benchmark output for sample: ${sample.id}`);
    }
    const slotMap = assignBlindSlots(sample.id, seed);
    const firstReport = slotMap.甲 === "baseline" ? baseReport : candReport;
    const secondReport = slotMap.乙 === "baseline" ? baseReport : candReport;
    const slotDigests = {
      甲: sha256Hex(canonicalJson(firstReport)),
      乙: sha256Hex(canonicalJson(secondReport)),
    };
    assignments.push({ sampleId: sample.id, slotMap, slotDigests });

    bodySections.push(`## 样文 ${String(index + 1).padStart(2, "0")}：${sample.label}（\`${sample.id}\`）`);
    bodySections.push(`- **适用年级与目标字数**：${sample.config.grade} · ${sample.config.targetCharacters} 字`);
    bodySections.push(`- **题目与要求**：《${sample.config.title}》——${sample.config.writingRequirements}`);
    if (sample.pageBreakNote) {
      bodySections.push(`- **版面/跨页说明**：${sample.pageBreakNote}`);
    }
    bodySections.push(`- **本篇重点观察陷阱**：${sample.teacherExpectations.knownPitfalls.join("；")}`);
    bodySections.push("");
    bodySections.push("### 学生原文（虚构样文）");
    sample.paragraphs.forEach((p, pIdx) => {
      bodySections.push(`${pIdx + 1}. ${p.text}`);
    });
    bodySections.push("");
    bodySections.push(renderVariantBlock("甲", firstReport));
    bodySections.push("");
    bodySections.push(renderVariantBlock("乙", secondReport));
    bodySections.push("");
    bodySections.push("### 教师盲评记录（三问核对）");
    bodySections.push("| 评价维度 | 版本甲 | 版本乙 |");
    bodySections.push("| --- | --- | --- |");
    bodySections.push("| 1. 是否误判原文（无误判 / 有误判） | [ ] 无误判 / [ ] 有误判 | [ ] 无误判 / [ ] 有误判 |");
    bodySections.push("| 2. 是否保留原意（保留原意 / 改掉原意） | [ ] 保留 / [ ] 改掉 | [ ] 保留 / [ ] 改掉 |");
    bodySections.push("| 3. 学生是否知道下一步怎么改（清楚 / 空泛） | [ ] 清楚 / [ ] 空泛 | [ ] 清楚 / [ ] 空泛 |");
    bodySections.push("- **本篇综合倾向**：[ ] 版本甲更合适　[ ] 版本乙更合适　[ ] 两版相近");
    bodySections.push("- **教师批注**：");
    bodySections.push("");
  }

  const packId = computeBlindPackId(seed, assignments, { baselineLabel, candidateLabel });
  const decisions: TeacherSampleDecisionDraft[] = assignments.map((assignment) => ({
    sampleId: assignment.sampleId,
    contentDigest: computeSampleDecisionDigest(packId, assignment.sampleId, assignment.slotDigests),
    // 模板初始值全部置为 null（未填写），严禁默认填入布尔值或平局结论
    甲: { misjudgedSource: null, preservedStudentIntent: null, actionableForStudent: null },
    乙: { misjudgedSource: null, preservedStudentIntent: null, actionableForStudent: null },
    preferred: null,
    note: "",
  }));

  const headerSections: string[] = [
    "# 作文批改双版本教师盲评对照表",
    "",
    `- **评审包绑定标识（Pack ID）**：\`${packId}\`（填写对应的 \`decisions.json\` 时切勿改动 \`packId\`，揭盲汇总将严格校验评分表与清单属于同一评审包）`,
    "",
    "> **使用说明（重要）**：本表已对每篇样文独立随机打乱「版本甲 / 版本乙」顺序并隐去模型与提示词标识。请一线语文老师仅对照学生原文评判三件事：**① 是否误判原文**、**② 是否保留孩子原意**、**③ 学生看完是否知道下一步怎么改**。本对照仅作换模型或改提示词前后的定性教学把关，不当作统计显著性或教学效果证明。",
    "",
  ];

  return {
    manifest: {
      version: 1,
      packId,
      createdAt: input.createdAt ?? new Date().toISOString(),
      seed,
      baselineLabel,
      candidateLabel,
      assignments,
    },
    blindSheetMarkdown: [...headerSections, ...bodySections].join("\n"),
    decisionsTemplate: {
      packId,
      decisions,
    },
  };
}

function isValidSlotMap(slotMap: unknown): slotMap is { 甲: VariantKey; 乙: VariantKey } {
  if (!slotMap || typeof slotMap !== "object") return false;
  const record = slotMap as { 甲?: unknown; 乙?: unknown };
  return (
    (record.甲 === "baseline" && record.乙 === "candidate")
    || (record.甲 === "candidate" && record.乙 === "baseline")
  );
}

function isValidSlotDigests(digests: unknown): digests is { 甲: string; 乙: string } {
  if (!digests || typeof digests !== "object") return false;
  const record = digests as { 甲?: unknown; 乙?: unknown };
  return (
    typeof record.甲 === "string"
    && /^[0-9a-f]{64}$/u.test(record.甲)
    && typeof record.乙 === "string"
    && /^[0-9a-f]{64}$/u.test(record.乙)
  );
}

function validateManifestAgainstBenchmark(
  manifest: BlindComparisonManifest,
  benchmarkSamples: readonly Pick<QualityBenchmarkSample, "id">[],
): void {
  if (
    !manifest
    || typeof manifest !== "object"
    || manifest.version !== 1
    || typeof manifest.packId !== "string"
    || !manifest.packId.trim()
    || typeof manifest.seed !== "string"
    || !manifest.seed.trim()
    || typeof manifest.baselineLabel !== "string"
    || !manifest.baselineLabel.trim()
    || typeof manifest.candidateLabel !== "string"
    || !manifest.candidateLabel.trim()
    || manifest.baselineLabel.trim() === manifest.candidateLabel.trim()
    || !Array.isArray(manifest.assignments)
    || benchmarkSamples.length === 0
  ) {
    throw new BlindComparisonValidationError(
      "盲评清单（manifest）格式无效、版本标签缺失/重复、缺失 packId / 随机种子或缺失样文分配表，拒绝揭盲汇总",
      {
        missingSampleIds: benchmarkSamples.map((s) => s.id),
        duplicateSampleIds: [],
        unknownSampleIds: [],
        incompleteSamples: [],
      },
    );
  }

  const benchmarkIds = benchmarkSamples.map((s) => s.id);
  const benchmarkSet = new Set(benchmarkIds);
  const seenCounts = new Map<string, number>();
  const unknownSampleIds: string[] = [];
  const invalidSlotSamples: Array<{ sampleId: string; missingFields: string[] }> = [];

  for (const assignment of manifest.assignments) {
    const id = typeof assignment?.sampleId === "string" ? assignment.sampleId : "";
    if (!benchmarkSet.has(id)) {
      unknownSampleIds.push(id || "<empty>");
      continue;
    }
    seenCounts.set(id, (seenCounts.get(id) ?? 0) + 1);
    const expectedSlotMap = assignBlindSlots(id, manifest.seed);
    const slotIssues: string[] = [];
    if (
      !isValidSlotMap(assignment.slotMap)
      || assignment.slotMap.甲 !== expectedSlotMap.甲
      || assignment.slotMap.乙 !== expectedSlotMap.乙
    ) {
      slotIssues.push("manifest.slotMap");
    }
    if (!isValidSlotDigests(assignment.slotDigests)) {
      slotIssues.push("manifest.slotDigests");
    }
    if (slotIssues.length > 0) {
      invalidSlotSamples.push({ sampleId: id, missingFields: slotIssues });
    }
  }

  const missingSampleIds = benchmarkIds.filter((id) => !seenCounts.has(id));
  const duplicateSampleIds = [...seenCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);

  if (
    missingSampleIds.length > 0
    || duplicateSampleIds.length > 0
    || unknownSampleIds.length > 0
    || invalidSlotSamples.length > 0
  ) {
    const parts: string[] = [`盲评清单（manifest）未完整覆盖全部 ${benchmarkIds.length} 篇固定基准样文，拒绝生成揭盲结论：`];
    if (missingSampleIds.length > 0) parts.push(`清单缺失样文(${missingSampleIds.length}): ${missingSampleIds.join(", ")}`);
    if (duplicateSampleIds.length > 0) parts.push(`清单重复样文(${duplicateSampleIds.length}): ${duplicateSampleIds.join(", ")}`);
    if (unknownSampleIds.length > 0) parts.push(`清单未知样文(${unknownSampleIds.length}): ${unknownSampleIds.join(", ")}`);
    if (invalidSlotSamples.length > 0) parts.push(`清单槽位或摘要损坏(${invalidSlotSamples.length}): ${invalidSlotSamples.map((s) => s.sampleId).join(", ")}`);
    throw new BlindComparisonValidationError(parts.join("；"), {
      missingSampleIds,
      duplicateSampleIds,
      unknownSampleIds,
      incompleteSamples: invalidSlotSamples,
    });
  }

  const expectedPackId = computeBlindPackId(manifest.seed, manifest.assignments, {
    baselineLabel: manifest.baselineLabel,
    candidateLabel: manifest.candidateLabel,
  });
  if (manifest.packId !== expectedPackId) {
    throw new BlindComparisonValidationError(
      `盲评清单 packId 与两版版本身份（baselineLabel / candidateLabel）、输出内容摘要及槽位分配不一致（期望 ${expectedPackId}，实际 ${manifest.packId}），拒绝揭盲汇总`,
      {
        missingSampleIds: [],
        duplicateSampleIds: [],
        unknownSampleIds: [],
        incompleteSamples: [],
      },
    );
  }
}

function validateCompleteDecisions(
  manifest: BlindComparisonManifest,
  decisionsDoc: BlindDecisionsDocumentDraft,
  benchmarkSamples: readonly Pick<QualityBenchmarkSample, "id">[],
): TeacherSampleDecision[] {
  validateManifestAgainstBenchmark(manifest, benchmarkSamples);
  if (
    !decisionsDoc
    || typeof decisionsDoc !== "object"
    || Array.isArray(decisionsDoc)
    || typeof decisionsDoc.packId !== "string"
    || !decisionsDoc.packId.trim()
    || !Array.isArray(decisionsDoc.decisions)
  ) {
    throw new BlindComparisonValidationError(
      "教师盲评决策文件必须包含与揭盲清单绑定的 packId 与 decisions 数组，拒绝无包标识数据",
      {
        missingSampleIds: manifest.assignments.map((a) => a.sampleId),
        duplicateSampleIds: [],
        unknownSampleIds: [],
        incompleteSamples: [],
      },
    );
  }
  if (decisionsDoc.packId !== manifest.packId) {
    throw new BlindComparisonValidationError(
      `盲评评分表（packId=${decisionsDoc.packId}）与揭盲清单（packId=${manifest.packId}）不属于同一评审包，拒绝跨包混用生成胜负结论`,
      {
        missingSampleIds: [],
        duplicateSampleIds: [],
        unknownSampleIds: [],
        incompleteSamples: [],
      },
    );
  }
  const decisions = decisionsDoc.decisions;
  const expectedIds = new Set(benchmarkSamples.map((item) => item.id));
  const assignmentById = new Map(manifest.assignments.map((item) => [item.sampleId, item]));
  const seenCounts = new Map<string, number>();
  const unknownSampleIds: string[] = [];
  const incompleteSamples: Array<{ sampleId: string; missingFields: string[] }> = [];

  for (const entry of decisions) {
    const id = typeof entry?.sampleId === "string" ? entry.sampleId : "";
    if (!expectedIds.has(id)) {
      unknownSampleIds.push(id || "<empty>");
      continue;
    }
    seenCounts.set(id, (seenCounts.get(id) ?? 0) + 1);

    const missingFields: string[] = [];
    const assignment = assignmentById.get(id);
    const expectedSampleDigest = assignment
      ? computeSampleDecisionDigest(manifest.packId, id, assignment.slotDigests)
      : "";
    if (typeof entry.contentDigest !== "string" || entry.contentDigest !== expectedSampleDigest) {
      missingFields.push("contentDigest");
    }
    for (const slot of ["甲", "乙"] as const) {
      const rating = entry[slot] as Partial<Record<keyof TeacherSlotRating, unknown>> | null | undefined;
      if (!rating || typeof rating !== "object") {
        missingFields.push(`${slot}`);
        continue;
      }
      for (const field of ["misjudgedSource", "preservedStudentIntent", "actionableForStudent"] as const) {
        if (typeof rating[field] !== "boolean") {
          missingFields.push(`${slot}.${field}`);
        }
      }
    }
    if (entry.preferred !== "甲" && entry.preferred !== "乙" && entry.preferred !== "tie") {
      missingFields.push("preferred");
    }
    if (missingFields.length > 0) {
      incompleteSamples.push({ sampleId: id, missingFields });
    }
  }

  const missingSampleIds = manifest.assignments
    .map(({ sampleId }) => sampleId)
    .filter((id) => !seenCounts.has(id));
  const duplicateSampleIds = [...seenCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);

  if (
    missingSampleIds.length > 0
    || duplicateSampleIds.length > 0
    || unknownSampleIds.length > 0
    || incompleteSamples.length > 0
  ) {
    const parts: string[] = ["教师盲评记录尚未完整或存在样文/评审包摘要不匹配，拒绝生成揭盲结论："];
    if (missingSampleIds.length > 0) parts.push(`缺失样文(${missingSampleIds.length}): ${missingSampleIds.join(", ")}`);
    if (duplicateSampleIds.length > 0) parts.push(`重复样文(${duplicateSampleIds.length}): ${duplicateSampleIds.join(", ")}`);
    if (unknownSampleIds.length > 0) parts.push(`未知样文(${unknownSampleIds.length}): ${unknownSampleIds.join(", ")}`);
    if (incompleteSamples.length > 0) {
      parts.push(`未填完或包摘要不符样文(${incompleteSamples.length}): ${incompleteSamples.map((item) => `${item.sampleId}[${item.missingFields.join("/")}]`).join(", ")}`);
    }
    throw new BlindComparisonValidationError(parts.join("；"), {
      missingSampleIds,
      duplicateSampleIds,
      unknownSampleIds,
      incompleteSamples,
    });
  }

  return decisions as TeacherSampleDecision[];
}

export function summarizeBlindDecisions(
  manifest: BlindComparisonManifest,
  decisionsDoc: BlindDecisionsDocumentDraft,
  benchmarkSamples: readonly Pick<QualityBenchmarkSample, "id">[] = QUALITY_BENCHMARK_SAMPLES,
): BlindComparisonSummary {
  const validated = validateCompleteDecisions(manifest, decisionsDoc, benchmarkSamples);
  const mapById = new Map(manifest.assignments.map((item) => [item.sampleId, item.slotMap]));
  const stats: Record<VariantKey, VariantScoreSummary> = {
    baseline: {
      totalEvaluated: 0,
      noMisjudgmentCount: 0,
      preservedIntentCount: 0,
      actionableCount: 0,
      preferredWins: 0,
    },
    candidate: {
      totalEvaluated: 0,
      noMisjudgmentCount: 0,
      preservedIntentCount: 0,
      actionableCount: 0,
      preferredWins: 0,
    },
  };
  let ties = 0;

  for (const decision of validated) {
    const slotMap = mapById.get(decision.sampleId)!;
    for (const slot of ["甲", "乙"] as const) {
      const target = stats[slotMap[slot]];
      const rating = decision[slot];
      target.totalEvaluated += 1;
      if (!rating.misjudgedSource) target.noMisjudgmentCount += 1;
      if (rating.preservedStudentIntent) target.preservedIntentCount += 1;
      if (rating.actionableForStudent) target.actionableCount += 1;
    }
    if (decision.preferred === "tie") {
      ties += 1;
    } else {
      stats[slotMap[decision.preferred]].preferredWins += 1;
    }
  }

  return {
    totalSamples: validated.length,
    ties,
    baseline: stats.baseline,
    candidate: stats.candidate,
    disclaimer: "本结果仅为 12 篇固定样文的教师定性盲评对照参考，用于换模型或改提示词前排查明显退化，不代表统计效果证明。",
  };
}
