import OpenAI from "openai";
import { z } from "zod";

import {
  evaluationReportSchema,
  type AssignmentConfig,
  type EvaluationReport,
} from "../domain/contracts";
import { reviewAnnotationAnchorSchema, type ReviewAnnotationAnchor } from "../ocr/contracts";
import { completionContent, parseJsonResponse, roleClient } from "./adapter-shared";
import {
  AiAdapterError,
  type AiSettingsSource,
  type OpenAIClientFactory,
  type OpenAICompatibleClient,
} from "./openai-review-adapter";
import { validateGeneratedReportSemantics } from "./review-semantics";

const resultSchema = z.object({
  report: evaluationReportSchema,
  annotationAnchors: z.array(reviewAnnotationAnchorSchema),
}).strict();

export interface AnalyzeOcrTextInput {
  config: AssignmentConfig;
  pages: Array<{ pageIndex: number; text: string }>;
  teacherGuidance?: string;
  studentName?: string;
}

export interface CompositionReviewResult {
  report: EvaluationReport;
  annotationAnchors: ReviewAnnotationAnchor[];
}

function contentPrompt(input: AnalyzeOcrTextInput): string {
  const studentName = input.studentName?.trim();
  return [
    "你是一名有十五年上海小升初教学经验的语文老师，负责依据已识别的作文原文完成批改。",
    `作文要求：${JSON.stringify(input.config)}`,
    `学生姓名数据（仅用于家长反馈称呼）：${JSON.stringify(studentName || null)}`,
    input.teacherGuidance?.trim() ? `教师补充意见：${input.teacherGuidance.trim()}` : "",
    "生成主题判断、2-4 条简洁优点、2-4 条具体修改项、最终等级、四维诊断、示范段落和三种家长反馈。",
    "annotationAnchors 只返回 pageIndex、category、anchorText、comment、isHighlight；不得返回 x、y 或其他图片坐标。anchorText 必须逐字来自相应页原文。",
    "只返回 JSON：{report:EvaluationReport,annotationAnchors:ReviewAnnotationAnchor[]}。",
  ].filter(Boolean).join("\n\n");
}

export class CompositionReviewAdapter {
  private readonly clientFactory: OpenAIClientFactory;

  constructor(
    private readonly settings: AiSettingsSource,
    options: { clientFactory?: OpenAIClientFactory } = {},
  ) {
    this.clientFactory = options.clientFactory ?? ((clientOptions) =>
      new OpenAI(clientOptions) as unknown as OpenAICompatibleClient);
  }

  async analyzeText(input: AnalyzeOcrTextInput): Promise<CompositionReviewResult> {
    if (input.pages.length < 1 || input.pages.some((page, index) => page.pageIndex !== index)) {
      throw new TypeError("pages must use continuous zero-based indexes");
    }
    const { client, model } = await roleClient(this.settings, this.clientFactory, "content");
    const content = await completionContent(client, {
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: contentPrompt(input) },
        { role: "user", content: JSON.stringify({ pages: input.pages }) },
      ],
    });
    try {
      const parsed = resultSchema.parse(parseJsonResponse(content));
      if (parsed.annotationAnchors.some(({ pageIndex }) => pageIndex >= input.pages.length)) {
        throw new Error("annotation page exceeds OCR pages");
      }
      return {
        report: validateGeneratedReportSemantics(parsed.report, input.config, input.studentName),
        annotationAnchors: parsed.annotationAnchors,
      };
    } catch {
      throw new AiAdapterError("AI_INVALID_RESPONSE", "作文内容模型返回结果结构无效", 502);
    }
  }
}
