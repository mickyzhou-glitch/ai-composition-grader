import { analysisInterruptedMessage, analysisStageLabel } from "../cloudflare/analysis-failure";
import { ANALYSIS_JOB_METADATA_PREFIX } from "./analysis-job-metadata";

export interface PublicAnalysisFailure {
  summary: string;
  detail: string | null;
}

/** Drop secrets, data URLs, and long essay text before a teacher can open the raw note. */
export function sanitizeAnalysisDetail(value: string | null | undefined): string | null {
  if (!value || value.startsWith(ANALYSIS_JOB_METADATA_PREFIX)) return null;
  const text = value
    .replace(/data:[^\s]+/giu, "[图片数据]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, "[密钥]")
    .replace(/Bearer\s+\S+/giu, "[密钥]")
    .replace(/(api[_-]?key|token|secret)\s*[:=]\s*\S+/giu, "[密钥]")
    .replace(/[\u4e00-\u9fff，。！？、“”]{40,}/gu, "[正文已省略]")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) return null;
  return text.length > 180 ? `${text.slice(0, 180)}…` : text;
}

function httpStatus(errorCode: string): string | null {
  return errorCode.match(/(?:HTTP_)(\d{3})/u)?.[1]
    ?? errorCode.match(/(?:^|_)(5\d{2})(?:_|$)/u)?.[1]
    ?? null;
}

function imageNumber(detail: string | null): string | null {
  if (!detail) return null;
  const match = detail.match(/第\s*(\d+)\s*张/u) ?? detail.match(/image\s*(\d+)/iu);
  return match?.[1] ?? null;
}

function paragraphHint(detail: string | null): string | null {
  return detail?.match(/paragraph-\d+/u)?.[0] ?? null;
}

export function describePublicAnalysisFailure(input: {
  errorCode: string | null;
  progressStage: string;
  rawMessage?: string | null;
}): PublicAnalysisFailure {
  const errorCode = input.errorCode ?? "";
  const stage = analysisStageLabel(input.progressStage);
  const detail = sanitizeAnalysisDetail(input.rawMessage);
  const status = httpStatus(errorCode);
  const image = imageNumber(detail);
  const paragraph = paragraphHint(detail);

  let summary: string;
  if (/cpu time limit|exceeded cpu|script will be terminated/iu.test(detail ?? "")) {
    summary = `Worker CPU 时间用尽，停在「${stage}」${image ? `，第 ${image} 张图片` : ""}，请重新分析`;
  } else if (errorCode === "ANALYSIS_TIMEOUT" || errorCode === "ANALYSIS_ABORTED") {
    summary = analysisInterruptedMessage(input.progressStage);
    if (image) summary = summary.replace("，请重新分析", `，涉及第 ${image} 张图片，请重新分析`);
  } else if (errorCode === "AI_SETTINGS_INCOMPLETE") {
    summary = "请联系管理员检查 AI 服务设置后再试";
  } else if (errorCode.startsWith("AI_INVALID_RESPONSE_rewritten_essay_chars_")) {
    summary = "AI 生成的范文未满足指定字数，请重新生成整篇批改";
  } else if (errorCode.startsWith("AI_INVALID_RESPONSE_rewritten_essay_paragraph_count_")) {
    summary = "AI 生成的范文未满足指定段数，请重新生成整篇批改";
  } else if (errorCode.includes("annotation_anchor")) {
    summary = `批注对不上原文${paragraph ? `（${paragraph}）` : ""}，请重新分析`;
  } else if (errorCode.includes("annotation_paragraph")) {
    summary = `批注找不到对应段落${paragraph ? `（${paragraph}）` : ""}，请重新分析`;
  } else if (errorCode.includes("annotation_order")) {
    summary = "批注顺序对不上原文，请重新分析";
  } else if (errorCode.includes("output_truncated")) {
    summary = "批改结果输出被截断（超出模型输出上限），已自动重试仍失败，请重新分析";
  } else if (errorCode.includes("json_parse")) {
    summary = "批改结果不是合法 JSON（可能夹带多余文字或未转义字符），请重新分析";
  } else if (/schema_/u.test(errorCode)) {
    const field = errorCode.match(/schema_(.+?)_(invalid_type|unrecognized_keys|too_small|too_big|invalid_value|invalid_enum_value|invalid_string|custom|invalid_union)/u);
    const kind = errorCode.includes("unrecognized_keys") ? "多出字段" : errorCode.includes("invalid_type") ? "缺少字段或类型不对" : "字段不合要求";
    summary = `批改结果结构不符：${field ? `「${field[1]}」` : ""}${kind}，请重新分析`;
  } else if (/json|unrecognized_keys|invalid_type|parse/iu.test(errorCode)) {
    summary = "批改结果 JSON 解析失败，请重新分析";
  } else if (errorCode === "AI_IMAGE_UNAVAILABLE" || errorCode === "AI_IMAGE_UNSUPPORTED") {
    summary = image
      ? `第 ${image} 张图片读取失败，请重新上传后再分析`
      : "图片读取失败，请重新上传后再分析";
  } else if (errorCode === "AI_INLINE_IMAGE_TOO_LARGE") {
    summary = image ? `第 ${image} 张图片过大，请重新拍摄后再分析` : "图片过大，请重新拍摄后再分析";
  } else if (status?.startsWith("5")) {
    summary = `模型或代理返回 ${status}，停在「${stage}」，请稍后重新分析`;
  } else if (errorCode === "AI_UPSTREAM_HTTP_400") {
    summary = "AI 服务拒绝了图片批改请求，请检查模型是否支持视觉输入";
  } else if (errorCode.startsWith("AI_UPSTREAM_HTTP_402")) {
    summary = "AI 内容批改服务额度不足，请联系管理员充值后重试";
  } else if (errorCode === "AI_UPSTREAM_HTTP_401" || errorCode.startsWith("AI_UPSTREAM_HTTP_401_")) {
    summary = "AI 服务拒绝了访问密钥，请在设置中重新保存并测试";
  } else if (errorCode === "AI_UPSTREAM_HTTP_403" || errorCode.startsWith("AI_UPSTREAM_HTTP_403_")) {
    summary = "AI 服务拒绝了图片批改请求，请确认当前模型已开通视觉输入权限";
  } else if (errorCode.startsWith("AI_UPSTREAM_HTTP_")) {
    summary = `AI 服务返回 ${status ?? "错误"}，停在「${stage}」，请稍后重试`;
  } else if (errorCode === "AI_INVALID_RESPONSE" || errorCode.startsWith("AI_INVALID_RESPONSE_")) {
    summary = "AI 返回格式异常，请重新分析";
  } else if (errorCode) {
    summary = `分析失败，停在「${stage}」，请重新分析`;
  } else {
    summary = "分析暂未完成，请稍后重试";
  }

  return { summary, detail };
}
