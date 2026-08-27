import { z } from "zod";

import { annotationCategorySchema } from "../domain/contracts";

const NORMALIZED_COORDINATE_TOLERANCE = 1e-6;
const SAME_LINE_MIN_VERTICAL_OVERLAP_RATIO = 0.5;
const ENGLISH_OR_NUMBER_CHARACTER_PATTERN = /^[A-Za-z0-9]$/u;

export const ocrBlockSchema = z.object({
  text: z.string().trim().min(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).strict()
  .refine((block) => block.x + block.width <= 1, {
    message: "OCR block must fit within the page width",
  })
  .refine((block) => block.y + block.height <= 1, {
    message: "OCR block must fit within the page height",
  });

export const ocrPageSchema = z.object({
  pageIndex: z.number().int().nonnegative(),
  text: z.string(),
  readable: z.boolean(),
  warnings: z.array(z.string().trim().min(1)),
  blocks: z.array(ocrBlockSchema),
}).strict();

export const ocrCheckpointV1Schema = z.object({
  version: z.literal(1),
  sourceRevision: z.number().int().nonnegative(),
  ocrRevision: z.number().int().nonnegative(),
  editedAt: z.string().datetime().nullable(),
  pages: z.array(ocrPageSchema).min(1).max(4),
}).strict().superRefine((checkpoint, context) => {
  checkpoint.pages.forEach((page, index) => {
    if (page.pageIndex !== index) {
      context.addIssue({
        code: "custom",
        path: ["pages", index, "pageIndex"],
        message: "OCR pages must use continuous zero-based indexes",
      });
    }
  });
});

export const ocrParagraphSegmentSchema = z.object({
  pageIndex: z.number().int().nonnegative(),
  text: z.string().trim().min(1),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().positive().max(1),
  height: z.number().positive().max(1),
}).strict()
  .refine((segment) => segment.x + segment.width <= 1, {
    message: "OCR paragraph segment must fit within the page width",
  })
  .refine((segment) => segment.y + segment.height <= 1, {
    message: "OCR paragraph segment must fit within the page height",
  });

export const ocrParagraphSchema = z.object({
  id: z.string().regex(/^paragraph-[1-9]\d*$/u),
  paragraphIndex: z.number().int().nonnegative(),
  text: z.string().trim().min(1),
  segments: z.array(ocrParagraphSegmentSchema).min(1),
}).strict();

function axisOverlapAmount(
  firstStart: number,
  firstLength: number,
  secondStart: number,
  secondLength: number,
): number {
  return Math.min(firstStart + firstLength, secondStart + secondLength)
    - Math.max(firstStart, secondStart);
}

function areSegmentsOnSameLine(
  first: OcrParagraphSegment,
  second: OcrParagraphSegment,
): boolean {
  const verticalOverlap = axisOverlapAmount(first.y, first.height, second.y, second.height);
  if (verticalOverlap <= NORMALIZED_COORDINATE_TOLERANCE) return false;
  return verticalOverlap / Math.min(first.height, second.height)
    >= SAME_LINE_MIN_VERTICAL_OVERLAP_RATIO;
}

function isAfterInReadingOrder(
  previous: OcrParagraphSegment,
  current: OcrParagraphSegment,
): boolean {
  if (current.pageIndex !== previous.pageIndex) {
    return current.pageIndex > previous.pageIndex;
  }
  if (areSegmentsOnSameLine(previous, current)) {
    return current.x - previous.x > NORMALIZED_COORDINATE_TOLERANCE;
  }
  return current.y - previous.y > NORMALIZED_COORDINATE_TOLERANCE;
}

function regionsOverlap(
  first: OcrParagraphSegment,
  second: OcrParagraphSegment,
): boolean {
  const horizontalOverlap = axisOverlapAmount(first.x, first.width, second.x, second.width);
  const verticalOverlap = axisOverlapAmount(first.y, first.height, second.y, second.height);
  return horizontalOverlap > NORMALIZED_COORDINATE_TOLERANCE
    && verticalOverlap > NORMALIZED_COORDINATE_TOLERANCE;
}

function isEnglishOrNumberCharacter(value: string | undefined): boolean {
  return value !== undefined && ENGLISH_OR_NUMBER_CHARACTER_PATTERN.test(value);
}

function normalizeParagraphWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, (whitespace, offset, source) => {
    const previous = source[offset - 1];
    const next = source[offset + whitespace.length];
    return isEnglishOrNumberCharacter(previous) && isEnglishOrNumberCharacter(next)
      ? " "
      : "";
  });
}

