import { z } from "zod";

export const MAX_TEXTBOOK_IMAGES = 4;
export const MAX_TEXTBOOK_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_TEXTBOOK_IMAGE_BYTES = 5 * 1024 * 1024;
export const TEXTBOOK_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

const textbookImageSchema = z.string()
  .max(4 * Math.ceil(MAX_TEXTBOOK_IMAGE_BYTES / 3) + 32, "课本图片过大，请压缩后重试")
  .refine((value) => {
    const [header, data, extra] = value.split(",");
    if (extra !== undefined || !/^data:image\/(?:jpeg|png|webp);base64$/u.test(header)) return false;
    if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) return false;
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    return data.length / 4 * 3 - padding <= MAX_TEXTBOOK_IMAGE_BYTES;
  }, "请上传有效的 JPG、PNG 或 WebP 课本图片");

export const assignmentGuidanceInputSchema = z.object({
  title: z.string().trim().max(120),
  grade: z.string().trim().min(1).max(120),
  targetCharacters: z.number().int().positive().max(3_000),
  textbookImages: z.array(textbookImageSchema).max(MAX_TEXTBOOK_IMAGES).optional(),
}).strict().refine((value) => value.title.length > 0 || Boolean(value.textbookImages?.length), {
  message: "请填写作文题目或上传课本图片", path: ["title"],
});

export const assignmentGuidanceSchema = z.object({
  writingRequirements: z.string().trim().min(1).max(1_500),
  structureRequirements: z.string().trim().min(1).max(1_500),
  scoringFocus: z.string().trim().min(1).max(1_500),
  title: z.string().trim().min(1).max(120).optional(),
  targetCharacters: z.number().int().positive().max(3_000).optional(),
}).strict();

export type AssignmentGuidanceInput = z.infer<typeof assignmentGuidanceInputSchema>;
export type AssignmentGuidance = z.infer<typeof assignmentGuidanceSchema>;
