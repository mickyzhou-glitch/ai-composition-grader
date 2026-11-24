import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import Database from "better-sqlite3";

import {
  cursorFromSummaryRow,
  EXPECTED_SUMMARY_KEY_SQL,
  MAX_SUMMARY_BACKFILL_BATCH,
  runSummaryBackfillCursorStep,
  selectStaleSummaryRows,
  type SummaryBackfillCursor,
} from "../src/cloudflare/review-summary-state";
import { deliveryReadiness } from "../src/delivery/readiness";
import { evaluationReportSchema, isLegacyEvaluationReport } from "../src/domain/contracts";
import { publicOcrView, readStoredOcrCheckpoint } from "../src/ocr/contracts";

const DATABASE_NAME = "ai-composition-grader";
const DEFAULT_REMOTE_MAX_BUFFER = 64 * 1024 * 1024;

function serializeRemoteD1Text(text: string): string {
  // Node spawnSync 严禁命令行参数出现字面 U+0000（会抛 ERR_INVALID_ARG_VALUE），且 SQLite C 字符串词法遇 NUL 会截断：
  // 含 U+0000 时改用纯 ASCII 十六进制 UTF-8 BLOB 强转 TEXT，既 100% 无损保留逐个码点，又保证命令参数零 NUL。
  if (text.includes("\u0000")) {
    return `CAST(X'${Buffer.from(text, "utf8").toString("hex")}' AS TEXT)`;
  }
  return `'${text.replace(/'/gu, "''")}'`;
}

export function bindSqlForRemoteD1(sql: string, bindings: readonly unknown[]): string {
  let index = 0;
  return sql.replace(/\?/gu, () => {
    const value = bindings[index];
    index += 1;
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
    if (typeof value === "boolean") return value ? "1" : "0";
    return serializeRemoteD1Text(String(value));
  });
}

function parseWranglerD1Rows(payload: unknown): { rows: Array<Record<string, unknown>>; changes: number } {
  const first = Array.isArray(payload) ? payload[0] : payload;
  if (!first || typeof first !== "object") return { rows: [], changes: 0 };
  const record = first as { results?: unknown; meta?: { changes?: unknown } };
  const rows = Array.isArray(record.results) ? (record.results as Array<Record<string, unknown>>) : [];
  const changes = typeof record.meta?.changes === "number" ? record.meta.changes : 0;
  return { rows, changes };
}

export function executeRemoteD1Sql(
  statement: string,
  maxBuffer = DEFAULT_REMOTE_MAX_BUFFER,
): { rows: Array<Record<string, unknown>>; changes: number } {
  const result = spawnSync(path.resolve("node_modules/.bin/wrangler"), [
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
    maxBuffer,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
    throw new Error(detail || `wrangler d1 execute 退出码 ${result.status ?? "未知"}`);
  }
  return parseWranglerD1Rows(JSON.parse(result.stdout || "[]") as unknown);
}

export function isBufferLimitError(error: unknown): boolean {
  if (!error) return false;
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code === "ENOBUFS" || code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || /ENOBUFS|maxBuffer/iu.test(message);
}

export function createRemoteD1Adapter(
  dryRun: boolean,
  executeFn: (statement: string) => { rows: Array<Record<string, unknown>>; changes: number } = executeRemoteD1Sql,
): D1Database {
  const makeStmt = (sql: string, bindings: unknown[] = []): D1PreparedStatement => ({
    bind: (...next: unknown[]) => makeStmt(sql, next),
    all: async <T = Record<string, unknown>>() => ({
      results: executeFn(bindSqlForRemoteD1(sql, bindings)).rows as T[],
      success: true,
      meta: {} as D1Meta,
    }),
    first: async <T = unknown>() => {
      const rows = executeFn(bindSqlForRemoteD1(sql, bindings)).rows as T[];
      return rows[0] ?? null;
    },
    run: async () => {
      if (dryRun) return { success: true, meta: { changes: 0 } as D1Meta, results: [] };
      const outcome = executeFn(bindSqlForRemoteD1(sql, bindings));
      return { success: true, meta: { changes: outcome.changes } as D1Meta, results: [] };
    },
    raw: async () => [],
  } as unknown as D1PreparedStatement);

  return {
    prepare: (sql: string) => makeStmt(sql),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      const out: D1Result<T>[] = [];
      for (const stmt of statements) {
        out.push((await stmt.run()) as unknown as D1Result<T>);
      }
      return out;
    },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    withSession: () => { throw new Error("unsupported"); },
  } as unknown as D1Database;
}

