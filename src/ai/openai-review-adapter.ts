import OpenAI from "openai";

import {
  aiReviewEnvelopeSchema,
  type AiReviewEnvelope,
  type AssignmentConfig,
} from "../domain/contracts";
import { validateReport } from "../domain/report-validation";

const AI_TIMEOUT_MS = 180_000;
const AI_MAX_RETRIES = 1;

export interface OpenAIClientOptions {
  apiKey: string;
  baseURL: string;
  timeout: number;
  maxRetries: number;
}

export interface OpenAICompatibleClient {
  chat: {
    completions: {
      create(input: unknown): Promise<{
        choices: Array<{ message: { content: string | null } }>;
      }>;
    };
  };
}

export type OpenAIClientFactory = (
  options: OpenAIClientOptions,
) => OpenAICompatibleClient;

const defaultClientFactory: OpenAIClientFactory = (options) =>
  new OpenAI(options) as unknown as OpenAICompatibleClient;

export interface AiSettingsSource {
  get(): Promise<{
    baseUrl: string;
    model: string;
    keyConfigured: boolean;
  } | null>;
  getSecret(): Promise<string | null>;
}

export interface AnalyzeCompositionInput {
  config: AssignmentConfig;
  imageDataUrls: string[];
}

export class AiAdapterError extends Error {
  constructor(
    readonly code:
      | "AI_SETTINGS_INCOMPLETE"
      | "AI_REQUEST_FAILED"
      | "AI_INVALID_RESPONSE",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AiAdapterError";
  }
}

interface OpenAIReviewAdapterOptions {
  clientFactory?: OpenAIClientFactory;
}

const ENVELOPE_SCHEMA_SUMMARY = [
  "AiReviewEnvelope =",
  "{readable:false,pageWarnings:string[],annotations:Annotation[]}",
  "| {readable:true,pageWarnings:string[],report:EvaluationReport,annotations:Annotation[]};",
  "Annotation={pageIndex:integer,x:0..1,y:0..1,category:typo|punctuation|sentence|expression|structure|highlight,anchorText:string,comment:string,isHighlight:boolean};",
  "EvaluationReport={themeFit:fits|partial|off_topic,themeReason:string,personalizedComment:string,painPoints:string[],commonIssues:string[],revisionSuggestions:string[],scores:{themeIntent:0..10,contentSelection:0..10,structure:0..8,languageExpression:0..8,writingConventions:0..4,total:0..40,level:优秀作文|二类作文|重写},sampleParagraphs:string[]}",
].join("\n");

function buildPrompt(config: AssignmentConfig): string {
  const presetRule =
    config.templateType === "preset_self_applause"
      ? "预设《为自己喝彩》的修改后范文必须恰好五段，合计 550-650 个汉字。"
      : "自定义模板按用户的全部写作要求生成修改示例。";
  return [
    "你是一名面向上海五四学制六年级学生的作文老师，请使用学生友好、具体且鼓励性的语气。",
    `作业模板与自定义要求：${JSON.stringify(config)}`,
    "请逐页阅读全部图片。不可猜测看不清的字、标点或段落；任一关键页面不可辨认时设置 readable=false，pageWarnings 说明重拍方法，且绝对不要输出 report。",
    "评分为 40 分量表：themeIntent 主题立意 10 分，contentSelection 内容选材 10 分，structure 结构 8 分，languageExpression 语言表达 8 分，writingConventions 书写规范 4 分；total 必须等于分项之和，0-29 重写、30-35 二类作文、36-40 优秀作文。偏题或事件不完整不得超过 29 分。",
    "红批 annotation 类别只能为 typo（错别字）、punctuation（标点）、sentence（病句）、expression（表达）、structure（结构）、highlight（亮点）。anchorText 必须来自可辨认原文；不要臆造。",
    "图片上有 10x10 网格。每条批注用 pageIndex 和相对整页的 x/y 0..1 归一化坐标定位，坐标必须落在 0..1。",
    presetRule,
    "只返回一个 JSON 对象，不要 Markdown，不要解释。结构如下：",
    ENVELOPE_SCHEMA_SUMMARY,
  ].join("\n\n");
}

