import { z } from "zod";
import type { ReviewStatus } from "./contracts";

export const MAX_ROSTER_STUDENTS_PER_CLASS = 200;
export const MAX_ROSTER_CLASSES_PER_OWNER = 100;
export const MAX_ROSTER_STUDENT_NAME_CHARS = 50;
export const MAX_ROSTER_CLASS_NAME_CHARS = 50;

export interface ClassRosterView {
  className: string;
  students: string[];
  updatedAt: string;
}

export interface TitleSubmissionItemView {
  id: string;
  className: string;
  studentName: string;
  status: ReviewStatus;
  teacherReviewedAt: string | null;
}

export interface SubmittedStudentEntry {
  name: string;
  reviewId: string;
  status: ReviewStatus;
  teacherReviewedAt: string | null;
}

export interface UnmatchedSubmissionEntry {
  studentName: string;
  reviewId: string;
  status: ReviewStatus;
}

export interface ClassSubmissionBreakdown {
  className: string;
  totalRoster: number;
  submitted: SubmittedStudentEntry[];
  missing: string[];
  rejectedNames: string[];
  draftNames: string[];
  unmatchedSubmissions: UnmatchedSubmissionEntry[];
  unnamedSubmissionCount: number;
}

const ZERO_WIDTH_AND_CTRL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\uFEFF]/gu;
const CJK_INNER_SPACE_RE = /([\p{Script=Han}])[\s\u3000]+(?=[\p{Script=Han}])/gu;
const TWO_HAN_PADDED_RE = /^([\p{Script=Han}])[\s\u3000]+([\p{Script=Han}])$/u;
const PURE_HAN_RE = /^[\p{Script=Han}]+$/u;
const LEADING_INDEX_RE = /^\s*(?:第?\s*\d{1,3}\s*号|(?:[(（]\s*\d{1,3}\s*[)）])|\d{1,3}\s*[.．、)）:：-]\s*)\s*/u;
const INLINE_INDEX_SPLIT_RE = /\s+(?=(?:第?\s*\d{1,3}\s*号|[(（]\s*\d{1,3}\s*[)）]|\d{1,3}\s*[.．、)）]))/u;
const HEADER_NAME_ONLY_RE = /^(?:(?:序号|学号)[\s\t,，、|]+)?(?:学生)?姓名$/u;

function collapsePaddedSingleChineseName(value: string): string | null {
  const parts = value.trim().split(/[\s\u3000]+/u).filter(Boolean);
  if (parts.length < 2 || !parts.every((part) => PURE_HAN_RE.test(part))) {
    return null;
  }
  // 单字姓+双字名（张　小明）、复姓+单字名（欧阳　修）、二字对齐（张　三）或逐字空格（张 小 明）
  if (
    (parts.length === 2 && (codePointLength(parts[0]!) === 1 || codePointLength(parts[1]!) === 1))
    || parts.every((part) => codePointLength(part) === 1)
  ) {
    return parts.join("");
  }
  return null;
}

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

/**
 * 归一化单个学生姓名以便与提交记录比对：
 * 去除零宽字符、首尾空白，并合并汉字之间的排版对齐空格（如教务名单常见的「张　三」->「张三」），
 * 同时保留英文名中间的单空格（如「Tom Lee」）。
 */
export function normalizeStudentNameForMatch(name: string): string {
  return name
    .replace(/[\r\n\t]+/gu, " ")
    .replace(ZERO_WIDTH_AND_CTRL_RE, "")
    .trim()
    .replace(CJK_INNER_SPACE_RE, "$1")
    .replace(/[\s\u3000]+/gu, " ");
}

