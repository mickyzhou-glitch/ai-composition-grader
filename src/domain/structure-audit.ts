import { z } from "zod";

/**
 * 范文结构复核的落库记录。每轮复核逐段、逐要素记下判定与范文原句证据，
 * 字数偏离由程序计数；返修后再复核的结果追加为新一轮，事后可以追溯。
 */
export const structureAuditElementSchema = z.object({
  requirement: z.string(),
  status: z.enum(["met", "unmet", "superseded"]),
  evidence: z.string(),
  /** 程序核对：met 时 evidence 能否在该段范文中找到。 */
  evidenceFound: z.boolean(),
}).strict();

export const structureAuditLengthSchema = z.object({
  actual: z.number().int().nonnegative(),
  minimum: z.number().int().nonnegative(),
  maximum: z.number().int().nonnegative(),
  requirement: z.string(),
  pass: z.boolean(),
}).strict();

export const structureAuditParagraphSchema = z.object({
  paragraph: z.number().int().positive(),
  pass: z.boolean(),
  elements: z.array(structureAuditElementSchema),
  length: structureAuditLengthSchema.optional(),
  reason: z.string(),
  /** 未通过的具体条目，返修时逐条作为硬约束。 */
  failures: z.array(z.string()),
}).strict();

export const structureAuditRoundSchema = z.object({
  round: z.number().int().nonnegative(),
  passed: z.boolean(),
  paragraphs: z.array(structureAuditParagraphSchema),
}).strict();

export const structureAuditSchema = z.object({
  version: z.literal(1),
  passed: z.boolean(),
  repairAttempts: z.number().int().nonnegative(),
  rounds: z.array(structureAuditRoundSchema),
  /** 复核或返修环节自身出错（模型返回无效）时的说明；结果仍保存，供老师人工核对。 */
  note: z.string().max(500).optional(),
}).strict();

export type StructureAuditElement = z.infer<typeof structureAuditElementSchema>;
export type StructureAuditParagraph = z.infer<typeof structureAuditParagraphSchema>;
export type StructureAuditRound = z.infer<typeof structureAuditRoundSchema>;
export type StructureAudit = z.infer<typeof structureAuditSchema>;