export interface LocalSqliteAdapterOptions {
  /** 指定快照父目录（默认 os.tmpdir()），便于隔离测试断言异常时零残留 */
  tempRootDir?: string;
  /** 仅供单测故障注入，模拟主库复制完成后的并发删除/写入/连接变动时序 */
  onAfterMainCopy?: (snapshotDbPath: string) => void;
}

export class SummaryBackfillIncompleteError extends Error {
  constructor(
    message: string,
    readonly updatedRows: number,
    readonly remainingStaleCount: number,
    readonly minBatchSizeUsed: number,
  ) {
    super(message);
    this.name = "SummaryBackfillIncompleteError";
  }
}

function hasActiveSqliteSidecar(sqlitePath: string): boolean {
  return (
    existsSync(`${sqlitePath}-journal`)
    || existsSync(`${sqlitePath}-wal`)
    || existsSync(`${sqlitePath}-shm`)
  );
}

function readSqliteHeader(sqlitePath: string): Buffer {
  const fd = openSync(sqlitePath, "r");
  try {
    const buffer = Buffer.alloc(100);
    const bytesRead = readSync(fd, buffer, 0, 100, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

export function createLocalSqliteAdapter(
  sqlitePath: string,
  dryRun: boolean,
  options?: LocalSqliteAdapterOptions,
): { db: D1Database; close: () => void } {
  if (!existsSync(sqlitePath)) {
    throw new Error(`SQLite 数据库文件不存在，已中止操作（未创建任何新文件）：${sqlitePath}`);
  }
  let snapshotDir: string | null = null;
  let sqlite: Database.Database | undefined;
  if (dryRun) {
    // 同时拦截 DELETE/TRUNCATE/PERSIST 回滚日志（-journal）与活跃 WAL（-wal/-shm），防止读到未提交脏页或拷贝撕裂快照
    if (hasActiveSqliteSidecar(sqlitePath)) {
      throw new Error(
        `检测到目标 SQLite 数据库存在未提交回滚日志或活跃 WAL 文件（-journal/-wal/-shm），拒绝读取未提交数据或非一致性快照；请先提交/关闭写入端或使用 sqlite3 .backup 生成一致性副本后再执行 --dry-run：${sqlitePath}`,
      );
    }
    const statBefore = statSync(sqlitePath);
    const headerBefore = readSqliteHeader(sqlitePath);
    snapshotDir = mkdtempSync(path.join(options?.tempRootDir ?? os.tmpdir(), "backfill-dryrun-snapshot-"));
    try {
      const snapshotDbPath = path.join(snapshotDir, "snapshot.db");
      copyFileSync(sqlitePath, snapshotDbPath);
      options?.onAfterMainCopy?.(snapshotDbPath);
      const statAfter = statSync(sqlitePath);
      const headerAfter = readSqliteHeader(sqlitePath);
      if (
        hasActiveSqliteSidecar(sqlitePath)
        || !headerBefore.equals(headerAfter)
        || statAfter.size !== statBefore.size
        || statAfter.mtimeMs !== statBefore.mtimeMs
      ) {
        throw new Error(`目标 SQLite 数据库在预演复制期间发生未提交事务、并发写入或连接变动，已丢弃非一致性快照：${sqlitePath}`);
      }
      sqlite = new Database(snapshotDbPath, { fileMustExist: true });
      sqlite.pragma("query_only = ON");
      sqlite.pragma("schema_version");
    } catch (error) {
      if (sqlite) {
        try {
          sqlite.close();
        } catch {
          // ignore close error during cleanup
        }
        sqlite = undefined;
      }
      rmSync(snapshotDir, { recursive: true, force: true });
      snapshotDir = null;
      throw error;
    }
  } else {
    sqlite = new Database(sqlitePath, { fileMustExist: true });
  }
  const activeSqlite = sqlite;
  const makeStmt = (sql: string, bindings: unknown[] = []): D1PreparedStatement => {
    const stmt = activeSqlite.prepare(sql);
    const reader = stmt.reader;
    return {
      bind: (...next: unknown[]) => makeStmt(sql, next),
      all: async <T = Record<string, unknown>>() => ({
        results: (reader ? stmt.all(...bindings) : []) as T[],
        success: true,
        meta: {} as D1Meta,
      }),
      first: async <T = unknown>() => (reader ? (stmt.get(...bindings) as T | undefined) ?? null : null),
      run: async () => {
        if (reader) {
          const rows = stmt.all(...bindings);
          return { success: true, results: rows, meta: { changes: rows.length } as D1Meta };
        }
        if (dryRun) return { success: true, results: [], meta: { changes: 0 } as D1Meta };
        const info = stmt.run(...bindings);
        return { success: true, results: [], meta: { changes: info.changes } as D1Meta };
      },
      raw: async () => [],
    } as unknown as D1PreparedStatement;
  };
  return {
    db: {
      prepare: (sql: string) => makeStmt(sql),
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        const out: D1Result<T>[] = [];
        for (const stmt of statements) {
          out.push((await stmt.run()) as unknown as D1Result<T>);
        }
        return out;
      },
      exec: async () => ({ count: 0, duration: 0 }),
      dump: async () => new ArrayBuffer(0),
      withSession: () => { throw new Error("unsupported"); },
    } as unknown as D1Database,
    close: () => {
      try {
        activeSqlite.close();
      } finally {
        if (snapshotDir) {
          rmSync(snapshotDir, { recursive: true, force: true });
          snapshotDir = null;
        }
      }
    },
  };
}

export async function queryRemainingStaleSummaryCount(database: D1Database): Promise<number> {
  const row = await database.prepare(`
    SELECT COALESCE(SUM(CASE WHEN summary_state_key IS NULL OR summary_state_key <> ${EXPECTED_SUMMARY_KEY_SQL} THEN 1 ELSE 0 END), 0) AS stale_count
    FROM reviews
    WHERE deleting_at IS NULL
  `).bind().first<{ stale_count: number }>();
  return Number(row?.stale_count ?? 0);
}

/**
 * 纯只读预演：基于 Keyset 游标分页检查待回填记录而不修改数据库；若遇到大报告缓冲区超限会自动缩小分页条数重试。
 */
export async function inspectDryRunSummaryBackfill(
  database: D1Database,
  initialBatchSize = MAX_SUMMARY_BACKFILL_BATCH,
): Promise<{ staleCount: number; inspectedCount: number; readyCount: number; blockedCount: number }> {
  const staleCount = await queryRemainingStaleSummaryCount(database);
  if (staleCount === 0) {
    return { staleCount: 0, inspectedCount: 0, readyCount: 0, blockedCount: 0 };
  }
  let currentLimit = Math.min(MAX_SUMMARY_BACKFILL_BATCH, Math.max(1, initialBatchSize));
  let cursor: SummaryBackfillCursor | null = null;
  let inspectedCount = 0;
  let readyCount = 0;
  let blockedCount = 0;

  while (true) {
    let rows: Awaited<ReturnType<typeof selectStaleSummaryRows>>;
    try {
      // 直接复用正式回填共用的 selectStaleSummaryRows，保证只读预演与正式扫描排序、游标 100% 同源
      rows = await selectStaleSummaryRows(database, {
        limit: currentLimit,
        cursor,
      });
    } catch (error) {
      if (isBufferLimitError(error) && currentLimit > 1) {
        currentLimit = Math.max(1, Math.floor(currentLimit / 2));
        continue;
      }
      throw error;
    }
    if (rows.length === 0) break;

    const candidateIds = rows
      .filter((r) => r.report !== null && r.teacher_reviewed_at !== null && r.status !== "rejected")
      .map((r) => r.id);
    const imagesByReview = new Map<string, Array<{ position: number; width: number; height: number }>>();
    if (candidateIds.length > 0) {
      const placeholders = candidateIds.map(() => "?").join(", ");
      const { results: imgRows = [] } = await database.prepare(`
        SELECT review_id, position, width, height FROM review_images WHERE review_id IN (${placeholders}) ORDER BY position, id
      `).bind(...candidateIds).all<{ review_id?: string; position: number; width: number; height: number }>();
      for (const img of imgRows) {
        const key = img.review_id ?? (candidateIds.length === 1 ? candidateIds[0]! : "");
        if (!key) continue;
        const list = imagesByReview.get(key) ?? [];
        list.push({ position: img.position, width: img.width, height: img.height });
        imagesByReview.set(key, list);
      }
    }

    for (const row of rows) {
      inspectedCount += 1;
      if (row.status === "rejected" || row.report === null || row.teacher_reviewed_at === null) {
        blockedCount += 1;
        continue;
      }
      try {
        const rawParsed = JSON.parse(row.report);
        if (isLegacyEvaluationReport(rawParsed)) {
          blockedCount += 1;
          continue;
        }
        const parsedReport = evaluationReportSchema.parse(rawParsed);
        const checkpoint = readStoredOcrCheckpoint(row.ocr_checkpoint, row.image_revision);
        const readiness = deliveryReadiness({
          report: parsedReport,
          teacherReviewedAt: new Date(row.teacher_reviewed_at).toISOString(),
          reportStale: checkpoint === null || row.report_ocr_revision !== checkpoint.ocrRevision,
          reportOcrRevision: row.report_ocr_revision,
          ocr: checkpoint ? publicOcrView(checkpoint) : null,
          images: imagesByReview.get(row.id) ?? [],
        });
        if (readiness.ready) readyCount += 1;
        else blockedCount += 1;
      } catch {
        blockedCount += 1;
      }
    }
    cursor = cursorFromSummaryRow(rows[rows.length - 1]!);
  }

  return { staleCount, inspectedCount, readyCount, blockedCount };
}

/**
 * 自适应分批回填：默认每批 20 条，采用 Keyset 游标向后扫描整表：
 * - 遇到超长报告输出超限（ENOBUFS）时保持当前游标不变、自动折半拆批（20 -> 10 -> 5 -> 2 -> 1）；
 * - 遇到前排持续并发冲突行时，游标继续向后扫描先把后续无冲突记录全部更新，再回到顶部复扫；
 * - 若多轮完整扫描后仍有未清零冲突行，抛出 SummaryBackfillIncompleteError（携带已更新数与剩余数），CLI 非零退出。
 */
export async function adaptiveBackfillSummaries(
  database: D1Database,
  options?: { initialBatchSize?: number; maxRounds?: number },
): Promise<{ updatedRows: number; remainingStaleCount: number; minBatchSizeUsed: number }> {
  let currentLimit = Math.min(MAX_SUMMARY_BACKFILL_BATCH, Math.max(1, options?.initialBatchSize ?? MAX_SUMMARY_BACKFILL_BATCH));
  let minBatchSizeUsed = currentLimit;
  const maxRounds = options?.maxRounds ?? 20_000;
  let updatedRows = 0;
  let cursor: SummaryBackfillCursor | null = null;
  let sweepFetched = 0;
  let sweepUpdated = 0;
  let zeroProgressSweeps = 0;

  for (let round = 0; round < maxRounds; round += 1) {
    if (cursor === null && sweepFetched === 0) {
      const remaining = await queryRemainingStaleSummaryCount(database);
      if (remaining === 0) {
        return { updatedRows, remainingStaleCount: 0, minBatchSizeUsed };
      }
    }
    try {
      const pass = await runSummaryBackfillCursorStep(database, {
        limit: currentLimit,
        cursor,
      });
      if (pass.fetched === 0) {
        if (cursor === null && sweepFetched === 0) break;
        if (sweepUpdated === 0) {
          zeroProgressSweeps += 1;
          if (zeroProgressSweeps >= 2) break;
        } else {
          zeroProgressSweeps = 0;
        }
        cursor = null;
        sweepFetched = 0;
        sweepUpdated = 0;
        continue;
      }
      updatedRows += pass.updated;
      sweepFetched += pass.fetched;
      sweepUpdated += pass.updated;
      if (pass.fetched < currentLimit) {
        if (sweepUpdated === 0) {
          zeroProgressSweeps += 1;
          if (zeroProgressSweeps >= 2) break;
        } else {
          zeroProgressSweeps = 0;
        }
        cursor = null;
        sweepFetched = 0;
        sweepUpdated = 0;
      } else {
        cursor = pass.nextCursor;
      }
    } catch (error) {
      if (isBufferLimitError(error) && currentLimit > 1) {
        currentLimit = Math.max(1, Math.floor(currentLimit / 2));
        minBatchSizeUsed = Math.min(minBatchSizeUsed, currentLimit);
        continue;
      }
      throw error;
    }
  }

  const remainingStaleCount = await queryRemainingStaleSummaryCount(database);
  if (remainingStaleCount > 0) {
    throw new SummaryBackfillIncompleteError(
      `摘要回填未清零（已更新 ${updatedRows} 条正常记录，仍余 ${remainingStaleCount} 条冲突记录待回填），请待并发写入停止后重试`,
      updatedRows,
      remainingStaleCount,
      minBatchSizeUsed,
    );
  }
  return { updatedRows, remainingStaleCount: 0, minBatchSizeUsed };
}

export type ParsedBackfillCliArgs =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "run"; target: "d1" | "sqlite"; sqlitePath?: string; dryRun: boolean };

export function backfillUsageText(): string {
  return (
    "用法：\n"
    + "  只读预演：npm run backfill:review-summaries -- (--d1 | --sqlite /path/to/app.db) --dry-run\n"
    + "  正式写入：npm run backfill:review-summaries -- (--d1 | --sqlite /path/to/app.db) --apply\n"
    + `说明：在 0015_review_summary_fields.sql 迁移后分批（每批上限 ${MAX_SUMMARY_BACKFILL_BATCH} 条，超长输出自动拆批）用权威 deliveryReadiness() 回填历史记录摘要与导出资格；拒绝任何未知参数，写入必须显式带 --apply。\n`
  );
}

export function parseBackfillCliArgs(args: readonly string[]): ParsedBackfillCliArgs {
  if (args.length === 0) {
    return { kind: "error", message: backfillUsageText() };
  }
  if (args.length === 1 && (args[0] === "-h" || args[0] === "--help")) {
    return { kind: "help" };
  }
  let d1Count = 0;
  let sqliteCount = 0;
  let sqlitePath: string | undefined;
  let dryRunCount = 0;
  let applyCount = 0;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "-h" || token === "--help") {
      return { kind: "error", message: `帮助参数 "${token}" 不能与执行参数混用（已阻止执行任何数据库操作）。\n${backfillUsageText()}` };
    }
    if (token === "--d1") {
      d1Count += 1;
      if (d1Count > 1) {
        return { kind: "error", message: `参数 --d1 不能重复传入（已阻止执行任何数据库操作）。\n${backfillUsageText()}` };
      }
      continue;
    }
    if (token === "--dry-run") {
      dryRunCount += 1;
      if (dryRunCount > 1) {
        return { kind: "error", message: `参数 --dry-run 不能重复传入（已阻止执行任何数据库操作）。\n${backfillUsageText()}` };
      }
      continue;
    }
    if (token === "--apply") {
      applyCount += 1;
      if (applyCount > 1) {
        return { kind: "error", message: `参数 --apply 不能重复传入（已阻止执行任何数据库操作）。\n${backfillUsageText()}` };
      }
      continue;
    }
    if (token === "--sqlite") {
      sqliteCount += 1;
      if (sqliteCount > 1) {
        return { kind: "error", message: `参数 --sqlite 不能重复传入（拒绝在多个数据库路径间静默择一，未打开任何数据库）。\n${backfillUsageText()}` };
      }
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return { kind: "error", message: `参数 --sqlite 缺少数据库文件路径。\n${backfillUsageText()}` };
      }
      sqlitePath = value;
      index += 1;
      continue;
    }
    return { kind: "error", message: `拒绝未知或拼写错误的参数 "${token}"（已阻止执行任何数据库操作）。\n${backfillUsageText()}` };
  }

  const useD1 = d1Count === 1;
  const dryRun = dryRunCount === 1;
  const apply = applyCount === 1;

  if ((!useD1 && !sqlitePath) || (useD1 && Boolean(sqlitePath))) {
    return { kind: "error", message: `必须且只能指定 --d1 或 --sqlite 其中一个目标。\n${backfillUsageText()}` };
  }
  if ((dryRun && apply) || (!dryRun && !apply)) {
    return { kind: "error", message: `必须显式指定 --dry-run（只读预演）或 --apply（正式写入），且二者不可同时传入。\n${backfillUsageText()}` };
  }

  return {
    kind: "run",
    target: useD1 ? "d1" : "sqlite",
    sqlitePath,
    dryRun,
  };
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry!).href;
}

