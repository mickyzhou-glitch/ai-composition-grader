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

export const ocrCheckpointSchema = z.object({
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

export const reviewAnnotationAnchorSchema = z.object({
  pageIndex: z.number().int().nonnegative(),
  category: annotationCategorySchema,
  anchorText: z.string().trim().min(1),
  comment: z.string().trim().min(1),
  isHighlight: z.boolean(),
}).strict();

export type OcrBlock = z.infer<typeof ocrBlockSchema>;
export type OcrPage = z.infer<typeof ocrPageSchema>;
export type OcrCheckpoint = z.infer<typeof ocrCheckpointSchema>;
export type ReviewAnnotationAnchor = z.infer<typeof reviewAnnotationAnchorSchema>;