export function cleanSingleStudentName(raw: string): string {
  const stripped = raw
    .replace(/[\r\n\t]+/gu, " ")
    .replace(ZERO_WIDTH_AND_CTRL_RE, "")
    .replace(LEADING_INDEX_RE, "")
    .trim();
  if (!stripped || /^\d+$/u.test(stripped)) return "";
  const collapsedHan = collapsePaddedSingleChineseName(stripped);
  if (collapsedHan) {
    return collapsedHan;
  }
  const twoHan = TWO_HAN_PADDED_RE.exec(stripped);
  if (twoHan) {
    return `${twoHan[1]}${twoHan[2]}`;
  }
  return stripped.replace(/[\s\u3000]+/gu, " ");
}

export function deduplicateStudentNames(rawNames: readonly string[]): {
  students: string[];
  duplicateNames: string[];
  ignoredTooLong: string[];
} {
  const seen = new Set<string>();
  const students: string[] = [];
  const duplicateSet = new Set<string>();
  const ignoredTooLong: string[] = [];

  for (const raw of rawNames) {
    const cleaned = cleanSingleStudentName(raw);
    if (!cleaned) continue;
    if (codePointLength(cleaned) > MAX_ROSTER_STUDENT_NAME_CHARS) {
      ignoredTooLong.push(cleaned);
      continue;
    }
    const matchKey = normalizeStudentNameForMatch(cleaned);
    if (!matchKey) continue;
    if (seen.has(matchKey)) {
      duplicateSet.add(cleaned);
      continue;
    }
    seen.add(matchKey);
    students.push(cleaned);
  }

  return {
    students,
    duplicateNames: [...duplicateSet],
    ignoredTooLong,
  };
}

/**
 * 从教师粘贴或导入的单班名单文本中提取学生列表：
 * 支持换行、顿号、中英文逗号/分号、竖线、Tab、带序号名单（1. 张三 / 01\t张三）、
 * 单行空格分隔多个中文姓名（张三 李四 王五），以及教务表常见的二字姓名全角空格对齐（张　三）。
 */
export function parseRosterStudentText(raw: string): {
  students: string[];
  duplicateNames: string[];
  ignoredTooLong: string[];
} {
  const candidateTokens: string[] = [];
  const rawLines = raw.replace(ZERO_WIDTH_AND_CTRL_RE, "").split(/\r?\n/u);
  const lines = rawLines.flatMap((line) =>
    line.includes("\t") ? [line] : line.split(INLINE_INDEX_SPLIT_RE),
  );

  for (const rawLine of lines) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine || HEADER_NAME_ONLY_RE.test(trimmedLine)) continue;

    if (trimmedLine.includes("\t")) {
      const cols = trimmedLine.split("\t").map((col) => col.trim()).filter(Boolean);
      if (cols.length === 2 && /^\d{1,4}$/u.test(cols[0]!)) {
        candidateTokens.push(cols[1]!);
      } else {
        for (const col of cols) {
          if (!/^\d{1,4}$/u.test(col)) {
            candidateTokens.push(...col.split(/[,，、;；|]+/u));
          }
        }
      }
      continue;
    }

    const deindexed = trimmedLine.replace(LEADING_INDEX_RE, "").trim();
    if (!deindexed) continue;

    if (/[,，、;；|]/u.test(deindexed)) {
      candidateTokens.push(...deindexed.split(/[,，、;；|]+/u));
      continue;
    }

    const collapsedHan = collapsePaddedSingleChineseName(deindexed);
    if (collapsedHan) {
      candidateTokens.push(collapsedHan);
      continue;
    }
    if (/[A-Za-z]/u.test(deindexed)) {
      candidateTokens.push(deindexed);
      continue;
    }

    const parts = deindexed.split(/[\s\u3000]+/u).filter(Boolean);
    if (parts.length > 1) {
      for (const part of parts) {
        const cleanedPart = part.replace(LEADING_INDEX_RE, "").trim();
        if (cleanedPart && !/^\d{1,4}$/u.test(cleanedPart)) {
          candidateTokens.push(cleanedPart);
        }
      }
    } else {
      candidateTokens.push(deindexed);
    }
  }

  return deduplicateStudentNames(candidateTokens);
}

