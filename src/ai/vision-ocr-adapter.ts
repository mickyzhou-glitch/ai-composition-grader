import OpenAI from "openai";
import { z } from "zod";

import { MAX_REVIEW_IMAGES } from "../domain/contracts";
import {
  createOcrCheckpointV2,
  ocrPageSchema,
  ocrParagraphSchema,
  type OcrPage,
  type OcrParagraph,
} from "../ocr/contracts";
import { alignParagraphsToSource } from "../ocr/source-paragraphs";
import { completionContent, parseJsonResponse, roleClient } from "./adapter-shared";
import {
  AiAdapterError,
  type AiSettingsSource,
  type OpenAIClientFactory,
  type OpenAICompatibleClient,
} from "./openai-review-adapter";

const recognizedOcrParagraphSchema = ocrParagraphSchema.omit({ id: true });

const responseSchema = z.object({
  pages: z.array(ocrPageSchema).min(1).max(MAX_REVIEW_IMAGES),
  paragraphs: z.array(recognizedOcrParagraphSchema).min(1),
}).strict();

const OCR_PROMPT = [
  "你是手写中文作文识别模型。直接阅读每一张完整作文图片并转写，不要把作文图片裁成一段一段再识别。",
  "按图片顺序返回 pages。每页 text 按阅读顺序转写整页正文：原文每一个自然段单独占一行，段与段之间只用一个换行，不得合并。",
  "每页同时返回 readable、warnings 和 blocks。blocks 只标注正文大致位置，每块包含原文 text，以及相对于整页归一化到 0..1 的 x、y、width、height；blocks 不决定分段。",
  "只把作文正文自然段写入 paragraphs；排除题目、姓名、班级、页码、格数说明、教师批注。",
  "paragraphs 必须与各页 text 中的自然段一一对应，原文有几段就返回几项，不得合并，不得漏段。",
  "paragraphs 按正文顺序从 paragraphIndex=0 连续编号；跨页延续使用同一个 paragraphIndex，且仅当上页末段在句中被截断、下页开头仍是同一段续写。",
  "每段返回 paragraphIndex、text 和 segments。text 只含这一段，不含换行。",
  "每个 segment 返回 pageIndex、text、x、y、width、height，只标注该段在整页上的大致范围，不是裁图识别结果。",
  "只有整页空白、图片损坏或核心正文无法读取时才设置 readable=false。",
  "只转写，不评价、不分析、不改写原文，也不提出改写意见。",
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
    const { client, model } = await roleClient(this.settings, this.clientFactory, "vision");
    const content = await completionContent(client, {
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: OCR_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "请直接识别每张完整作文图片，按原文自然段分行，不要裁成段再识别。" },
            ...input.imageUrls.map((url) => ({
              type: "image_url",
              image_url: { url, detail: "high" },
            })),
          ],
        },
      ],
    });
    try {
      const result = responseSchema.parse(parseJsonResponse(content));
      if (result.pages.length !== input.imageUrls.length) {
        throw new Error("OCR page count must equal image count");
      }
      result.pages.forEach((page, index) => {
        if (page.pageIndex !== index) throw new Error("OCR page indexes must be continuous");
      });
      const paragraphs = alignParagraphsToSource(result.pages, result.paragraphs);
      void createOcrCheckpointV2({
        sourceRevision: 0,
        pages: result.pages,
        paragraphs,
      });
      return { pages: result.pages, paragraphs };
    } catch {
      throw new AiAdapterError("AI_INVALID_RESPONSE", "识图模型返回结果结构无效", 502);
    }
  }
}