if (isDirectRun()) {
  const parsedCli = parseBackfillCliArgs(process.argv.slice(2));
  if (parsedCli.kind === "help") {
    process.stdout.write(backfillUsageText());
  } else if (parsedCli.kind === "error") {
    process.stderr.write(parsedCli.message);
    process.exitCode = 2;
  } else {
    const { target, sqlitePath, dryRun } = parsedCli;
    const useD1 = target === "d1";
    void (async () => {
      let cleanup: (() => void) | undefined;
      try {
        const targetDb = useD1
          ? createRemoteD1Adapter(dryRun)
          : (() => {
              const local = createLocalSqliteAdapter(sqlitePath!, dryRun);
              cleanup = local.close;
              return local.db;
            })();
        if (dryRun) {
          const report = await inspectDryRunSummaryBackfill(targetDb);
          process.stdout.write(`${JSON.stringify({
            dryRun: true,
            target,
            ...report,
          }, null, 2)}\n`);
        } else {
          const outcome = await adaptiveBackfillSummaries(targetDb);
          process.stdout.write(`${JSON.stringify({
            dryRun: false,
            target,
            updatedRows: outcome.updatedRows,
            remainingStaleCount: outcome.remainingStaleCount,
            minBatchSizeUsed: outcome.minBatchSizeUsed,
          }, null, 2)}\n`);
          if (outcome.remainingStaleCount > 0) {
            process.exitCode = 1;
          }
        }
      } catch (error) {
        if (error instanceof SummaryBackfillIncompleteError) {
          process.stdout.write(`${JSON.stringify({
            dryRun: false,
            target,
            updatedRows: error.updatedRows,
            remainingStaleCount: error.remainingStaleCount,
            minBatchSizeUsed: error.minBatchSizeUsed,
            error: error.message,
          }, null, 2)}\n`);
        }
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      } finally {
        cleanup?.();
      }
    })();
  }
}
