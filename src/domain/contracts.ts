import { z } from "zod";

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

export const scoreLevelSchema = z.enum(["优秀作文", "二类作文", "重写"]);
export type ScoreLevel = z.infer<typeof scoreLevelSchema>;

export const scoreBreakdownSchema = z.object({
  themeIntent: z.number().int().min(0).max(10),
  contentSelection: z.number().int().min(0).max(10),
  structure: z.number().int().min(0).max(8),
  languageExpression: z.number().int().min(0).max(8),
  writingConventions: z.number().int().min(0).max(4),
  total: z.number().int().min(0).max(40),
  level: scoreLevelSchema,
});
export type ScoreBreakdown = z.infer<typeof scoreBreakdownSchema>;

export const sampleParagraphSchema = z.object({
  title: z.string().trim().min(1),
  text: z.string().trim().min(1),
  suggestion: z.string().trim().min(1),
});
export type SampleParagraph = z.infer<typeof sampleParagraphSchema>;

export const evaluationReportSchema = z.object({
  themeFit: z.enum(["fits", "partial", "off_topic"]),
  themeReason: z.string().trim().min(1),
  personalizedComment: z.string().trim().min(1),
  painPoints: z.array(z.string()),
  commonIssues: z.array(z.string()),
  revisionSuggestions: z.array(z.string()),
  scores: scoreBreakdownSchema,
  sampleParagraphs: z.array(sampleParagraphSchema).min(1).max(10),
});

export const EvaluationReportSchema = evaluationReportSchema;
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;

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
    if (totalCharacters < 550 || totalCharacters > 650) {
      context.addIssue({
        code: "custom",
        path: ["sampleParagraphs"],
        message:
          "preset_self_applause sample paragraphs require 550-650 Chinese characters in total",
      });
    }
  });
}

// PascalCase aliases keep schemas easy to discover alongside their inferred types.
export const AssignmentConfigSchema = assignmentConfigSchema;
export const ReviewStatusSchema = reviewStatusSchema;
export const AnnotationSchema = annotationSchema;
export const ScoreBreakdownSchema = scoreBreakdownSchema;

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
export type AiReviewEnvelope = z.infer<typeof AiReviewEnvelopeSchema>;
