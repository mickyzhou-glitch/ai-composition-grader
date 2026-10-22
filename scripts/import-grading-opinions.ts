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

type AppDatabase = ReturnType<typeof openAppDatabase>["db"];

/**
 * 把仍留在分析任务 teacher_guidance 里的「提交后台修改并继续」两项说明纳入批改意见存档。
 * 只认 `[不合适原因]` / `[修改要求]`。普通补充说明和只有长期规则清单的任务会跳过。
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
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--apply");
  if (unknown.length > 0) {
    process.stderr.write("用法：npm run import:grading-opinions -- [--apply]\n默认只列出可纳入存档的历史退回说明。加上 --apply 才写入。不会连接生产库。\n");
    process.exitCode = 2;
  } else {
    const opened = openAppDatabase(process.env.APP_DATABASE_PATH || undefined);
    try {
      const summary = importHistoricalGradingOpinions(opened.db, { apply });
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } finally {
      opened.close();
    }
  }
}
