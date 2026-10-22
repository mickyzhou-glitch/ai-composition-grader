import { AiAdapterError } from "../ai/openai-review-adapter";
import { CloudAnalysisConflictError } from "./cloud-analysis-pipeline";

const KNOWN_FAILURES = new Set(["AI_SETTINGS_INCOMPLETE", "OCR_NOT_FOUND", "OCR_V2_REQUIRED"]);

const STAGE_LABELS: Record<string, string> = {
  queued: "排队",
  reading_images: "读取图片",
  saving_ocr: "保存识别结果",
  generating_review: "生成批改",
  mapping_annotations: "整理批注",
  validating_result: "校验结果",
  saving_result: "保存结果",
};

export function analysisStageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? "分析";
}

export function analysisInterruptedMessage(stage: string): string {
  return `分析在「${analysisStageLabel(stage)}」步骤超时或被中止，请重新分析`;
}

export function isWorkerAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  const message = error instanceof Error ? error.message : "";
  return name === "AbortError"
    || name === "TimeoutError"
    || /exceeded (cpu|memory)|cpu time limit|script will be terminated|worker was terminated|aborted/i.test(message);
}

export function analysisFailureCode(error: unknown): string {
  if (!(error instanceof AiAdapterError) && !(error instanceof CloudAnalysisConflictError) && isWorkerAbort(error)) {
    return "ANALYSIS_ABORTED";
  }
  if (error instanceof AiAdapterError && error.upstreamStatus) {
    return `AI_UPSTREAM_HTTP_${error.upstreamStatus}${error.upstreamCode ? `_${error.upstreamCode}` : ""}`;
  }
  if (error instanceof AiAdapterError) {
    return `${error.code}${error.upstreamCode ? `_${error.upstreamCode}` : ""}`;
  }
  if (error instanceof CloudAnalysisConflictError) return error.code;
  if (error instanceof Error && KNOWN_FAILURES.has(error.message)) return error.message;
  return "AI_REQUEST_FAILED";
}
