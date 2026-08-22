import { z } from "zod";

export const EMPTY_DRAFT_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Versioned acknowledgement required before the first real composition upload. */
export const PRIVACY_NOTICE_VERSION = "2026-07-22";
export const privacyUploadConsentSchema = z.object({
  confirmed: z.literal(true),
  version: z.literal(PRIVACY_NOTICE_VERSION),
});
export type PrivacyUploadConsent = z.infer<typeof privacyUploadConsentSchema>;

export const templateTypeSchema = z.enum([
  "preset_self_applause",
  "custom",
]);
export type TemplateType = z.infer<typeof templateTypeSchema>;

export const assignmentConfigSchema = z.object({
  title: z.string().trim().min(1),
  grade: z.string().trim().min(1).default("上海五四学制六年级"),
  writingRequirements: z.string().trim().min(1),
  targetCharacters: z.number().int().positive().default(600),
  structureRequirements: z.string().trim().min(1),
  scoringFocus: z.string().trim().min(1),
  templateType: templateTypeSchema,
});
export type AssignmentConfig = z.infer<typeof assignmentConfigSchema>;

export const reviewStatusSchema = z.enum([
  "draft",
  "analyzing",
  "needs_better_images",
  "ready_for_review",
  "exported",
  "failed",
]);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const studentNameSchema = z.string().trim().max(50);
export const MAX_REVIEW_IMAGES = 4;

export const annotationCategorySchema = z.enum([
  "typo",
  "punctuation",
  "sentence",
  "expression",
  "structure",
  "highlight",
]);

export const annotationSchema = z.object({
  pageIndex: z.number().int().nonnegative(),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  category: annotationCategorySchema,
  anchorText: z.string(),
  comment: z.string(),
  isHighlight: z.boolean(),
});
export type Annotation = z.infer<typeof annotationSchema>;

export const normalizedCropSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .refine((crop) => crop.x + crop.width <= 1, {
    message: "crop.x + crop.width must be at most 1",
  })
  .refine((crop) => crop.y + crop.height <= 1, {
    message: "crop.y + crop.height must be at most 1",
  });
export type NormalizedCrop = z.infer<typeof normalizedCropSchema>;

export const compositionGradeSchema = z.enum(["A+", "A", "A-", "B+", "B", "B-", "C"]);
export type CompositionGrade = z.infer<typeof compositionGradeSchema>;

/** @deprecated 使用 compositionGradeSchema。保留别名仅供渐进迁移。 */
export const scoreLevelSchema = compositionGradeSchema;
/** @deprecated 使用 CompositionGrade。 */
export type ScoreLevel = CompositionGrade;

export const diagnosticItemSchema = z.object({
  finding: z.string().trim().min(1),
  action: z.string().trim().min(1),
});

export const diagnosticsSchema = z.object({
  authenticityAndRelevance: diagnosticItemSchema,
  materialAndDetails: diagnosticItemSchema,
  structure: diagnosticItemSchema,
  language: diagnosticItemSchema,
});
export type Diagnostics = z.infer<typeof diagnosticsSchema>;

const legacyScoreBreakdownSchema = z.object({
  themeIntent: z.number().int().min(0).max(10),
  contentSelection: z.number().int().min(0).max(10),
  structure: z.number().int().min(0).max(8),
  languageExpression: z.number().int().min(0).max(8),
  writingConventions: z.number().int().min(0).max(4),
  total: z.number().int().min(0).max(40),
  level: z.enum(["优秀作文", "二类作文", "重写"]),
});

/** 将历史 40 分记录映射到新的七档等级，供旧报告无损升级使用。 */
export function gradeFromLegacyTotal(total: number): CompositionGrade {
  if (!Number.isInteger(total) || total < 0 || total > 40) {
    throw new RangeError("legacy total must be an integer from 0 to 40");
  }
  if (total <= 29) return "C";
  if (total <= 31) return "B-";
  if (total <= 33) return "B";
  if (total <= 35) return "B+";
  if (total === 36) return "A-";
  if (total <= 38) return "A";
  return "A+";
}

export const sampleParagraphSchema = z.object({
  title: z.string().trim().min(1),
  text: z.string().trim().min(1),
  suggestion: z.string().trim().min(1),
});
export type SampleParagraph = z.infer<typeof sampleParagraphSchema>;

export const parentFeedbackStyleSchema = z.enum(["warm", "professional", "concise"]);
export type ParentFeedbackStyle = z.infer<typeof parentFeedbackStyleSchema>;

const parentFeedbackTextSchema = z.object({
  title: z.string().trim().min(1),
  content: z.string().trim().min(1),
});
const warmParentFeedbackSchema = parentFeedbackTextSchema.extend({ style: z.literal("warm") });
const professionalParentFeedbackSchema = parentFeedbackTextSchema.extend({ style: z.literal("professional") });
const conciseParentFeedbackSchema = parentFeedbackTextSchema.extend({ style: z.literal("concise") });
export const parentFeedbackSchema = z.discriminatedUnion("style", [
  warmParentFeedbackSchema,
  professionalParentFeedbackSchema,
  conciseParentFeedbackSchema,
]);
export type ParentFeedback = z.infer<typeof parentFeedbackSchema>;

const parentFeedbacksSchema = z.union([
  z.tuple([]),
  z.tuple([
    warmParentFeedbackSchema,
    professionalParentFeedbackSchema,
    conciseParentFeedbackSchema,
  ]),
]).default([]);

