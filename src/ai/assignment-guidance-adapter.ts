import { z } from "zod";
import OpenAI from "openai";

import {
  AiAdapterError,
  type AiSettingsSource,
  type OpenAIClientFactory,
  type OpenAICompatibleClient,
} from "./openai-review-adapter";

const AI_TIMEOUT_MS = 180_000;
const AI_MAX_RETRIES = 1;

const inputSchema = z.object({
  title: z.string().trim().min(1).max(120),
  grade: z.string().trim().min(1).max(120),
  targetCharacters: z.number().int().positive().max(3_000),
}).strict();

const guidanceSchema = z.object({
  writingRequirements: z.string().trim().min(1).max(1_500),
  structureRequirements: z.string().trim().min(1).max(1_500),
  scoringFocus: z.string().trim().min(1).max(1_500),
}).strict();

export type AssignmentGuidanceInput = z.infer<typeof inputSchema>;
export type AssignmentGuidance = z.infer<typeof guidanceSchema>;

// Keep this import boundary aligned with the existing OpenAI-compatible
// review adapter: the configured platform key never reaches the browser.
const defaultClientFactory: OpenAIClientFactory = (options) =>
  new OpenAI(options) as unknown as OpenAICompatibleClient;

function parseJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

export class AssignmentGuidanceAdapter {
  private readonly clientFactory: OpenAIClientFactory;

  constructor(
    private readonly settings: AiSettingsSource,
    options: { clientFactory?: OpenAIClientFactory } = {},
  ) {
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
  }

  async generate(input: AssignmentGuidanceInput): Promise<AssignmentGuidance> {
    const requestInput = inputSchema.parse(input);
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
    let content: string;
    try {
      const completion = await client.chat.completions.create({
        model: settings.model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: [
              "你是上海五四学制初中语文作文教学助手。",
              "根据题目生成一版可供教师编辑的写作要求、结构要求和评分侧重。",
              "要求贴合指定年级和字数，不虚构题目背景；语言具体、学生可执行。",
              "只返回 JSON：{writingRequirements:string,structureRequirements:string,scoringFocus:string}。",
            ].join("\n"),
          },
          { role: "user", content: JSON.stringify(requestInput) },
        ],
      });
      content = completion.choices[0]?.message.content ?? "";
    } catch {
      throw new AiAdapterError("AI_REQUEST_FAILED", "AI 服务请求失败", 502);
    }
    try {
      return guidanceSchema.parse(parseJson(content));
    } catch {
      throw new AiAdapterError("AI_INVALID_RESPONSE", "AI 返回结果结构无效", 502);
    }
  }
}
