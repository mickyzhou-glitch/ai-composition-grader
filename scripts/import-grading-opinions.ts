import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";

import { openAppDatabase } from "../src/db/client";
import { analysisJobs, gradingOpinions, reviews } from "../src/db/schema";
import { opinionSourceTitle } from "../src/grading-opinions/grading-opinion-repository";
import {
  describeGradingOpinion,
  parseArchivedOpinionBody,
  parseRevisionTeacherGuidance,
} from "../src/grading-opinions/standing-guidance";
import { MAX_REVISION_FIELD_CHARS } from "../src/reanalysis/contracts";

export interface ImportedOpinion {
  jobId: string;
  ownerId: string;
  studentName: string;
  className: string;
  title: string;
  reason: string;
  changeRequest: string;
  paragraphLabel: string | null;
  category: string;
  action: "insert" | "link";
}

export interface ImportSummary {
  apply: boolean;
  inspected: number;
  skipped: number;
  imported: ImportedOpinion[];
  applied: number;
}

export interface TitleScopedOpinionPreview {
  title: string;
  count: number;
  opinions: Array<{
    id: string;
    text: string;
    category: string;
    studentName: string;
  }>;
}

type AppDatabase = ReturnType<typeof openAppDatabase>["db"];

/**
 * 把仍留在分析任务 teacher_guidance 里的旧退回说明纳入存档。
 * 只认 `[不合适原因]` / `[修改要求]`。这些旧意见分不出两个新框，一律记为仅当前文章，不写成长期规则。
 * 普通补充说明和只有长期规则清单的任务会跳过。
 * 作文已删除的任务会随评论级联消失，无法恢复。默认只列出，--apply 才写入。
 * 不连接生产库；要看哪一份本地库，设置 APP_DATABASE_PATH。
 */
export function importHistoricalGradingOpinions(
  database: AppDatabase,
  options: { apply: boolean; createId?: () => string } = { apply: false },
): ImportSummary {
  const jobs = database.select({
    jobId: analysisJobs.id,
    ownerId: analysisJobs.ownerId,
    reviewId: analysisJobs.reviewId,
    teacherGuidance: analysisJobs.teacherGuidance,
    createdAt: analysisJobs.createdAt,
    studentName: reviews.studentName,
    className: reviews.className,
    config: reviews.config,
  }).from(analysisJobs)
    .innerJoin(reviews, eq(reviews.id, analysisJobs.reviewId))
    .where(isNotNull(analysisJobs.teacherGuidance))
    .orderBy(asc(analysisJobs.createdAt), asc(analysisJobs.id))
    .all();

  const archivedJobIds = new Set(
    database.select({ sourceJobId: gradingOpinions.sourceJobId })
      .from(gradingOpinions)
      .where(isNotNull(gradingOpinions.sourceJobId))
      .all()
      .map((row) => row.sourceJobId)
      .filter((id): id is string => Boolean(id)),
  );
  const unclaimed = database.select().from(gradingOpinions)
    .where(isNull(gradingOpinions.sourceJobId))
    .orderBy(asc(gradingOpinions.createdAt), asc(gradingOpinions.id))
    .all();
  const claimedOpinionIds = new Set<string>();
  const imported: ImportedOpinion[] = [];
  let skipped = 0;

  const repair = (opinionId: string, reason: string, changeRequest: string) => {
    const described = describeGradingOpinion(reason, changeRequest);
    if (!described) return;
    database.update(gradingOpinions).set({
      reason: described.reason,
      changeRequest: described.changeRequest,
      paragraphLabel: described.paragraphLabel,
      category: described.category,
      body: described.body,
      scope: "essay",
    }).where(eq(gradingOpinions.id, opinionId)).run();
  };

  if (options.apply) {
    for (const opinion of unclaimed) {
      if (opinion.changeRequest.trim()) continue;
      const parsed = parseArchivedOpinionBody(opinion.body);
      if (!parsed) continue;
      repair(opinion.id, parsed.reason, parsed.changeRequest);
      opinion.reason = parsed.reason;
      opinion.changeRequest = parsed.changeRequest;
    }
  }

  for (const job of jobs) {
    if (archivedJobIds.has(job.jobId)) {
      skipped += 1;
      continue;
    }
    const parsed = parseRevisionTeacherGuidance(job.teacherGuidance);
    const described = parsed ? describeGradingOpinion(parsed.reason, parsed.changeRequest) : null;
    if (
      !described
      || described.reason.length > MAX_REVISION_FIELD_CHARS
      || described.changeRequest.length > MAX_REVISION_FIELD_CHARS
    ) {
      skipped += 1;
      continue;
    }
    const existing = unclaimed.find((opinion) => {
      const stored = storedOpinionFields(opinion);
      return !claimedOpinionIds.has(opinion.id)
        && opinion.ownerId === job.ownerId
        && opinion.sourceReviewId === job.reviewId
        && stored?.reason === described.reason
        && stored?.changeRequest === described.changeRequest;
    });
    const record: ImportedOpinion = {
      jobId: job.jobId,
      ownerId: job.ownerId,
      studentName: job.studentName,
      className: job.className,
      title: opinionSourceTitle(job.config),
      reason: described.reason,
      changeRequest: described.changeRequest,
      paragraphLabel: described.paragraphLabel,
      category: described.category,
      action: existing ? "link" : "insert",
    };
    imported.push(record);
    if (!options.apply) {
      if (existing) claimedOpinionIds.add(existing.id);
      continue;
    }
    if (existing) {
      claimedOpinionIds.add(existing.id);
      database.update(gradingOpinions).set({
        sourceJobId: job.jobId,
        reason: described.reason,
        changeRequest: described.changeRequest,
        paragraphLabel: described.paragraphLabel,
        category: described.category,
        body: described.body,
        scope: "essay",
      }).where(and(
        eq(gradingOpinions.id, existing.id),
        isNull(gradingOpinions.sourceJobId),
      )).run();
      continue;
    }
    database.insert(gradingOpinions).values({
      id: options.createId?.() ?? randomUUID(),
      ownerId: job.ownerId,
      body: described.body,
      reason: described.reason,
      changeRequest: described.changeRequest,
      paragraphLabel: described.paragraphLabel,
      category: described.category,
      scope: "essay",
      sourceReviewId: job.reviewId,
      sourceJobId: job.jobId,
      sourceStudentName: job.studentName,
      sourceClassName: job.className,
      sourceTitle: record.title,
      createdAt: job.createdAt,
      updatedAt: job.createdAt,
    }).run();
    archivedJobIds.add(job.jobId);
  }

  return {
    apply: options.apply,
    inspected: jobs.length,
    skipped,
    imported,
    applied: options.apply ? imported.length : 0,
  };
}

