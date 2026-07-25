import OpenAI from "openai";
import { z } from "zod";

import {
  aiReviewEnvelopeSchema,
  sampleParagraphSchema,
  type AiReviewEnvelope,
  type AssignmentConfig,
} from "../domain/contracts";
import { deriveLevel, validateReport } from "../domain/report-validation";

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
  getRuntimeConfig(): Promise<{
    baseUrl: string;
    model: string;
    apiKey: string;
  } | null>;
}

export interface AnalyzeCompositionInput {
  config: AssignmentConfig;
  imageDataUrls: string[];
}

export interface RewriteSampleInput {
  config: AssignmentConfig;
  sampleParagraphs: Array<{ title: string; text: string; suggestion: string }>;
  index: number;
  instruction?: string;
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
  "EvaluationReport={themeFit:fits|partial|off_topic,themeReason:string,personalizedComment:string,painPoints:string[],commonIssues:string[],revisionSuggestions:string[],scores:{themeIntent:0..10,contentSelection:0..10,structure:0..8,languageExpression:0..8,writingConventions:0..4,total:0..40,level:优秀作文|二类作文|重写},sampleParagraphs:{title:string,text:string,suggestion:string}[]}",
].join("\n");

function buildPrompt(config: AssignmentConfig): string {
  const fiveParagraphRule =
    "必须逐段核对学生原文是否具备五段式：①开篇点题并交代情境；②事件起因与发展；③困难、转折或关键细节；④自己的行动、突破与结果；⑤回扣题目并写出真实感悟。题目给出的 structureRequirements 优先于此默认名称。缺段、合段混乱、转折缺失或结尾未升华时，必须在对应原文位置给出 structure 批注。";
  const sampleRule =
    "sampleParagraphs 必须恰好五段，按上述五段式或题目指定结构排列；title 要能说明段落任务。示范文须保留学生原有核心事件和表达气质，不虚构关键经历；仅 text 合计控制在 550-650 个汉字，每段 suggestion 给出一句可执行的写法提醒。写前先理清“谁、和谁、因为什么、经过什么、结果怎样”的单一事件线：同一关系只用同一个称呼和人物，不得把朋友、同学、老师等无关人物混入同一事件；原文出现人物关系断裂、无关争吵或枝节时，示范文必须直接删去、合并或改写为与核心人物一致的情节，绝不保留多余人物。";
  return [
    "你是一名熟悉上海五四学制、尤其是五升六小升初阶段的语文作文老师。请使用学生友好、具体且鼓励性的语气，评价标准以六年级记叙文的真实、具体、完整、清楚为准。",
    `作业模板与自定义要求：${JSON.stringify(config)}`,
    "请逐页阅读全部图片。不可猜测看不清的字、标点或段落；任一关键页面不可辨认时设置 readable=false，pageWarnings 说明重拍方法，且绝对不要输出 report。",
    "评分为 40 分量表：themeIntent 主题立意 10 分，contentSelection 内容选材 10 分，structure 结构 8 分，languageExpression 语言表达 8 分，writingConventions 书写规范 4 分；total 必须等于分项之和，0-29 重写、30-35 二类作文、36-40 优秀作文。偏题或事件不完整不得超过 29 分。",
    "这版批改只检查段落结构、事件完整性与前后衔接。不要批改错别字、书写、标点、病句或普通字词表达的小问题。annotation 只能使用 structure（结构），anchorText 必须来自可辨认原文；不要臆造。",
    "对结构问题使用 annotation，批注要短而可执行，能明确指出缺少哪一段、该补什么或该如何调整。原稿导出时只会显示红圈与红线，不会显示文字批注；因此每条 annotation 必须定位到确实能辨认的整句或段落起点。坐标拿不准时不要生成 annotation，绝不圈画单个字或猜测的位置。",
    "图片上有 10x10 网格。每条批注用 pageIndex 和相对整页的 x/y 0..1 归一化坐标定位，坐标必须落在 0..1。",
    fiveParagraphRule,
    sampleRule,
    "只返回一个 JSON 对象，不要 Markdown，不要解释。结构如下：",
    ENVELOPE_SCHEMA_SUMMARY,
  ].join("\n\n");
}

function buildRepairPrompt(
  content: string,
  config: AssignmentConfig,
  pageCount: number,
): string {
  const sampleRule =
    "sampleParagraphs 必须恰好五段对象，并严格遵循当前 AssignmentConfig 的 structureRequirements；仅 text 字段合计 550-650 个汉字，保留学生原有核心事件，不虚构关键经历。必须把人物关系和事件因果统一成一条主线：删去或合并多余人物、无关争吵和枝节，绝不保留人物称呼前后矛盾的写法。";

  return [
    "修复以下无效文本，使其严格符合 schema 和全部业务不变量，并只返回 JSON。",
    `无效文本：\n${content}`,
    `运行时页面约束：pageCount=${pageCount}，annotation.pageIndex 必须是整数 0..${pageCount - 1}。`,
    `当前 AssignmentConfig：${JSON.stringify(config)}`,
    "五段结构核对：①开篇点题并交代情境；②事件起因与发展；③困难、转折或关键细节；④自己的行动、突破与结果；⑤回扣题目并写出真实感悟。题目 structureRequirements 优先。结构问题要用 annotation.category=structure 标注在原文确实能辨认的整句或段落起点；坐标不确定则不要标注。",
    "评分不变量：themeIntent 0..10、contentSelection 0..10、structure 0..8、languageExpression 0..8、writingConventions 0..4；total 必须等于五项之和；0-29 重写、30-35 二类作文、36-40 优秀作文；偏题或事件不完整时 total 不得超过 29。",
    sampleRule,
    `schema 摘要：\n${ENVELOPE_SCHEMA_SUMMARY}`,
  ].join("\n\n");
}