function combineParagraphSegmentText(segments: OcrParagraphSegment[]): string {
  return segments.map((segment, index) => {
    const previous = segments[index - 1];
    if (!previous) return segment.text;
    const previousCharacter = previous.text[previous.text.length - 1];
    const nextCharacter = segment.text[0];
    const separator = isEnglishOrNumberCharacter(previousCharacter)
      && isEnglishOrNumberCharacter(nextCharacter)
      ? " "
      : "";
    return `${separator}${segment.text}`;
  }).join("");
}

const ocrCheckpointV2BaseShape = {
  version: z.literal(2),
  sourceRevision: z.number().int().nonnegative(),
  ocrRevision: z.number().int().nonnegative(),
  editedAt: z.string().datetime().nullable(),
  pages: z.array(ocrPageSchema).min(1).max(4),
};

type OcrCheckpointV2ValidationInput = {
  editedAt: string | null;
  pages: OcrPage[];
  paragraphs: Array<Pick<OcrParagraph, "paragraphIndex" | "text" | "segments">>;
};

function validateOcrCheckpointV2BusinessRules(
  checkpoint: OcrCheckpointV2ValidationInput,
  context: z.RefinementCtx,
): void {
  checkpoint.pages.forEach((page, index) => {
    if (page.pageIndex !== index) {
      context.addIssue({
        code: "custom",
        path: ["pages", index, "pageIndex"],
        message: "OCR pages must use continuous zero-based indexes",
      });
    }
  });

  const pageIndexes = new Set(checkpoint.pages.map(({ pageIndex }) => pageIndex));
  checkpoint.paragraphs.forEach((paragraph, paragraphIndex) => {
    if (paragraph.paragraphIndex !== paragraphIndex) {
      context.addIssue({
        code: "custom",
        path: ["paragraphs", paragraphIndex, "paragraphIndex"],
        message: "OCR paragraphs must use continuous zero-based indexes",
      });
    }

    paragraph.segments.forEach((segment, segmentIndex) => {
      if (!pageIndexes.has(segment.pageIndex)) {
        context.addIssue({
          code: "custom",
          path: ["paragraphs", paragraphIndex, "segments", segmentIndex, "pageIndex"],
          message: "OCR paragraph segments must reference an existing page",
        });
      }

      const previous = paragraph.segments[segmentIndex - 1];
      if (previous && !isAfterInReadingOrder(previous, segment)) {
        context.addIssue({
          code: "custom",
          path: ["paragraphs", paragraphIndex, "segments", segmentIndex],
          message: "OCR paragraph segments must follow page, y, and x reading order",
        });
      }
    });

    if (
      checkpoint.editedAt === null
      && normalizeParagraphWhitespace(paragraph.text)
        !== normalizeParagraphWhitespace(combineParagraphSegmentText(paragraph.segments))
    ) {
      context.addIssue({
        code: "custom",
        path: ["paragraphs", paragraphIndex, "text"],
        message: "Initial paragraph text must match its ordered segment text after whitespace normalization",
      });
    }
  });

  checkpoint.paragraphs.forEach((firstParagraph, firstParagraphIndex) => {
    checkpoint.paragraphs.slice(firstParagraphIndex + 1).forEach((secondParagraph, offset) => {
      const secondParagraphIndex = firstParagraphIndex + offset + 1;
      firstParagraph.segments.forEach((firstSegment) => {
        secondParagraph.segments.forEach((secondSegment, secondSegmentIndex) => {
          if (
            firstSegment.pageIndex === secondSegment.pageIndex
            && regionsOverlap(firstSegment, secondSegment)
          ) {
            context.addIssue({
              code: "custom",
              path: ["paragraphs", secondParagraphIndex, "segments", secondSegmentIndex],
              message: "OCR paragraph regions from different paragraphs must not overlap on one page",
            });
          }
        });
      });
    });
  });
}