const commonOpinionPattern = /共性|结构|段/u;

/**
 * 只读列出「仅当前文章」里看起来像共性意见的记录，按来源题目分组。
 * 不改 scope，不写入。历史意见是否升成长期规则由老师看完这份清单再决定。
 */
export function previewStandingOpinionsByTitle(database: AppDatabase): TitleScopedOpinionPreview[] {
  const rows = database.select().from(gradingOpinions)
    .where(eq(gradingOpinions.scope, "essay"))
    .orderBy(asc(gradingOpinions.sourceTitle), asc(gradingOpinions.createdAt), asc(gradingOpinions.id))
    .all();
  const groups = new Map<string, TitleScopedOpinionPreview["opinions"]>();
  for (const row of rows) {
    const text = row.changeRequest.trim() || row.body.trim();
    if (row.category !== "结构" && !commonOpinionPattern.test(`${row.reason}${text}`)) continue;
    const title = row.sourceTitle.trim() || "未填写题目";
    const opinions = groups.get(title) ?? [];
    opinions.push({
      id: row.id,
      text,
      category: row.category,
      studentName: row.sourceStudentName,
    });
    groups.set(title, opinions);
  }
  return [...groups.entries()].map(([title, opinions]) => ({ title, count: opinions.length, opinions }));
}

function storedOpinionFields(opinion: { reason: string; changeRequest: string; body: string }) {
  if (opinion.reason.trim() && opinion.changeRequest.trim()) {
    return { reason: opinion.reason.trim(), changeRequest: opinion.changeRequest.trim() };
  }
  return parseArchivedOpinionBody(opinion.body);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const apply = process.argv.includes("--apply");
  const previewByTitle = process.argv.includes("--preview-standing-by-title");
  const unknown = process.argv.slice(2).filter((argument) => (
    argument !== "--apply" && argument !== "--preview-standing-by-title"
  ));
  if (unknown.length > 0 || (apply && previewByTitle)) {
    process.stderr.write("用法：npm run import:grading-opinions -- [--apply | --preview-standing-by-title]\n默认只列出可纳入存档的历史退回说明。加上 --apply 才写入。--preview-standing-by-title 只按题目列出可归入长期规则的历史共性意见，不能和 --apply 一起用，也不会写入。不会连接生产库。\n");
    process.exitCode = 2;
  } else {
    const opened = openAppDatabase(process.env.APP_DATABASE_PATH || undefined);
    try {
      if (previewByTitle) {
        process.stdout.write(`${JSON.stringify({ apply: false, preview: previewStandingOpinionsByTitle(opened.db) })}\n`);
      } else {
        const summary = importHistoricalGradingOpinions(opened.db, { apply });
        process.stdout.write(`${JSON.stringify(summary)}\n`);
      }
    } finally {
      opened.close();
    }
  }
}
