import OpenAI from "openai";
import { z, ZodError } from "zod";

import { MAX_REVIEW_IMAGES } from "../domain/contracts";
import {
  createOcrCheckpointV2,
  ocrPageSchema,
  ocrParagraphSchema,
  type OcrPage,
  type OcrParagraph,
} from "../ocr/contracts";
import { OCR_UNREADABLE_PLACEHOLDER } from "../ocr/ocr-quality";
import { alignParagraphsToSource } from "../ocr/source-paragraphs";
import { imageUrlContentPart, isGeminiBaseUrl } from "./ai-client-options";
import { completionJsonWithFinish, completionWithFinish, parseJsonResponse, roleClient } from "./adapter-shared";
import {
  AiAdapterError,
  type AiSettingsSource,
  type OpenAIClientFactory,
  type OpenAICompatibleClient,
} from "./openai-review-adapter";

const VISION_RETRY_MAX_TOKENS = 8_192;
const GEMINI_VISION_RETRY_MAX_TOKENS = 32_768;
const MINOR_BOUNDS_EPSILON = 0.04;
const MINOR_OVERLAP_MAX_HEIGHT = 0.04;
const MINOR_OVERLAP_MAX_RATIO = 0.35;
const OVERLAP_SEPARATION_GAP = 2e-4;

const recognizedOcrParagraphSchema = ocrParagraphSchema.omit({ id: true });

const responseSchema = z.object({
  pages: z.array(ocrPageSchema).min(1).max(MAX_REVIEW_IMAGES),
  paragraphs: z.array(recognizedOcrParagraphSchema).min(1),
}).strict();

const OCR_PROMPT = [
  "你是手写中文作文识别模型。直接阅读每一张完整作文图片并转写，不要把作文图片裁成一段一段再识别。",
  "按图片顺序返回 pages。每页 text 按阅读顺序转写整页正文：原文每一个自然段单独占一行，段与段之间只用一个换行，不得合并。",
  "每页同时返回 readable、warnings 和 blocks。blocks 只标注正文大致位置（按自然段粒度给块即可，不必逐行拆碎），每块包含原文 text，以及相对于整页归一化到 0..1 的 x、y、width、height；blocks 不决定分段。",
  "只把作文正文自然段写入 paragraphs；排除题目、姓名、班级、页码、格数说明、教师批注。",
  "paragraphs 必须与各页 text 中的自然段一一对应，原文有几段就返回几项，不得合并，不得漏段。",
  "paragraphs 按正文顺序从 paragraphIndex=0 连续编号；跨页延续使用同一个 paragraphIndex，且仅当上页末段在句中被截断、下页开头仍是同一段续写。",
  "每段返回 paragraphIndex、text 和 segments。text 只含这一段，不含换行，且必须与该段各 segments.text 按顺序拼接的文字一致。",
  "每个 segment 返回 pageIndex、text、x、y、width、height（满足 0<=x,y<=1 且 x+width<=1、y+height<=1，不同自然段的区域上下不要重叠），只标注该段在整页上的大致范围，不是裁图识别结果。",
  "只有整页空白、图片损坏或核心正文无法读取时才设置 readable=false。",
  "只转写，不评价、不分析、不改写原文，也不提出改写意见。",
  `看不清、无法确认的字一律用「${OCR_UNREADABLE_PLACEHOLDER}」占位，每个看不清的字写一个「${OCR_UNREADABLE_PLACEHOLDER}」，宁可多占位也不要猜字。`,
  "不得根据上下文把看不清的地方补成通顺的句子；不得编造或替换原文的情节、人物、称呼、姓氏、性别、学科、地点、时间；看清了什么就写什么。",
  "学生原文的病句、错别字、重复、漏字和不通顺之处照原样写，不要修正、不要润色、不要补全。",
  "有较多字看不清、某页字迹模糊或有遮挡时，在该页 warnings 里用一句话说明原因和大致位置。",
  "只返回严格 JSON：{\"pages\":[{\"pageIndex\":0,\"text\":\"\",\"readable\":true,\"warnings\":[],\"blocks\":[{\"text\":\"\",\"x\":0,\"y\":0,\"width\":0.1,\"height\":0.1}]}],\"paragraphs\":[{\"paragraphIndex\":0,\"text\":\"\",\"segments\":[{\"pageIndex\":0,\"text\":\"\",\"x\":0,\"y\":0,\"width\":0.1,\"height\":0.1}]}]}。",
].join("\n");

