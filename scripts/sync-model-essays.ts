import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";

import { openAppDatabase } from "../src/db/client";
import { reviews } from "../src/db/schema";
import { evaluationReportSchema } from "../src/domain/contracts";
import {
  ocrParagraphIdsFromCheckpoint,
  planModelEssaySync,
  type ModelEssaySyncChange,
  type ModelEssaySyncSource,
} from "../src/domain/model-essay-sync";

const REMOTE_CONFIRM = "上线";
const DATABASE_NAME = "ai-composition-grader";

export interface SyncBackupEntry {
  id: string;
  studentName: string;
  title: string;
  revision: number;
  report: unknown;
  pdfFilename: string | null;
  pdfPath: string | null;
  pdfRevision: number | null;
  exportedAt: number | null;
  updatedAt: number | null;
}

export interface SyncBackupFile {
  createdAt: string;
  entries: SyncBackupEntry[];
}

export interface SyncEssayRow extends ModelEssaySyncSource {
  revision: number;
  pdfFilename: string | null;
  pdfPath: string | null;
  pdfRevision: number | null;
  exportedAt: number | null;
  updatedAt: number | null;
}

export interface SyncHeld {
  id: string;
  studentName: string;
  title: string;
  reason: string;
}

export interface SyncSummary {
  apply: boolean;
  target: "sqlite" | "d1";
  inspected: number;
  unchanged: number;
  changed: Array<Omit<ModelEssaySyncChange, "report">>;
  skipped: SyncHeld[];
  blocked: SyncHeld[];
  applied: number;
  backupPath: string | null;
}

export interface RollbackSummary {
  apply: boolean;
  restored: Array<{ id: string; studentName: string; title: string }>;
  skipped: SyncHeld[];
}

interface PlannedRow {
  row: SyncEssayRow;
  change: ModelEssaySyncChange;
}

type AppDatabase = ReturnType<typeof openAppDatabase>["db"];

interface EssayStore {
  target: "sqlite" | "d1";
  listReviewed(): SyncEssayRow[];
  writeReport(row: SyncEssayRow, report: unknown, now: Date): boolean;
  restore(entry: SyncBackupEntry): boolean;
}

