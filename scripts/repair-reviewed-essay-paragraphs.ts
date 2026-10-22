import { pathToFileURL } from "node:url";

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { openAppDatabase } from "../src/db/client";
import { reviews } from "../src/db/schema";
import { planReviewedEssayRepair } from "../src/domain/essay-paragraph-sync";

export interface RepairSummary {
  apply: boolean;
  inspected: number;
  changed: Array<{ id: string; studentName: string; title: string }>;
  applied: number;
}

type AppDatabase = ReturnType<typeof openAppDatabase>["db"];

/**
 * 一次性修复已审核作文：以完整范文为准，用审核页「同步到逐段」的同一切分
 * 覆盖各段改后全段。不重新分析，不改变审核状态。默认只列出，--apply 才写入。
 */
export function repairReviewedEssays(
  database: AppDatabase,
  options: { apply: boolean; now?: Date },
): RepairSummary {
  const now = options.now ?? new Date();
  const rows = database
    .select({
      id: reviews.id,
      studentName: reviews.studentName,
      config: reviews.config,
      report: reviews.report,
      revision: reviews.revision,
      teacherReviewedAt: reviews.teacherReviewedAt,
      deletingAt: reviews.deletingAt,
    })
    .from(reviews)
    .where(and(isNotNull(reviews.teacherReviewedAt), isNull(reviews.deletingAt)))
    .all();
  const changed: RepairSummary["changed"] = [];
  let applied = 0;
  for (const row of rows) {
    const repair = planReviewedEssayRepair({
      id: row.id,
      studentName: row.studentName,
      title: row.config.title ?? "",
      teacherReviewedAt: row.teacherReviewedAt,
      deletingAt: row.deletingAt,
      report: row.report,
    });
    if (!repair) continue;
    changed.push({ id: repair.id, studentName: repair.studentName, title: repair.title });
    if (!options.apply) continue;
    const result = database
      .update(reviews)
      .set({
        report: repair.report,
        revision: sql`${reviews.revision} + 1`,
        updatedAt: now,
        pdfFilename: null,
        pdfPath: null,
        pdfRevision: null,
        exportedAt: null,
      })
      .where(and(
        eq(reviews.id, row.id),
        eq(reviews.revision, row.revision),
        isNull(reviews.deletingAt),
      ))
      .run();
    if (result.changes === 1) applied += 1;
  }
  return { apply: options.apply, inspected: rows.length, changed, applied };
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
    process.stderr.write("用法：npm run repair:reviewed-paragraphs -- [--apply]\n默认只列出将修改的已审核作文。加上 --apply 才按完整范文覆盖改后全段。\n");
    process.exitCode = 2;
  } else {
    const opened = openAppDatabase(process.env.APP_DATABASE_PATH || undefined);
    try {
      const summary = repairReviewedEssays(opened.db, { apply });
      process.stdout.write(`${JSON.stringify(summary)}\n`);
    } finally {
      opened.close();
    }
  }
}