export interface RecognizeImagesInput {
  imageUrls: string[];
}

export interface VisionOcrResult {
  pages: OcrPage[];
  paragraphs: RecognizedOcrParagraph[];
}

export type RecognizedOcrParagraph = Omit<OcrParagraph, "id">;

type RawBox = {
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
  [key: string]: unknown;
};

function clampMinorBoxBounds<T extends RawBox>(box: T, allowClampZeroSize = false): T {
  if (
    typeof box.x !== "number" || !Number.isFinite(box.x)
    || typeof box.y !== "number" || !Number.isFinite(box.y)
    || typeof box.width !== "number" || !Number.isFinite(box.width)
    || typeof box.height !== "number" || !Number.isFinite(box.height)
  ) {
    return box;
  }
  let x = box.x >= -MINOR_BOUNDS_EPSILON && box.x < 0 ? 0 : box.x;
  let y = box.y >= -MINOR_BOUNDS_EPSILON && box.y < 0 ? 0 : box.y;
  let width = allowClampZeroSize && box.width === 0 ? 0.02 : box.width;
  let height = allowClampZeroSize && box.height === 0 ? 0.02 : box.height;

  if (x >= 0 && x < 1 && width > 0 && x + width > 1 && x + width <= 1 + MINOR_BOUNDS_EPSILON) {
    width = Math.max(1e-4, 1 - x);
  }
  if (y >= 0 && y < 1 && height > 0 && y + height > 1 && y + height <= 1 + MINOR_BOUNDS_EPSILON) {
    height = Math.max(1e-4, 1 - y);
  }
  if (x === 1 && allowClampZeroSize) {
    x = 0.98;
    width = Math.min(width, 0.02);
  }
  if (y === 1 && allowClampZeroSize) {
    y = 0.98;
    height = Math.min(height, 0.02);
  }
  return { ...box, x, y, width, height };
}

function coreCharacters(value: string): string {
  return value.replace(/[\p{P}\p{S}\s]+/gu, "");
}

function isEnglishOrDigit(ch: string | undefined): boolean {
  return ch !== undefined && /^[A-Za-z0-9]$/u.test(ch);
}

function joinSegmentsText(texts: string[]): string {
  return texts.reduce((acc, part, idx) => {
    if (idx === 0) return part;
    const prev = texts[idx - 1];
    const sep = isEnglishOrDigit(prev.at(-1)) && isEnglishOrDigit(part[0]) ? " " : "";
    return `${acc}${sep}${part}`;
  }, "");
}

function resolveMinorParagraphOverlaps(paragraphs: RecognizedOcrParagraph[]): RecognizedOcrParagraph[] {
  const cloned: RecognizedOcrParagraph[] = paragraphs.map((paragraph) => ({
    ...paragraph,
    segments: paragraph.segments.map((segment) => ({ ...segment })),
  }));

  for (let i = 0; i < cloned.length; i += 1) {
    for (let j = i + 1; j < cloned.length; j += 1) {
      for (const first of cloned[i].segments) {
        for (const second of cloned[j].segments) {
          if (first.pageIndex !== second.pageIndex) continue;
          const hOverlap = Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x);
          const vOverlap = Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y);
          if (hOverlap <= 1e-6 || vOverlap <= 1e-6) continue;

          const minHeight = Math.min(first.height, second.height);
          if (vOverlap > MINOR_OVERLAP_MAX_HEIGHT || vOverlap >= MINOR_OVERLAP_MAX_RATIO * minHeight) {
            continue;
          }

          const upper = first.y <= second.y ? first : second;
          const lower = upper === first ? second : first;
          const upperBottom = upper.y + upper.height;
          const lowerBottom = lower.y + lower.height;
          const mid = (upperBottom + lower.y) / 2;
          const nextUpperHeight = mid - OVERLAP_SEPARATION_GAP / 2 - upper.y;
          const nextLowerY = mid + OVERLAP_SEPARATION_GAP / 2;
          const nextLowerHeight = lowerBottom - nextLowerY;

          if (nextUpperHeight > 1e-3 && nextLowerHeight > 1e-3 && nextLowerY < 1) {
            upper.height = nextUpperHeight;
            lower.y = nextLowerY;
            lower.height = Math.min(nextLowerHeight, 1 - nextLowerY);
          }
        }
      }
    }
  }
  return cloned;
}

