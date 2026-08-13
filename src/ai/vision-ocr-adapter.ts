import OpenAI from "openai";
import { z } from "zod";

import { MAX_REVIEW_IMAGES } from "../domain/contracts";
import { ocrPageSchema, type OcrPage } from "../ocr/contracts";
import { completionContent, parseJsonResponse, roleClient } from "./adapter-shared";
import {
  AiAdapterError,
  type AiSettingsSource,
  type OpenAIClientFactory,
  type OpenAICompatibleClient,
} from "./openai-review-adapter";

const responseSchema = z.object({ pages: z.array(ocrPageSchema).min(1).max(MAX_REVIEW_IMAGES) }).strict();

const OCR_PROMPT = [
  "你是手写中文作文识别模型，只负责逐页转写和定位，不评价作文。",
  "按图片顺序返回 pages。每页给出阅读顺序合并后的 text、readable、warnings 和 blocks。",
  "blocks 中每块包含原文 text，以及相对于整页归一化到 0..1 的 x、y、width、height。",
  "只有整页空白、图片损坏或核心正文无法读取时才设置 readable=false。",
  "不得评价、分析或改写原文，只能忠实转写可辨认内容。",
  "只返回 JSON：{\"pages\":[{\"pageIndex\":0,\"text\":\"\",\"readable\":true,\"warnings\":[],\"blocks\":[{\"text\":\"\",\"x\":0,\"y\":0,\"width\":0.1,\"height\":0.1}]}]}。",
].join("\n");

export interface RecognizeImagesInput {
  imageUrls: string[];
}

export interface VisionOcrResult {
  pages: OcrPage[];
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
    const { client, model } = await roleClient(this.settings, this.clientFactory, "vision");
    const content = await completionContent(client, {
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: OCR_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: "请按页识别这些作文图片。" },
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
      return result;
    } catch {
      throw new AiAdapterError("AI_INVALID_RESPONSE", "识图模型返回结果结构无效", 502);
    }
  }
}