const ocrCheckpointV2CandidateSchema = z.object({
  ...ocrCheckpointV2BaseShape,
  paragraphs: z.array(ocrParagraphSchema.omit({ id: true })).min(1),
}).strict().superRefine(validateOcrCheckpointV2BusinessRules);

export const ocrCheckpointV2Schema = z.object({
  ...ocrCheckpointV2BaseShape,
  paragraphs: z.array(ocrParagraphSchema).min(1),
}).strict()
  .superRefine(validateOcrCheckpointV2BusinessRules)
  .superRefine((checkpoint, context) => {
    checkpoint.paragraphs.forEach((paragraph, paragraphIndex) => {
      if (paragraph.id !== `paragraph-${paragraphIndex + 1}`) {
        context.addIssue({
          code: "custom",
          path: ["paragraphs", paragraphIndex, "id"],
          message: "OCR paragraphs must use unique stable IDs matching their array order",
        });
      }
    });
  });

export const ocrCheckpointSchema = z.union([
  ocrCheckpointV2Schema,
  ocrCheckpointV1Schema,
]);

export const reviewAnnotationAnchorSchema = z.object({
  pageIndex: z.number().int().nonnegative(),
  category: annotationCategorySchema,
  anchorText: z.string().trim().min(1),
  comment: z.string().trim().min(1),
  isHighlight: z.boolean(),
}).strict();

export const paragraphAnnotationAnchorSchema = z.object({
  paragraphId: z.string().regex(/^paragraph-[1-9]\d*$/u),
  category: annotationCategorySchema,
  anchorText: z.string().trim().min(1),
  comment: z.string().trim().min(1),
  isHighlight: z.boolean(),
}).strict();

export type OcrBlock = z.infer<typeof ocrBlockSchema>;
export type OcrPage = z.infer<typeof ocrPageSchema>;
export type OcrCheckpointV1 = z.infer<typeof ocrCheckpointV1Schema>;
export type OcrParagraphSegment = z.infer<typeof ocrParagraphSegmentSchema>;
export type OcrParagraph = z.infer<typeof ocrParagraphSchema>;
export type OcrCheckpointV2 = z.infer<typeof ocrCheckpointV2Schema>;
export type OcrCheckpoint = z.infer<typeof ocrCheckpointSchema>;
export type ReviewAnnotationAnchor = z.infer<typeof reviewAnnotationAnchorSchema>;
export type ParagraphAnnotationAnchor = z.infer<typeof paragraphAnnotationAnchorSchema>;

export function isOcrCheckpointV2(value: OcrCheckpoint): value is OcrCheckpointV2 {
  return value.version === 2;
}

export function createOcrCheckpointV2(input: {
  sourceRevision: number;
  ocrRevision?: number;
  editedAt?: string | null;
  pages: OcrPage[];
  paragraphs: Array<Omit<OcrParagraph, "id"> & { id?: unknown }>;
}): OcrCheckpointV2 {
  const candidate = ocrCheckpointV2CandidateSchema.parse({
    version: 2,
    sourceRevision: input.sourceRevision,
    ocrRevision: input.ocrRevision ?? 0,
    editedAt: input.editedAt ?? null,
    pages: input.pages,
    paragraphs: input.paragraphs.map((paragraph) => ({
      paragraphIndex: paragraph.paragraphIndex,
      text: paragraph.text,
      segments: paragraph.segments,
    })),
  });

  return {
    ...candidate,
    paragraphs: candidate.paragraphs.map((paragraph, index) => ({
      ...paragraph,
      id: `paragraph-${index + 1}`,
    })),
  };
}