function milliseconds(value: Date | number | string | null | undefined): number | null {
  if (value == null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function asJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function syncRowFromRecord(record: Record<string, unknown>): SyncEssayRow {
  const config = asJson(record.config);
  const configObject = config && typeof config === "object" ? config as {
    title?: unknown;
    structureRequirements?: unknown;
  } : {};
  return {
    id: textField(record.id),
    studentName: textField(record.studentName ?? record.student_name),
    title: textField(configObject.title ?? record.title),
    structureRequirements: typeof configObject.structureRequirements === "string"
      ? configObject.structureRequirements
      : typeof record.structureRequirements === "string"
        ? record.structureRequirements
        : undefined,
    teacherReviewedAt: (record.teacherReviewedAt ?? record.teacher_reviewed_at ?? null) as SyncEssayRow["teacherReviewedAt"],
    deletingAt: (record.deletingAt ?? record.deleting_at ?? null) as SyncEssayRow["deletingAt"],
    revision: nullableNumber(record.revision) ?? 0,
    report: record.report,
    ocrParagraphIds: ocrParagraphIdsFromCheckpoint(record.ocrCheckpoint ?? record.ocr_checkpoint),
    pdfFilename: nullableText(record.pdfFilename ?? record.pdf_filename),
    pdfPath: nullableText(record.pdfPath ?? record.pdf_path),
    pdfRevision: nullableNumber(record.pdfRevision ?? record.pdf_revision),
    exportedAt: nullableNumber(record.exportedAt ?? record.exported_at),
    updatedAt: nullableNumber(record.updatedAt ?? record.updated_at),
  };
}

function planRows(rows: readonly SyncEssayRow[], followModelParagraphs = false): {
  unchanged: number;
  planned: PlannedRow[];
  skipped: SyncHeld[];
  blocked: SyncHeld[];
} {
  const planned: PlannedRow[] = [];
  const skipped: SyncHeld[] = [];
  const blocked: SyncHeld[] = [];
  let unchanged = 0;
  for (const row of rows) {
    const plan = planModelEssaySync(row, { followModelParagraphs });
    if (plan.status === "unchanged" || plan.status === "out_of_scope") {
      if (plan.status === "unchanged") unchanged += 1;
      continue;
    }
    if (plan.status === "skipped") {
      skipped.push({ id: row.id, studentName: row.studentName, title: row.title, reason: plan.reason });
      continue;
    }
    if (plan.status === "blocked") {
      blocked.push({ id: row.id, studentName: row.studentName, title: row.title, reason: plan.reason });
      continue;
    }
    planned.push({ row, change: plan.change });
  }
  return { unchanged, planned, skipped, blocked };
}

function backupEntries(planned: readonly PlannedRow[]): SyncBackupEntry[] {
  return planned.map(({ row }) => ({
    id: row.id,
    studentName: row.studentName,
    title: row.title,
    revision: row.revision,
    report: asJson(row.report),
    pdfFilename: row.pdfFilename,
    pdfPath: row.pdfPath,
    pdfRevision: row.pdfRevision,
    exportedAt: row.exportedAt,
    updatedAt: row.updatedAt,
  }));
}

function publicChange(change: ModelEssaySyncChange): SyncSummary["changed"][number] {
  return {
    id: change.id,
    studentName: change.studentName,
    title: change.title,
    beforeEssayCount: change.beforeEssayCount,
    beforeReviewCount: change.beforeReviewCount,
    afterEssayCount: change.afterEssayCount,
    afterReviewCount: change.afterReviewCount,
    summary: change.summary,
  };
}

export function defaultBackupPath(databasePath: string | undefined, now: Date): string {
  const directory = databasePath
    ? path.dirname(path.resolve(databasePath))
    : path.resolve(".data");
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  return path.join(directory, `sync-model-essays-backup-${stamp}.json`);
}

export function writeSyncBackup(filePath: string, backup: SyncBackupFile): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(backup, null, 2)}\n`, { mode: 0o600 });
}

export function readSyncBackup(filePath: string): SyncBackupFile {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as SyncBackupFile;
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error("备份文件缺少 entries");
  }
  return parsed;
}

/**
 * 一次性把已审核作文的段落范文改成与完整范文逐字相同。
 * 默认不写库。apply 为 true 时先把原报告写成 JSON 备份，再更新。
 */
export function syncModelEssays(
  store: EssayStore,
  options: {
    apply: boolean;
    now?: Date;
    backupPath?: string;
    followModelParagraphs?: boolean;
    writeBackup?: (filePath: string, backup: SyncBackupFile) => void;
  },
): SyncSummary {
  const now = options.now ?? new Date();
  const rows = store.listReviewed();
  const { unchanged, planned, skipped, blocked } = planRows(rows, options.followModelParagraphs === true);
  let backupPath: string | null = null;
  let applied = 0;
  if (options.apply && planned.length > 0) {
    backupPath = options.backupPath ?? defaultBackupPath(process.env.APP_DATABASE_PATH, now);
    const writeBackup = options.writeBackup ?? writeSyncBackup;
    writeBackup(backupPath, {
      createdAt: now.toISOString(),
      entries: backupEntries(planned),
    });
    for (const item of planned) {
      if (store.writeReport(item.row, item.change.report, now)) applied += 1;
    }
  }
  return {
    apply: options.apply,
    target: store.target,
    inspected: rows.length,
    unchanged,
    changed: planned.map((item) => publicChange(item.change)),
    skipped,
    blocked,
    applied,
    backupPath,
  };
}

export function rollbackModelEssays(
  store: EssayStore,
  backup: SyncBackupFile,
  options: { apply: boolean },
): RollbackSummary {
  const current = new Map(store.listReviewed().map((row) => [row.id, row]));
  const restored: RollbackSummary["restored"] = [];
  const skipped: SyncHeld[] = [];
  for (const entry of backup.entries) {
    const row = current.get(entry.id);
    if (!row) {
      skipped.push({ id: entry.id, studentName: entry.studentName, title: entry.title, reason: "这篇作文不在当前已审核列表里" });
      continue;
    }
    if (row.revision !== entry.revision + 1) {
      skipped.push({
        id: entry.id,
        studentName: entry.studentName,
        title: entry.title,
        reason: `当前修订号是 ${row.revision}，不是备份时的 ${entry.revision + 1}，未回滚`,
      });
      continue;
    }
    if (!options.apply) {
      restored.push({ id: entry.id, studentName: entry.studentName, title: entry.title });
      continue;
    }
    if (store.restore(entry)) {
      restored.push({ id: entry.id, studentName: entry.studentName, title: entry.title });
    } else {
      skipped.push({ id: entry.id, studentName: entry.studentName, title: entry.title, reason: "回滚写入没有改到这一行" });
    }
  }
  return { apply: options.apply, restored, skipped };
}

export function formatSyncSummary(summary: SyncSummary): string {
  const mode = summary.apply ? "写入" : "dry-run（不写入）";
  const lines = [
    `模式：${mode}　目标：${summary.target === "d1" ? "远程 D1" : "本地 SQLite"}`,
    `已审核 ${summary.inspected} 篇，将修改 ${summary.changed.length} 篇，已逐字一致 ${summary.unchanged} 篇，跳过 ${summary.skipped.length} 篇，无法安全修改 ${summary.blocked.length} 篇。`,
    summary.apply ? `实际写入 ${summary.applied} 篇。` : "本次没有写入。",
  ];
  if (summary.backupPath) lines.push(`备份：${summary.backupPath}`);
  for (const item of summary.changed) {
    lines.push(
      [
        item.studentName,
        item.title,
        `改前 范文${item.beforeEssayCount}/段落${item.beforeReviewCount}`,
        `改后 范文${item.afterEssayCount}/段落${item.afterReviewCount}`,
        item.summary,
      ].join("\t"),
    );
  }
  for (const item of summary.skipped) lines.push(`跳过\t${item.studentName}\t${item.title}\t${item.reason}`);
  for (const item of summary.blocked) lines.push(`未改\t${item.studentName}\t${item.title}\t${item.reason}`);
  return lines.join("\n");
}

function sqliteStore(database: AppDatabase): EssayStore {
  return {
    target: "sqlite",
    listReviewed() {
      return database.select({
        id: reviews.id,
        studentName: reviews.studentName,
        config: reviews.config,
        report: reviews.report,
        revision: reviews.revision,
        teacherReviewedAt: reviews.teacherReviewedAt,
        deletingAt: reviews.deletingAt,
        ocrCheckpoint: reviews.ocrCheckpoint,
        pdfFilename: reviews.pdfFilename,
        pdfPath: reviews.pdfPath,
        pdfRevision: reviews.pdfRevision,
        exportedAt: reviews.exportedAt,
        updatedAt: reviews.updatedAt,
      }).from(reviews)
        .where(and(isNotNull(reviews.teacherReviewedAt), isNull(reviews.deletingAt)))
        .orderBy(asc(reviews.studentName), asc(reviews.id))
        .all()
        .map((row) => syncRowFromRecord({
          ...row,
          teacherReviewedAt: milliseconds(row.teacherReviewedAt),
          deletingAt: milliseconds(row.deletingAt),
          exportedAt: milliseconds(row.exportedAt),
          updatedAt: milliseconds(row.updatedAt),
        }));
    },
    writeReport(row, report, now) {
      const result = database.update(reviews).set({
        report: evaluationReportSchema.parse(report),
        revision: sql`${reviews.revision} + 1`,
        updatedAt: now,
        pdfFilename: null,
        pdfPath: null,
        pdfRevision: null,
        exportedAt: null,
      }).where(and(
        eq(reviews.id, row.id),
        eq(reviews.revision, row.revision),
        isNull(reviews.deletingAt),
      )).run();
      return result.changes === 1;
    },
    restore(entry) {
      const result = database.update(reviews).set({
        report: evaluationReportSchema.parse(entry.report),
        revision: entry.revision,
        updatedAt: entry.updatedAt == null ? new Date() : new Date(entry.updatedAt),
        pdfFilename: entry.pdfFilename,
        pdfPath: entry.pdfPath,
        pdfRevision: entry.pdfRevision,
        exportedAt: entry.exportedAt == null ? null : new Date(entry.exportedAt),
      }).where(and(
        eq(reviews.id, entry.id),
        eq(reviews.revision, entry.revision + 1),
        isNull(reviews.deletingAt),
      )).run();
      return result.changes === 1;
    },
  };
}

export function quoteSql(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

export function buildD1UpdateSql(row: SyncEssayRow, report: unknown, now: Date): string {
  return [
    "UPDATE reviews SET",
    `report = ${quoteSql(JSON.stringify(report))},`,
    "revision = revision + 1,",
    `updated_at = ${now.getTime()},`,
    "pdf_filename = NULL,",
    "pdf_path = NULL,",
    "pdf_revision = NULL,",
    "exported_at = NULL",
    `WHERE id = ${quoteSql(row.id)} AND revision = ${row.revision} AND deleting_at IS NULL;`,
  ].join(" ");
}

export function buildD1RestoreSql(entry: SyncBackupEntry): string {
  const exported = entry.exportedAt == null ? "NULL" : String(entry.exportedAt);
  const updated = entry.updatedAt == null ? "NULL" : String(entry.updatedAt);
  const pdfRevision = entry.pdfRevision == null ? "NULL" : String(entry.pdfRevision);
  return [
    "UPDATE reviews SET",
    `report = ${quoteSql(JSON.stringify(entry.report))},`,
    `revision = ${entry.revision},`,
    `updated_at = ${updated},`,
    `pdf_filename = ${entry.pdfFilename == null ? "NULL" : quoteSql(entry.pdfFilename)},`,
    `pdf_path = ${entry.pdfPath == null ? "NULL" : quoteSql(entry.pdfPath)},`,
    `pdf_revision = ${pdfRevision},`,
    `exported_at = ${exported}`,
    `WHERE id = ${quoteSql(entry.id)} AND revision = ${entry.revision + 1} AND deleting_at IS NULL;`,
  ].join(" ");
}

const REVIEWED_SELECT = [
  "SELECT id, student_name AS studentName, config, report, revision,",
  "teacher_reviewed_at AS teacherReviewedAt, deleting_at AS deletingAt,",
  "ocr_checkpoint AS ocrCheckpoint, pdf_filename AS pdfFilename, pdf_path AS pdfPath,",
  "pdf_revision AS pdfRevision, exported_at AS exportedAt, updated_at AS updatedAt",
  "FROM reviews WHERE teacher_reviewed_at IS NOT NULL AND deleting_at IS NULL",
  "ORDER BY student_name, id",
].join(" ");

export interface D1StatementResult {
  rows: Array<Record<string, unknown>>;
  changes: number;
}

export function parseD1Payload(payload: unknown): D1StatementResult {
  const batches = Array.isArray(payload) ? payload : [payload];
  const rows: Array<Record<string, unknown>> = [];
  let changes = 0;
  for (const batch of batches) {
    if (!batch || typeof batch !== "object") continue;
    const record = batch as { results?: unknown; meta?: { changes?: unknown }; changes?: unknown };
    if (Array.isArray(record.results)) {
      for (const row of record.results) {
        if (row && typeof row === "object") rows.push(row as Record<string, unknown>);
      }
    }
    const count = record.meta?.changes ?? record.changes;
    if (typeof count === "number") changes += count;
  }
  return { rows, changes };
}

function d1Store(execute: (statement: string) => D1StatementResult): EssayStore {
  return {
    target: "d1",
    listReviewed() {
      return execute(REVIEWED_SELECT).rows.map((row) => syncRowFromRecord(row));
    },
    writeReport(row, report, now) {
      return execute(buildD1UpdateSql(row, report, now)).changes === 1;
    },
    restore(entry) {
      return execute(buildD1RestoreSql(entry)).changes === 1;
    },
  };
}

export function createSqliteEssayStore(database: AppDatabase): EssayStore {
  return sqliteStore(database);
}

export function createD1EssayStore(execute: (statement: string) => D1StatementResult): EssayStore {
  return d1Store(execute);
}

function wranglerBinary(): string {
  return path.resolve("node_modules/.bin/wrangler");
}

export function executeRemoteD1(statement: string): D1StatementResult {
  const result = spawnSync(wranglerBinary(), [
    "d1",
    "execute",
    DATABASE_NAME,
    "--remote",
    "--json",
    "--command",
    statement,
  ], {
    encoding: "utf8",
    cwd: process.cwd(),
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
    throw new Error(detail || `wrangler d1 execute 退出码 ${result.status ?? "未知"}`);
  }
  return parseD1Payload(JSON.parse(result.stdout || "[]") as unknown);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

function usage(): string {
  return [
    "用法：npm run sync:model-essays -- --dry-run",
    "      npm run sync:model-essays -- --apply [--backup 备份.json]",
    "      npm run sync:model-essays -- --rollback 备份.json [--dry-run]",
    "      远程 D1 只读：npm run sync:model-essays -- --d1 --dry-run",
    "      远程 D1 写入必须同时带 --confirm 上线（本脚本不会自行对生产执行写入）。",
    "默认读写 APP_DATABASE_PATH 指向的本地 SQLite，不连接生产 D1。",
    "段数相同：改后全段改成完整范文的对应段。段数不同：按老师结构段数（没写明就是五段）重切，两边逐字相同。",
    "--follow-model-paragraphs：段数一律以完整范文为准；原文段数不够时，对不上原文的段整段按新增处理。",
    "--apply 会先把原报告导出成 JSON，再用 --rollback 该文件恢复。",
  ].join("\n");
}

function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

if (isDirectRun()) {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const apply = argv.includes("--apply");
  const remote = argv.includes("--d1");
  const followModelParagraphs = argv.includes("--follow-model-paragraphs");
  const rollbackPath = readOption(argv, "--rollback");
  const backupPath = readOption(argv, "--backup");
  const confirm = readOption(argv, "--confirm");
  const known = new Set(["--dry-run", "--apply", "--d1", "--rollback", "--backup", "--confirm", "--follow-model-paragraphs"]);
  const unexpected = argv.filter((argument, index) => {
    if (known.has(argument)) return false;
    const previous = argv[index - 1];
    return previous !== "--rollback" && previous !== "--backup" && previous !== "--confirm";
  });
  const conflicting = (dryRun && apply) || (rollbackPath !== undefined && apply);
  const missingRollbackFile = argv.includes("--rollback") && !rollbackPath;
  const missingBackupFile = argv.includes("--backup") && !backupPath;
  const missingConfirm = argv.includes("--confirm") && confirm === undefined;
  if (unexpected.length > 0 || conflicting || missingRollbackFile || missingBackupFile || missingConfirm || (!dryRun && !apply && !rollbackPath)) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
  } else if (remote && (apply || (rollbackPath && !dryRun)) && confirm !== REMOTE_CONFIRM) {
    process.stderr.write("远程 D1 写入被拒绝。需要 --confirm 上线，并且不要在未确认时执行 --apply。\n");
    process.exitCode = 2;
  } else {
    const opened = remote ? null : openAppDatabase(process.env.APP_DATABASE_PATH || undefined);
    try {
      const store = remote ? createD1EssayStore(executeRemoteD1) : createSqliteEssayStore(opened!.db);
      if (rollbackPath) {
        const backup = readSyncBackup(rollbackPath);
        const summary = rollbackModelEssays(store, backup, { apply: !dryRun });
        process.stdout.write(`${JSON.stringify(summary)}\n`);
      } else {
        const summary = syncModelEssays(store, {
          apply,
          backupPath,
          followModelParagraphs,
        });
        process.stdout.write(`${formatSyncSummary(summary)}\n`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    } finally {
      opened?.close();
    }
  }
}