const reportBaseSchema = z.object({
  themeFit: z.enum(["fits", "partial", "off_topic"]),
  themeReason: z.string().trim().min(1),
  personalizedComment: z.string().trim().min(1),
  painPoints: z.array(z.string()),
  commonIssues: z.array(z.string()),
  revisionSuggestions: z.array(z.string()),
  sampleParagraphs: z.array(sampleParagraphSchema).min(1).max(10),
  parentFeedbacks: parentFeedbacksSchema,
});

const currentEvaluationReportSchema = reportBaseSchema.extend({
  grade: compositionGradeSchema,
  diagnostics: diagnosticsSchema,
});
type CurrentEvaluationReport = z.infer<typeof currentEvaluationReportSchema>;

const legacyEvaluationReportSchema = reportBaseSchema.extend({
  scores: legacyScoreBreakdownSchema,
});

function legacyDiagnostics(report: z.infer<typeof legacyEvaluationReportSchema>): Diagnostics {
  return {
    authenticityAndRelevance: {
      finding: report.themeReason,
      action: report.themeFit === "off_topic"
        ? "回到题目要求，删去无关内容，补写能体现主题的真实经历。"
        : "检查每一段是否都服务于结尾的感悟，并补上一处真实的选择或感受。",
    },
    materialAndDetails: {
      finding: "历史报告未保留细节描写诊断。",
      action: "从原文中选一个关键场景，补写人物动作、心理和环境中的具体细节。",
    },
    structure: {
      finding: "历史报告未保留五段结构诊断。",
      action: "按开篇点题、事件发展、关键转折、行动结果、回扣感悟检查段落。",
    },
    language: {
      finding: "历史报告未保留语言衔接诊断。",
      action: "检查段首时间词，改用承接情绪、动作或因果关系的句子。",
    },
  };
}

/**
 * 新报告只保存等级和四维诊断；历史 40 分报告在读入时自动转换，
 * 这样既不再向界面暴露旧分数，也不会让已有记录失效。
 */
export const evaluationReportSchema = z.union([
  currentEvaluationReportSchema,
  legacyEvaluationReportSchema,
]).transform((report): z.infer<typeof currentEvaluationReportSchema> => {
  if ("grade" in report) return report;
  return {
    ...report,
    grade: gradeFromLegacyTotal(report.scores.total),
    diagnostics: legacyDiagnostics(report),
  };
});
export const EvaluationReportSchema = evaluationReportSchema;
/**
 * 持久化层与旧测试夹具可能仍携带 scores；读取和保存时会由 schema
 * 归一化为 CurrentEvaluationReport。界面层据此提供安全的历史回退。
 */
export type EvaluationReport = Omit<CurrentEvaluationReport, "grade" | "diagnostics" | "parentFeedbacks"> & {
  grade?: CompositionGrade;
  diagnostics?: Diagnostics;
  scores?: z.infer<typeof legacyScoreBreakdownSchema>;
  parentFeedbacks?: ParentFeedback[];
};

function countChineseCharacters(value: string): number {
  return value.match(/\p{Script=Han}/gu)?.length ?? 0;
}

export function createEvaluationReportSchema(templateType: TemplateType) {
  return evaluationReportSchema.superRefine((report, context) => {
    if (templateType !== "preset_self_applause") {
      return;
    }

    if (report.sampleParagraphs.length !== 5) {
      context.addIssue({
        code: "custom",
        path: ["sampleParagraphs"],
        message: "preset_self_applause requires exactly 5 sample paragraphs",
      });
    }

    const totalCharacters = report.sampleParagraphs.reduce(
      (total, paragraph) => total + countChineseCharacters(paragraph.text),
      0,
    );
    if (totalCharacters < 600 || totalCharacters > 700) {
      context.addIssue({
        code: "custom",
        path: ["sampleParagraphs"],
        message:
          "preset_self_applause sample paragraphs require 600-700 Chinese characters in total",
      });
    }
  });
}

// PascalCase aliases keep schemas easy to discover alongside their inferred types.
export const AssignmentConfigSchema = assignmentConfigSchema;
export const ReviewStatusSchema = reviewStatusSchema;
export const AnnotationSchema = annotationSchema;
export const ScoreBreakdownSchema = legacyScoreBreakdownSchema;

const readableAiReviewEnvelopeSchema = z
  .object({
    readable: z.literal(true),
    pageWarnings: z.array(z.string().trim().min(1)),
    report: evaluationReportSchema,
    annotations: z.array(annotationSchema),
  })
  .strict();

const unreadableAiReviewEnvelopeSchema = z
  .object({
    readable: z.literal(false),
    pageWarnings: z.array(z.string().trim().min(1)).min(1),
    annotations: z.array(annotationSchema),
  })
  .strict();

export const aiReviewEnvelopeSchema = z.discriminatedUnion("readable", [
  readableAiReviewEnvelopeSchema,
  unreadableAiReviewEnvelopeSchema,
]);
export const AiReviewEnvelopeSchema = aiReviewEnvelopeSchema;
export type AiReviewEnvelope =
  | { readable: true; pageWarnings: string[]; report: EvaluationReport; annotations: Annotation[] }
  | { readable: false; pageWarnings: string[]; annotations: Annotation[] };
