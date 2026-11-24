import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  exportBenchmarkModelInputs,
  QUALITY_BENCHMARK_SAMPLES,
} from "../src/eval/benchmark-samples";
import {
  BlindComparisonValidationError,
  createBlindComparisonPack,
  summarizeBlindDecisions,
  type BenchmarkVariantOutput,
  type BlindComparisonManifest,
  type BlindDecisionsDocumentDraft,
} from "../src/eval/blind-comparison";

function argValue(args: readonly string[], flag: string): string | undefined {
  const matches: number[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag) matches.push(i);
  }
  if (matches.length > 1) {
    throw new Error(`DUPLICATE_FLAG:${flag}`);
  }
  if (matches.length === 0) return undefined;
  return args[matches[0]! + 1];
}

function usage(): string {
  return [
    "用法：",
    "  1. 导出 12 篇虚构样文（分离纯模型输入 model-inputs.json 与教师核对参考 teacher-reference.json）：",
    "     npm run eval:quality -- --export-samples /tmp/essay-benchmark",
    "  2. 由新旧两版输出生成教师盲评对照表（隐藏模型/提示词身份，模板默认全未填写）：",
    "     npm run eval:quality -- --baseline /tmp/base.json --candidate /tmp/cand.json --out /tmp/essay-blind --seed 2026-11-24",
    "  3. 教师完整填写盲评 JSON 后揭盲汇总（漏评、重评或未填项将报错中止）：",
    "     npm run eval:quality -- --summarize /tmp/essay-blind/decisions.json --manifest /tmp/essay-blind/manifest.json",
  ].join("\n");
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))) {
    console.log(usage());
    return;
  }

  let exportDir: string | undefined;
  let decisionsPath: string | undefined;
  let manifestPath: string | undefined;
  let baselinePath: string | undefined;
  let candidatePath: string | undefined;
  let outDir: string | undefined;
  let seedArg: string | undefined;
  let baselineLabelArg: string | undefined;
  let candidateLabelArg: string | undefined;
  try {
    exportDir = argValue(args, "--export-samples");
    decisionsPath = argValue(args, "--summarize");
    manifestPath = argValue(args, "--manifest");
    baselinePath = argValue(args, "--baseline");
    candidatePath = argValue(args, "--candidate");
    outDir = argValue(args, "--out");
    seedArg = argValue(args, "--seed");
    baselineLabelArg = argValue(args, "--baseline-label");
    candidateLabelArg = argValue(args, "--candidate-label");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("DUPLICATE_FLAG:")) {
      console.error(`[ERROR] 参数 ${error.message.slice("DUPLICATE_FLAG:".length)} 不能重复传入。\n${usage()}`);
      process.exitCode = 2;
      return;
    }
    throw error;
  }

  if (exportDir) {
    mkdirSync(exportDir, { recursive: true });
    const modelInputPath = path.join(exportDir, "model-inputs.json");
    const teacherRefPath = path.join(exportDir, "teacher-reference.json");
    writeFileSync(modelInputPath, `${JSON.stringify(exportBenchmarkModelInputs(), null, 2)}\n`, "utf8");
    writeFileSync(teacherRefPath, `${JSON.stringify(QUALITY_BENCHMARK_SAMPLES, null, 2)}\n`, "utf8");
    console.log(`已导出 ${QUALITY_BENCHMARK_SAMPLES.length} 篇纯模型输入至: ${modelInputPath}`);
    console.log(`已导出教师核对参考（勿传给待测模型）至: ${teacherRefPath}`);
    return;
  }

  if (decisionsPath && manifestPath) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BlindComparisonManifest;
      const decisions = JSON.parse(readFileSync(decisionsPath, "utf8")) as BlindDecisionsDocumentDraft;
      const summary = summarizeBlindDecisions(manifest, decisions);
      console.log(JSON.stringify({
        packId: manifest.packId,
        baselineLabel: manifest.baselineLabel,
        candidateLabel: manifest.candidateLabel,
        ...summary,
      }, null, 2));
    } catch (error) {
      if (error instanceof BlindComparisonValidationError) {
        console.error(`[ERROR] ${error.message}`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    return;
  }

  if (baselinePath && candidatePath && outDir) {
    try {
      const baselineOutputs = JSON.parse(readFileSync(baselinePath, "utf8")) as BenchmarkVariantOutput[];
      const candidateOutputs = JSON.parse(readFileSync(candidatePath, "utf8")) as BenchmarkVariantOutput[];
      const baseBasename = path.basename(baselinePath);
      const candBasename = path.basename(candidatePath);
      const pack = createBlindComparisonPack({
        samples: QUALITY_BENCHMARK_SAMPLES,
        baselineOutputs,
        candidateOutputs,
        seed: seedArg ?? "2026-11-24",
        baselineLabel: baselineLabelArg ?? (baseBasename !== candBasename ? baseBasename : `baseline:${baselinePath}`),
        candidateLabel: candidateLabelArg ?? (baseBasename !== candBasename ? candBasename : `candidate:${candidatePath}`),
      });
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, "blind-review-sheet.md"), `${pack.blindSheetMarkdown}\n`, "utf8");
      writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(pack.manifest, null, 2)}\n`, "utf8");
      writeFileSync(path.join(outDir, "decisions-template.json"), `${JSON.stringify(pack.decisionsTemplate, null, 2)}\n`, "utf8");
      console.log(`盲评对照包已生成至: ${outDir}（packId=${pack.manifest.packId}）`);
    } catch (error) {
      if (error instanceof BlindComparisonValidationError) {
        console.error(`[ERROR] ${error.message}`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    return;
  }

  console.error(usage());
  process.exitCode = 2;
}

main();