function normalizeRawVisionPayload(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const candidate = raw as Record<string, unknown>;
  if (!Array.isArray(candidate.pages) || !Array.isArray(candidate.paragraphs)) return raw;

  const pages = candidate.pages.map((page) => {
    if (!page || typeof page !== "object" || Array.isArray(page)) return page;
    const p = page as Record<string, unknown>;
    const rawBlocks = Array.isArray(p.blocks) ? p.blocks : [];
    const normalizedBlocks = rawBlocks
      .filter((b): b is RawBox & { text: string } =>
        Boolean(b && typeof b === "object" && !Array.isArray(b) && typeof (b as { text?: unknown }).text === "string" && (b as { text: string }).text.trim().length > 0),
      )
      .map((b) => clampMinorBoxBounds(b, true))
      .filter((b) =>
        typeof b.x === "number" && b.x >= 0 && b.x <= 1
        && typeof b.y === "number" && b.y >= 0 && b.y <= 1
        && typeof b.width === "number" && b.width > 0 && b.x + b.width <= 1
        && typeof b.height === "number" && b.height > 0 && b.y + b.height <= 1,
      );
    const rawWarnings = Array.isArray(p.warnings)
      ? p.warnings.filter((w): w is string => typeof w === "string" && w.trim().length > 0)
      : [];
    return {
      ...p,
      warnings: rawWarnings,
      blocks: normalizedBlocks,
    };
  });

  const paragraphs = candidate.paragraphs.map((para) => {
    if (!para || typeof para !== "object" || Array.isArray(para)) return para;
    const item = para as Record<string, unknown>;
    if (!Array.isArray(item.segments)) return para;
    const segments = item.segments.map((seg) => {
      if (!seg || typeof seg !== "object" || Array.isArray(seg)) return seg;
      return clampMinorBoxBounds(seg as RawBox, false);
    });
    let nextText = item.text;
    let nextSegments = segments;
    if (
      typeof nextText === "string"
      && nextText.trim().length > 0
      && segments.length > 0
      && segments.every((s) => s && typeof s === "object" && typeof (s as { text?: unknown }).text === "string" && (s as { text: string }).text.trim().length > 0)
    ) {
      const segTexts = segments.map((s) => (s as { text: string }).text.trim());
      const combined = joinSegmentsText(segTexts);
      const paragraphCore = coreCharacters(nextText);
      const combinedCore = coreCharacters(combined);
      if (paragraphCore.length > 0 && paragraphCore === combinedCore) {
        if (segments.length === 1) {
          nextSegments = [{ ...(segments[0] as Record<string, unknown>), text: nextText.trim() }];
        } else {
          nextText = combined;
        }
      }
    }
    return {
      ...item,
      text: nextText,
      segments: nextSegments,
    };
  });

  return {
    ...candidate,
    pages,
    paragraphs,
  };
}

function classifyOcrValidationFailure(error: unknown, truncated: boolean): { tag: string; hint: string } {
  if (truncated) {
    return { tag: "ocr_truncated", hint: "JSON 输出过长被截断，blocks 请只按自然段粒度返回" };
  }
  const message = error instanceof ZodError
    ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
    : error instanceof Error
      ? error.message
      : String(error);
  if (/Unexpected token|JSON|json/iu.test(message)) {
    return { tag: "ocr_json_parse", hint: "返回内容不是合法 JSON" };
  }
  if (/page count/iu.test(message)) {
    return { tag: "ocr_page_count", hint: "pages 数组长度必须严格等于上传的图片张数" };
  }
  if (/overlap/iu.test(message)) {
    return { tag: "ocr_overlap", hint: "同一页不同自然段的 segments 区域上下发生了重叠，请调整 y 与 height 使各段互不重叠" };
  }
  if (/fit within the page|<= 1|< 1/iu.test(message)) {
    return { tag: "ocr_bounds", hint: "存在坐标超出页面范围，所有 x、y、width、height 必须满足 0..1 且 x+width<=1、y+height<=1" };
  }
  if (/ordered segment text/iu.test(message)) {
    return { tag: "ocr_segment_text", hint: "paragraph.text 与该段各 segments[].text 拼接后的文字不一致" };
  }
  if (/reading order/iu.test(message)) {
    return { tag: "ocr_reading_order", hint: "segments 顺序必须遵循从上到下、从左到右阅读顺序" };
  }
  return { tag: "ocr_schema", hint: message.slice(0, 180) || "JSON 字段不符合识图结构要求" };
}

