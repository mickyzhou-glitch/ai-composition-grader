import { describe, expect, it } from "vitest";

import { ANALYSIS_JOB_METADATA_PREFIX } from "./analysis-job-metadata";
import { describePublicAnalysisFailure, sanitizeAnalysisDetail } from "./public-analysis-failure";

describe("公开的分析失败说明", () => {
  it("按错误码和步骤写出中文原因，并折叠已脱敏的原始信息", () => {
    expect(describePublicAnalysisFailure({
      errorCode: "ANALYSIS_TIMEOUT",
      progressStage: "reading_images",
      rawMessage: "timeout on image 2",
    })).toEqual({
      summary: "分析在「读取图片」步骤超时或被中止，涉及第 2 张图片，请重新分析",
      detail: "timeout on image 2",
    });
    expect(describePublicAnalysisFailure({
      errorCode: "ANALYSIS_ABORTED",
      progressStage: "generating_review",
      rawMessage: "exceeded cpu time limit",
    }).summary).toBe("Worker CPU 时间用尽，停在「生成批改」，请重新分析");
    expect(describePublicAnalysisFailure({
      errorCode: "AI_UPSTREAM_HTTP_502",
      progressStage: "generating_review",
    }).summary).toBe("模型或代理返回 502，停在「生成批改」，请稍后重新分析");
    expect(describePublicAnalysisFailure({
      errorCode: "AI_INVALID_RESPONSE_annotation_anchor",
      progressStage: "mapping_annotations",
      rawMessage: "annotation anchor must occur in paragraph-3",
    }).summary).toBe("批注对不上原文（paragraph-3），请重新分析");
    expect(describePublicAnalysisFailure({
      errorCode: "AI_INVALID_RESPONSE_schema_report_unrecognized_keys",
      progressStage: "validating_result",
    }).summary).toBe("批改结果结构不符：「report」多出字段，请重新分析");
    expect(describePublicAnalysisFailure({
      errorCode: "AI_IMAGE_UNAVAILABLE",
      progressStage: "reading_images",
      rawMessage: "第 3 张图片不存在",
    }).summary).toBe("第 3 张图片读取失败，请重新上传后再分析");
  });

  it("原始信息去掉密钥、图片数据和长正文，内部标记不展示", () => {
    expect(sanitizeAnalysisDetail("Bearer sk-abcdefghi123 以及 data:image/jpeg;base64,AAAA")).toBe("[密钥] 以及 [图片数据]");
    expect(sanitizeAnalysisDetail(`${"我".repeat(50)}。`)).toBe("[正文已省略]");
    expect(sanitizeAnalysisDetail(`${ANALYSIS_JOB_METADATA_PREFIX}ordinary-bound`)).toBeNull();
  });

  it.each([
    ["AI_INVALID_RESPONSE_output_truncated", "批改结果输出被截断（超出模型输出上限），已自动重试仍失败，请重新分析"],
    ["AI_INVALID_RESPONSE_json_parse", "批改结果不是合法 JSON（可能夹带多余文字或未转义字符），请重新分析"],
    ["AI_INVALID_RESPONSE_rewritten_essay_structure", "AI 生成的范文未满足逐段结构要求，请重新分析"],
    ["AI_INVALID_RESPONSE_schema_annotationAnchors_invalid_type", "批改结果结构不符：「annotationAnchors」缺少字段或类型不对，请重新分析"],
  ])("写明具体失败原因：%s", (errorCode, summary) => {
    expect(describePublicAnalysisFailure({ errorCode, progressStage: "generating_review" }).summary).toBe(summary);
  });
});
