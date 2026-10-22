import { describe, expect, it } from "vitest";

import { AiAdapterError } from "../ai/openai-review-adapter";
import {
  analysisFailureCode,
  analysisInterruptedMessage,
} from "./analysis-failure";

describe("analysis failure reasons", () => {
  it("把 Worker 中止和超时写成可读的步骤原因", () => {
    expect(analysisInterruptedMessage("reading_images")).toBe(
      "分析在「读取图片」步骤超时或被中止，请重新分析",
    );
    expect(analysisInterruptedMessage("generating_review")).toContain("生成批改");
  });

  it("CPU 超限或任务被中止时记为 ANALYSIS_ABORTED，而不是笼统的请求失败", () => {
    expect(analysisFailureCode(new Error("Worker exceeded CPU time limit"))).toBe("ANALYSIS_ABORTED");
    expect(analysisFailureCode(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))).toBe("ANALYSIS_ABORTED");
  });

  it("保留 AI 返回格式错误的原始错误码", () => {
    const error = new AiAdapterError("AI_INVALID_RESPONSE", "无效", 502, undefined, "schema_report_unrecognized_keys");
    expect(analysisFailureCode(error)).toBe("AI_INVALID_RESPONSE_schema_report_unrecognized_keys");
  });
});