function parseJsonResponse(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```json\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

function validateEnvelope(
  value: unknown,
  config: AssignmentConfig,
  pageCount: number,
): AiReviewEnvelope {
  const envelope = aiReviewEnvelopeSchema.parse(value);
  for (const annotation of envelope.annotations) {
    if (annotation.pageIndex >= pageCount) {
      throw new Error("annotation.pageIndex exceeds supplied pages");
    }
  }
  if (!envelope.readable) return envelope;
  return {
    ...envelope,
    report: validateReport(envelope.report, {
      templateType: config.templateType,
    }),
  };
}

async function completionContent(
  client: OpenAICompatibleClient,
  request: unknown,
): Promise<string> {
  try {
    const completion = await client.chat.completions.create(request);
    const content = completion.choices[0]?.message.content;
    if (content === null || content === undefined) {
      throw new AiAdapterError(
        "AI_INVALID_RESPONSE",
        "AI 返回了空响应",
        502,
      );
    }
    return content;
  } catch (error) {
    if (error instanceof AiAdapterError) throw error;
    throw new AiAdapterError("AI_REQUEST_FAILED", "AI 服务请求失败", 502);
  }
}

export class OpenAIReviewAdapter {
  private readonly clientFactory: OpenAIClientFactory;

  constructor(
    private readonly settings: AiSettingsSource,
    options: OpenAIReviewAdapterOptions = {},
  ) {
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
  }

  async analyze(input: AnalyzeCompositionInput): Promise<AiReviewEnvelope> {
    if (input.imageDataUrls.length < 1 || input.imageDataUrls.length > 3) {
      throw new TypeError("imageDataUrls must contain 1 to 3 pages");
    }
    const [settings, apiKey] = await Promise.all([
      this.settings.get(),
      this.settings.getSecret(),
    ]);
    if (!settings || !apiKey) {
      throw new AiAdapterError(
        "AI_SETTINGS_INCOMPLETE",
        "请先配置 AI 服务地址、模型和 API Key",
        400,
      );
    }
    const client = this.clientFactory({
      apiKey,
      baseURL: settings.baseUrl,
      timeout: AI_TIMEOUT_MS,
      maxRetries: AI_MAX_RETRIES,
    });
    const content = await completionContent(client, {
      model: settings.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: buildPrompt(input.config) },
        {
          role: "user",
          content: [
            { type: "text", text: "请批改这些按页排序的作文图片。" },
            ...input.imageDataUrls.map((url) => ({
              type: "image_url",
              image_url: { url, detail: "high" },
            })),
          ],
        },
      ],
    });

    try {
      return validateEnvelope(
        parseJsonResponse(content),
        input.config,
        input.imageDataUrls.length,
      );
    } catch {
      const repaired = await completionContent(client, {
        model: settings.model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: `修复以下无效文本，使其严格符合 schema 并只返回 JSON。\n\n无效文本：\n${content}\n\nschema 摘要：\n${ENVELOPE_SCHEMA_SUMMARY}`,
          },
        ],
      });
      try {
        return validateEnvelope(
          parseJsonResponse(repaired),
          input.config,
          input.imageDataUrls.length,
        );
      } catch {
        throw new AiAdapterError(
          "AI_INVALID_RESPONSE",
          "AI 返回结果结构无效",
          502,
        );
      }
    }
  }
}

export interface TestConnectionInput {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export async function testOpenAIConnection(
  input: TestConnectionInput,
  clientFactory: OpenAIClientFactory = defaultClientFactory,
): Promise<void> {
  const client = clientFactory({
    apiKey: input.apiKey,
    baseURL: input.baseUrl,
    timeout: AI_TIMEOUT_MS,
    maxRetries: AI_MAX_RETRIES,
  });
  await completionContent(client, {
    model: input.model,
    messages: [{ role: "user", content: "只回复 OK" }],
    max_tokens: 8,
  });
}