function parseAndValidateVisionOcr(content: string, expectedPageCount: number): VisionOcrResult {
  const normalized = normalizeRawVisionPayload(parseJsonResponse(content));
  const result = responseSchema.parse(normalized);
  if (result.pages.length !== expectedPageCount) {
    throw new Error("OCR page count must equal image count");
  }
  result.pages.forEach((page, index) => {
    if (page.pageIndex !== index) throw new Error("OCR page indexes must be continuous");
  });
  const aligned = alignParagraphsToSource(result.pages, result.paragraphs);
  const paragraphs = resolveMinorParagraphOverlaps(aligned);
  void createOcrCheckpointV2({
    sourceRevision: 0,
    pages: result.pages,
    paragraphs,
  });
  return { pages: result.pages, paragraphs };
}

export class VisionOcrAdapter {
  private readonly clientFactory: OpenAIClientFactory;

  constructor(
    private readonly settings: AiSettingsSource,
    options: { clientFactory?: OpenAIClientFactory } = {},
  ) {
    this.clientFactory = options.clientFactory ?? ((clientOptions) =>
      new OpenAI(clientOptions) as unknown as OpenAICompatibleClient);
  }

  async recognize(input: RecognizeImagesInput): Promise<VisionOcrResult> {
    if (input.imageUrls.length < 1 || input.imageUrls.length > MAX_REVIEW_IMAGES) {
      throw new TypeError(`imageUrls must contain 1 to ${MAX_REVIEW_IMAGES} pages`);
    }
    const { client, model, baseUrl } = await roleClient(this.settings, this.clientFactory, "vision");
    const retryMaxTokens = isGeminiBaseUrl(baseUrl) ? GEMINI_VISION_RETRY_MAX_TOKENS : VISION_RETRY_MAX_TOKENS;
    const baseMessages = [
      { role: "system", content: OCR_PROMPT },
      {
        role: "user",
        content: [
          { type: "text", text: `请直接识别每张完整作文图片（共 ${input.imageUrls.length} 页），按原文自然段分行，不要裁成段再识别。看不清的字每字用一个「${OCR_UNREADABLE_PLACEHOLDER}」占位，不要猜、不要补写、病句照写。` },
          ...input.imageUrls.map((url) => imageUrlContentPart(url, baseUrl)),
        ],
      },
    ];

    const first = await completionJsonWithFinish(client, {
      model,
      response_format: { type: "json_object" },
      messages: baseMessages,
    });

    let firstError: unknown;
    if (!first.truncated) {
      try {
        return parseAndValidateVisionOcr(first.content, input.imageUrls.length);
      } catch (error) {
        firstError = error;
      }
    }

    const { hint } = classifyOcrValidationFailure(firstError, first.truncated);
    const repairInstruction = `上一次识图输出未通过结构校验（${hint}）。请重新严格输出完整 JSON：pages 必须恰好 ${input.imageUrls.length} 项（pageIndex 从 0 连续编号），paragraphs 按自然段从 paragraphIndex=0 连续编号，所有 x/y/width/height 在 0..1 内且 x+width<=1、y+height<=1，同一页不同自然段的 segments 框互不重叠，每段 text 与其 segments[].text 拼接完全一致，blocks 只按段粒度返回。`;

    let retry: { content: string; truncated: boolean };
    try {
      retry = await completionWithFinish(client, {
        model,
        max_tokens: retryMaxTokens,
        response_format: { type: "json_object" },
        messages: [...baseMessages, { role: "user", content: repairInstruction }],
      });
    } catch (error) {
      if (error instanceof AiAdapterError && error.upstreamStatus === 400) {
        retry = await completionWithFinish(client, {
          model,
          response_format: { type: "json_object" },
          messages: [...baseMessages, { role: "user", content: repairInstruction }],
        });
      } else {
        throw error;
      }
    }

    try {
      if (retry.truncated) throw new Error("OCR retry truncated");
      return parseAndValidateVisionOcr(retry.content, input.imageUrls.length);
    } catch (retryError) {
      const failure = classifyOcrValidationFailure(retryError, retry.truncated);
      throw new AiAdapterError(
        "AI_INVALID_RESPONSE",
        "识图模型返回结果结构无效",
        502,
        undefined,
        failure.tag,
        { cause: retryError },
      );
    }
  }
}