const MULTI_CLASS_HEADER_RE = /^(?:(?:序号|学号)[\s\t,，]+)?(?:班级|行政班|班别)[\s\t,，]+(?:学生)?姓名$/u;

/**
 * 解析从 Excel / CSV 粘贴的多班两列（班级 + 姓名，或 序号 + 班级 + 姓名）文本。
 */
export function parseMultiClassRosterText(raw: string): {
  rosters: Array<{ className: string; students: string[]; duplicateCount: number }>;
  skippedLines: number;
} {
  const byClass = new Map<string, string[]>();
  let skippedLines = 0;
  const lines = raw.replace(ZERO_WIDTH_AND_CTRL_RE, "").split(/\r?\n/u);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (MULTI_CLASS_HEADER_RE.test(trimmed)) continue;

    let cols: string[];
    if (trimmed.includes("\t")) {
      cols = trimmed.split("\t").map((item) => item.trim()).filter(Boolean);
    } else if (/[,，]/u.test(trimmed)) {
      cols = trimmed.split(/[,，]/u).map((item) => item.trim()).filter(Boolean);
    } else {
      cols = trimmed.split(/[\s\u3000]+/u).map((item) => item.trim()).filter(Boolean);
    }

    if (cols.length >= 3 && /^\d{1,4}$/u.test(cols[0]!)) {
      cols = cols.slice(1);
    }

    if (cols.length < 2) {
      skippedLines += 1;
      continue;
    }

    const className = cols[0]!.trim();
    const studentRaw = cols.slice(1).join(" ");
    if (
      !className
      || codePointLength(className) > MAX_ROSTER_CLASS_NAME_CHARS
      || /^(?:班级|行政班|班别)$/u.test(className)
    ) {
      skippedLines += 1;
      continue;
    }

    const existing = byClass.get(className) ?? [];
    existing.push(studentRaw);
    byClass.set(className, existing);
  }

  const rosters: Array<{ className: string; students: string[]; duplicateCount: number }> = [];
  for (const [className, rawStudents] of byClass.entries()) {
    const deduped = deduplicateStudentNames(rawStudents);
    if (deduped.students.length === 0) {
      skippedLines += rawStudents.length;
      continue;
    }
    rosters.push({
      className,
      students: deduped.students.slice(0, MAX_ROSTER_STUDENTS_PER_CLASS),
      duplicateCount: deduped.duplicateNames.length,
    });
  }

  return { rosters, skippedLines };
}

function submissionStatusPriority(status: ReviewStatus): number {
  if (status === "rejected") return 1;
  if (status === "draft") return 2;
  return 3;
}

export function computeClassSubmissionBreakdown(
  className: string,
  rosterStudents: readonly string[],
  submissions: readonly TitleSubmissionItemView[],
): ClassSubmissionBreakdown {
  const classSubmissions = submissions.filter((item) => (item.className ?? "") === className);
  const latestByNormalizedName = new Map<string, TitleSubmissionItemView>();
  let unnamedSubmissionCount = 0;

  for (const item of classSubmissions) {
    const key = normalizeStudentNameForMatch(item.studentName ?? "");
    if (!key) {
      unnamedSubmissionCount += 1;
      continue;
    }
    // 同名学生若既有重交正常稿又有历史打回/草稿记录，优先采用有效提交状态；同优先级下保留最新一条
    const existing = latestByNormalizedName.get(key);
    if (!existing || submissionStatusPriority(item.status) > submissionStatusPriority(existing.status)) {
      latestByNormalizedName.set(key, item);
    }
  }

  const matchedKeys = new Set<string>();
  const submitted: SubmittedStudentEntry[] = [];
  const missing: string[] = [];
  const rejectedNames: string[] = [];
  const draftNames: string[] = [];

  for (const student of rosterStudents) {
    const key = normalizeStudentNameForMatch(student);
    if (!key) continue;
    const matched = latestByNormalizedName.get(key);
    if (matched) {
      matchedKeys.add(key);
      submitted.push({
        name: student,
        reviewId: matched.id,
        status: matched.status,
        teacherReviewedAt: matched.teacherReviewedAt,
      });
      if (matched.status === "rejected") {
        rejectedNames.push(student);
      } else if (matched.status === "draft") {
        draftNames.push(student);
      }
    } else {
      missing.push(student);
    }
  }

  const unmatchedSubmissions: UnmatchedSubmissionEntry[] = [];
  for (const [key, item] of latestByNormalizedName.entries()) {
    if (!matchedKeys.has(key)) {
      unmatchedSubmissions.push({
        studentName: item.studentName.trim(),
        reviewId: item.id,
        status: item.status,
      });
    }
  }

  return {
    className,
    totalRoster: submitted.length + missing.length,
    submitted,
    missing,
    rejectedNames,
    draftNames,
    unmatchedSubmissions,
    unnamedSubmissionCount,
  };
}