function parseJsonResponse(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
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
  const scores = envelope.report.scores;
  const total =
    scores.themeIntent +
    scores.contentSelection +
    scores.structure +
    scores.languageExpression +
    scores.writingConventions;
  return {
    ...envelope,
    report: validateReport(
      {
        ...envelope.report,
        scores: { ...scores, total, level: deriveLevel(total) },
      },
      { templateType: config.templateType },
    ),
  };
}

async function completionContent(
  client: OpenAICompatibleClient,
  request: unknown,
): Promise<string> {
  try {
    const completion = await client.chat.completions.create(request);
    const content = completion.choices[0]?.message.content;
    return content ?? "";
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
    if (
      input.imageDataUrls.some(
        (url) => !/^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url),
      )
    ) {
      throw new TypeError("every composition page must be an image data URL");
    }
    const settings = await this.settings.getRuntimeConfig();
    if (!settings) {
      throw new AiAdapterError(
        "AI_SETTINGS_INCOMPLETE",
        "请先配置 AI 服务地址、模型和 API Key",
        400,
      );
    }
    const client = this.clientFactory({
      apiKey: settings.apiKey,
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
            content: buildRepairPrompt(
              content,
              input.config,
              input.imageDataUrls.length,
            ),
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

  async rewriteSample(input: RewriteSampleInput): Promise<{ text: string }> {
    if (!Number.isInteger(input.index) || input.index < 0 || input.index >= input.sampleParagraphs.length) {
      throw new TypeError("sample paragraph index is invalid");
    }
    const settings = await this.settings.getRuntimeConfig();
    if (!settings) {
      throw new AiAdapterError("AI_SETTINGS_INCOMPLETE", "请先配置 AI 服务地址、模型和 API Key", 400);
    }
    const client = this.clientFactory({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
      timeout: AI_TIMEOUT_MS,
      maxRetries: AI_MAX_RETRIES,
    });
    const current = input.sampleParagraphs[input.index];
    const content = await completionContent(client, {
      model: settings.model,
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content: [
          "你是上海五升六学生的作文老师。请只重写指定的一段考场范文，保持其与其他四段前后衔接。",
          `作文要求：${JSON.stringify(input.config)}`,
          `五段范文：${JSON.stringify(input.sampleParagraphs)}`,
          `要重写第 ${input.index + 1} 段：${JSON.stringify(current)}`,
          `教师附加要求：${input.instruction?.trim() || "请换一种更具体、更自然的写法。"}`,
          "必须坚持一条清楚的事件线，统一人物称呼和关系；删除无关人物、无关争吵与枝节，不得凭空增添关键经历。只返回 JSON：{\"text\":\"重写后的这一段正文\"}。",
        ].join("\n\n"),
      }],
    });
    try {
      return z.object({ text: z.string().trim().min(1).max(2_000) }).parse(parseJsonResponse(content));
    } catch {
      throw new AiAdapterError("AI_INVALID_RESPONSE", "AI 返回的示范段落无效", 502);
    }
  }

  async rewriteAllSamples(input: Omit<RewriteSampleInput, "index">): Promise<{
    sampleParagraphs: Array<{ title: string; text: string; suggestion: string }>;
  }> {
    const settings = await this.settings.getRuntimeConfig();
    if (!settings) {
      throw new AiAdapterError("AI_SETTINGS_INCOMPLETE", "请先配置 AI 服务地址、模型和 API Key", 400);
    }
    const client = this.clientFactory({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
      timeout: AI_TIMEOUT_MS,
      maxRetries: AI_MAX_RETRIES,
    });
    const content = await completionContent(client, {
      model: settings.model,
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content: [
          "你是上海五升六学生的作文老师。请重写整篇五段考场范文，不要只改一段。",
          `作文要求：${JSON.stringify(input.config)}`,
          `当前五段范文：${JSON.stringify(input.sampleParagraphs)}`,
          `教师附加要求：${input.instruction?.trim() || "请整体提升细节、逻辑和前后衔接。"}`,
          "必须输出严格五段。人物称呼、关系、时间顺序和事件因果必须统一；只保留一条核心事件线，删去无关人物、无关争吵和枝节，不得凭空增加关键经历。五段 text 合计 550-650 个汉字。只返回 JSON：{\"sampleParagraphs\":[{\"title\":\"\",\"text\":\"\",\"suggestion\":\"\"}]}。",
        ].join("\n\n"),
      }],
    });
    try {
      return z.object({ sampleParagraphs: z.array(sampleParagraphSchema).length(5) }).parse(parseJsonResponse(content));
    } catch {
      throw new AiAdapterError("AI_INVALID_RESPONSE", "AI 返回的整篇示范文无效", 502);
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
  const content = await completionContent(client, {
    model: input.model,
    messages: [{ role: "user", content: "只回复 OK" }],
    max_tokens: 8,
  });
  if (content.trim().length === 0) {
    throw new AiAdapterError("AI_INVALID_RESPONSE", "AI 返回了空响应", 502);
  }
}
