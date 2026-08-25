import { z } from "zod";

import { annotationCategorySchema } from "../domain/contracts";

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

function isAfterInReadingOrder(
  previous: OcrParagraphSegment,
  current: OcrParagraphSegment,
): boolean {
  if (current.pageIndex !== previous.pageIndex) {
    return current.pageIndex > previous.pageIndex;
  }
  if (current.y !== previous.y) return current.y > previous.y;
  return current.x > previous.x;
}

function regionsOverlap(
  first: OcrParagraphSegment,
  second: OcrParagraphSegment,
): boolean {
  return first.x < second.x + second.width
    && second.x < first.x + first.width
    && first.y < second.y + second.height
    && second.y < first.y + first.height;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, "");
}

export const ocrCheckpointV2Schema = z.object({
  version: z.literal(2),
  sourceRevision: z.number().int().nonnegative(),
  ocrRevision: z.number().int().nonnegative(),
  editedAt: z.string().datetime().nullable(),
  pages: z.array(ocrPageSchema).min(1).max(4),
  paragraphs: z.array(ocrParagraphSchema).min(1),
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
      && normalizeWhitespace(paragraph.text)
        !== normalizeWhitespace(paragraph.segments.map(({ text }) => text).join(""))
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

export type OcrBlock = z.infer<typeof ocrBlockSchema>;
export type OcrPage = z.infer<typeof ocrPageSchema>;
export type OcrCheckpointV1 = z.infer<typeof ocrCheckpointV1Schema>;
export type OcrParagraphSegment = z.infer<typeof ocrParagraphSegmentSchema>;
export type OcrParagraph = z.infer<typeof ocrParagraphSchema>;
export type OcrCheckpointV2 = z.infer<typeof ocrCheckpointV2Schema>;
export type OcrCheckpoint = z.infer<typeof ocrCheckpointSchema>;
export type ReviewAnnotationAnchor = z.infer<typeof reviewAnnotationAnchorSchema>;

export function isOcrCheckpointV2(value: unknown): value is OcrCheckpointV2 {
  return ocrCheckpointV2Schema.safeParse(value).success;
}

export function createOcrCheckpointV2(input: {
  sourceRevision: number;
  ocrRevision?: number;
  editedAt?: string | null;
  pages: OcrPage[];
  paragraphs: Array<Omit<OcrParagraph, "id"> & { id?: unknown }>;
}): OcrCheckpointV2 {
  const paragraphs = input.paragraphs.map((paragraph, index) => {
    const paragraphWithoutModelId = { ...paragraph };
    delete paragraphWithoutModelId.id;
    return {
      ...paragraphWithoutModelId,
      id: `paragraph-${index + 1}`,
    };
  });

  return ocrCheckpointV2Schema.parse({
    ...input,
    version: 2,
    ocrRevision: input.ocrRevision ?? 0,
    editedAt: input.editedAt ?? null,
    paragraphs,
  });
}