export function formatMissingRosterCopyText(options: {
  className: string;
  title: string;
  missing: readonly string[];
  namesOnly?: boolean;
}): string {
  const { className, title, missing, namesOnly = false } = options;
  if (namesOnly) {
    return missing.join("、");
  }
  const prefix = className ? `${className}《${title}》` : `《${title}》`;
  if (missing.length === 0) {
    return `${prefix}全班已交齐`;
  }
  return `${prefix}未交名单（${missing.length}人）：${missing.join("、")}`;
}

const rosterClassNameSchema = z
  .string()
  .transform((val) => val.replace(/[\r\n\t]+/gu, " ").replace(ZERO_WIDTH_AND_CTRL_RE, "").trim())
  .refine((val) => val.length > 0 && codePointLength(val) <= MAX_ROSTER_CLASS_NAME_CHARS, {
    message: `班级名称需在 1 至 ${MAX_ROSTER_CLASS_NAME_CHARS} 个字符之间`,
  });

const rosterStudentItemSchema = z
  .string()
  .transform((val) => cleanSingleStudentName(val))
  .refine((val) => val.length > 0 && codePointLength(val) <= MAX_ROSTER_STUDENT_NAME_CHARS, {
    message: `学生姓名需在 1 至 ${MAX_ROSTER_STUDENT_NAME_CHARS} 个字符之间`,
  });

const singleRosterEntrySchema = z.object({
  className: rosterClassNameSchema,
  students: z
    .array(rosterStudentItemSchema)
    .min(1, "请至少填写 1 名学生")
    .max(MAX_ROSTER_STUDENTS_PER_CLASS, `单班最多支持 ${MAX_ROSTER_STUDENTS_PER_CLASS} 名学生`)
    .transform((items) => deduplicateStudentNames(items).students)
    .refine((items) => items.length > 0 && items.length <= MAX_ROSTER_STUDENTS_PER_CLASS),
}).strict();

export const upsertClassRostersInputSchema = z.union([
  z.object({
    className: rosterClassNameSchema,
    students: singleRosterEntrySchema.shape.students,
    mode: z.enum(["replace", "append"]).optional(),
  }).strict().transform((val) => ({
    rosters: [{ className: val.className, students: val.students }],
    mode: val.mode ?? "replace",
  })),
  z.object({
    rosters: z
      .array(singleRosterEntrySchema)
      .min(1)
      .max(MAX_ROSTER_CLASSES_PER_OWNER),
    mode: z.enum(["replace", "append"]).optional(),
  }).strict().transform((val) => ({
    rosters: val.rosters,
    mode: val.mode ?? "replace",
  })),
]);

export type UpsertClassRostersInput = z.infer<typeof upsertClassRostersInputSchema>;
export const deleteClassRosterNameSchema = rosterClassNameSchema;
