import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  adaptiveBackfillSummaries,
  createLocalSqliteAdapter,
  createRemoteD1Adapter,
  inspectDryRunSummaryBackfill,
  parseBackfillCliArgs,
  SummaryBackfillIncompleteError,
} from "../scripts/backfill-review-summaries";
import { d1Shim } from "./d1-sqlite-shim";
import { D1ReviewReader } from "../src/cloudflare/d1-review-reader";
import { D1ReviewWriter } from "../src/cloudflare/d1-review-writer";
import { backfillReviewSummaries } from "../src/cloudflare/review-summary-state";
import { evaluationReportSchema } from "../src/domain/contracts";
import { deliveryReadiness } from "../src/delivery/readiness";
import { publicOcrView, readStoredOcrCheckpoint } from "../src/ocr/contracts";

const MIGRATIONS = path.resolve(__dirname, "../migrations");

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort();
}

/** D1 runs with foreign keys on and ignores PRAGMA foreign_keys = OFF; simulate that. */
function openLikeD1() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  const exec = db.exec.bind(db);
  return {
    db,
    apply(name: string) {
      const sql = readFileSync(path.join(MIGRATIONS, name), "utf8")
        .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*(OFF|ON)\s*;/gimu, "");
      exec("BEGIN");
      exec(sql);
      exec("COMMIT");
    },
  };
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("D1 迁移不丢数据", () => {
  it("0009 重建 reviews 时保留图片、批注和分析任务（外键开着也不级联删除）", () => {
    const { db, apply } = openLikeD1();
    const files = migrationFiles();
    const before = files.filter((name) => name < "0009");
    const after = files.filter((name) => name >= "0009");
    before.forEach(apply);

    db.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES ('u1', 'teacher', 'x', 'teacher', 0, 1, 1)").run();
    db.prepare("INSERT INTO reviews (id, owner_id, status, config, created_at, updated_at, teacher_reviewed_at) VALUES ('r1', 'u1', 'exported', '{}', 1, 1, 2)").run();
    db.prepare(`INSERT INTO review_images (review_id, page_index, path, position, original_name, mime_type, original_path, annotation_path, ai_path, width, height, rotation, created_at)
      VALUES ('r1', 0, 'images/a.jpg', 0, 'a.jpg', 'image/jpeg', 'images/a-original.jpg', 'images/a.jpg', 'images/a-ai.jpg', 10, 10, 0, 1)`).run();
    db.prepare("INSERT INTO annotations (review_id, position, page_index, x, y, category, anchor_text, comment, is_highlight) VALUES ('r1', 0, 0, 0.1, 0.1, 'typo', '字', '错字', 0)").run();
    db.prepare("INSERT INTO analysis_jobs (id, review_id, owner_id, status, available_at, progress_stage, teacher_guidance, created_at) VALUES ('j1', 'r1', 'u1', 'succeeded', 1, 'saving_result', '[不合适原因]\n结构乱\n[修改要求]\n分五段', 1)").run();

    after.forEach(apply);

    expect(count(db, "reviews")).toBe(1);
    expect(count(db, "review_images")).toBe(1);
    expect(count(db, "annotations")).toBe(1);
    expect(count(db, "analysis_jobs")).toBe(1);
    expect(db.prepare("SELECT teacher_guidance FROM analysis_jobs WHERE id = 'j1'").pluck().get()).toContain("分五段");
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'keep_0009_%'").all()).toEqual([]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.prepare("UPDATE reviews SET status = 'rejected' WHERE id = 'r1'").run();
  });

  it("重建被引用的表时必须先保存子表", () => {
    const referenced = new Map<string, string[]>();
    const sources = migrationFiles().map((name) => [name, readFileSync(path.join(MIGRATIONS, name), "utf8")] as const);
    for (const [, sql] of sources) {
      for (const match of sql.matchAll(/CREATE TABLE\s+"?(\w+)"?\s*\(([\s\S]*?)\n\);/gu)) {
        for (const ref of match[2]!.matchAll(/REFERENCES\s+(\w+)\s*\([^)]*\)\s+ON DELETE CASCADE/gu)) {
          referenced.set(ref[1]!, [...(referenced.get(ref[1]!) ?? []), match[1]!]);
        }
      }
    }
    for (const [, sql] of sources) {
      for (const rename of sql.matchAll(/ALTER TABLE\s+"?(\w+)"?\s+RENAME TO\s+"?(\w+)"?/gu)) {
        for (const [parent, children] of referenced) {
          referenced.set(parent, children.map((child) => (child === rename[1] ? rename[2]! : child)));
        }
      }
    }
    for (const [name, sql] of sources) {
      for (const drop of sql.matchAll(/DROP TABLE\s+(?:IF EXISTS\s+)?"?(\w+)"?/gu)) {
        const children = [...new Set(referenced.get(drop[1]!) ?? [])].filter((child) => child !== drop[1]);
        for (const child of children) {
          expect(sql, `${name} 删除 ${drop[1]} 前没有保存 ${child}`).toMatch(new RegExp(`INSERT OR IGNORE INTO ${child}\\b`, "u"));
        }
      }
    }
  });
});

describe("0013 候选规则迁移", () => {
  it("只新建表，不重建已有表，已有数据不受影响", () => {
    const sql = readFileSync(path.join(MIGRATIONS, "0013_grading_rule_candidates.sql"), "utf8");
    expect(sql).not.toMatch(/DROP\s+TABLE|ALTER\s+TABLE\s+\w+\s+RENAME/iu);
    const { db, apply } = openLikeD1();
    const files = migrationFiles();
    files.filter((name) => name < "0013").forEach(apply);
    db.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES ('u1', 'teacher', 'x', 'teacher', 0, 1, 1)").run();
    db.prepare("INSERT INTO grading_opinions (id, owner_id, body, created_at, updated_at) VALUES ('o1', 'u1', 'x', 1, 1)").run();
    files.filter((name) => name >= "0013").forEach(apply);
    expect(count(db, "grading_opinions")).toBe(1);
    expect(count(db, "grading_rule_candidates")).toBe(0);
  });
});

describe("0014 查询索引迁移", () => {
  it("只新增索引不改表结构，关键查询命中新索引而不再全表扫描", () => {
    const sql = readFileSync(path.join(MIGRATIONS, "0014_query_indexes.sql"), "utf8");
    expect(sql).not.toMatch(/DROP\s+TABLE|ALTER\s+TABLE|DELETE\s+FROM|UPDATE\s+/iu);
    const { db, apply } = openLikeD1();
    migrationFiles().forEach(apply);

    const analyzingPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      UPDATE reviews SET status = 'failed' WHERE status = 'analyzing' AND analysis_run_id = 'job-1'
    `).all() as Array<{ detail: string }>;
    expect(analyzingPlan.map((row) => row.detail).join(" ")).toContain("reviews_analyzing_idx");

    const listPlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id FROM reviews WHERE owner_id = 'u1' AND deleting_at IS NULL ORDER BY updated_at DESC, created_at DESC
    `).all() as Array<{ detail: string }>;
    const listDetail = listPlan.map((row) => row.detail).join(" ");
    expect(listDetail).toContain("reviews_owner_active_updated_idx");
    expect(listDetail).not.toContain("USE TEMP B-TREE");
  });
});

describe("0015 摘要物化字段与待导出索引迁移", () => {
  it("不删表不重建表，0015 零误标就绪，且回填后的可导出 ID 集合与权威逐篇 deliveryReadiness 判定集合 100% 一致", async () => {
    const sql = readFileSync(path.join(MIGRATIONS, "0015_review_summary_fields.sql"), "utf8");
    expect(sql).not.toMatch(/DROP\s+TABLE|ALTER\s+TABLE\s+\w+\s+RENAME/iu);

    const { db, apply } = openLikeD1();
    const files = migrationFiles();
    files.filter((name) => name < "0015").forEach(apply);

    db.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES ('u1', 'teacher', 'x', 'teacher', 0, 1, 1)").run();

    const validDiagnostics = {
      authenticityAndRelevance: { finding: "真实。", action: "保留。" },
      materialAndDetails: { finding: "具体。", action: "保留。" },
      structure: { finding: "完整。", action: "保留。" },
      language: { finding: "通顺。", action: "保留。" },
    };
    const validOcr1 = JSON.stringify({
      version: 2,
      sourceRevision: 2,
      ocrRevision: 1,
      editedAt: null,
      pages: [{
        pageIndex: 0,
        text: "正文。",
        readable: true,
        warnings: [],
        blocks: [{ text: "正文。", x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
      }],
      paragraphs: [{
        id: "paragraph-1",
        paragraphIndex: 0,
        text: "正文。",
        segments: [{ pageIndex: 0, text: "正文。", x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
      }],
    });
    const malformedOcrMissingBlocks = JSON.stringify({
      version: 2,
      sourceRevision: 2,
      ocrRevision: 1,
      editedAt: null,
      pages: [{ pageIndex: 0, text: "正文。", readable: true, warnings: [] }],
      paragraphs: [{
        id: "paragraph-1",
        paragraphIndex: 0,
        text: "正文。",
        segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
      }],
    });
    const validOcr3 = JSON.stringify({
      version: 2,
      sourceRevision: 2,
      ocrRevision: 1,
      editedAt: null,
      pages: [{
        pageIndex: 0,
        text: "一段。二段。三段。",
        readable: true,
        warnings: [],
        blocks: [{ text: "一段。二段。三段。", x: 0.1, y: 0.1, width: 0.5, height: 0.5 }],
      }],
      paragraphs: [
        { id: "paragraph-1", paragraphIndex: 0, text: "一段。", segments: [{ pageIndex: 0, text: "一段。", x: 0.1, y: 0.1, width: 0.5, height: 0.1 }] },
        { id: "paragraph-2", paragraphIndex: 1, text: "二段。", segments: [{ pageIndex: 0, text: "二段。", x: 0.1, y: 0.3, width: 0.5, height: 0.1 }] },
        { id: "paragraph-3", paragraphIndex: 2, text: "三段。", segments: [{ pageIndex: 0, text: "三段。", x: 0.1, y: 0.5, width: 0.5, height: 0.1 }] },
      ],
    });

    const insertPre0015 = db.prepare(`
      INSERT INTO reviews (id, owner_id, status, student_name, class_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, teacher_reviewed_at, created_at, updated_at)
      VALUES (?, 'u1', 'ready_for_review', ?, '六（1）班', ?, ?, 5, 2, ?, 1, 1000, 900, ?)
    `);
    const insertImg = db.prepare(`
      INSERT INTO review_images (review_id, page_index, path, position, original_name, mime_type, original_path, annotation_path, ai_path, width, height, rotation, created_at)
      VALUES (?, 0, 'images/p0.jpg', 0, 'p0.jpg', 'image/jpeg', 'images/p0.jpg', 'images/p0.jpg', 'images/p0.jpg', 1000, 1400, 0, 1)
    `);

    // 1) 标准 1 对 1 完整有效已审核 v2 记录 -> 权威可导出
    insertPre0015.run("r-v2-valid", "甲有效", JSON.stringify({ title: "那一次尝试" }), JSON.stringify({
      version: 2,
      themeFit: "fits",
      themeReason: "切题。",
      personalizedComment: "真实。",
      painPoints: [],
      commonIssues: [],
      revisionSuggestions: [],
      parentFeedbacks: [],
      grade: "A-",
      diagnostics: validDiagnostics,
      paragraphReviews: [{ paragraphId: "paragraph-1", suggestions: [{ advice: "保留" }], revisedText: "正文。" }],
      rewrittenEssay: ["正文。"],
    }), validOcr1, 1008);
    insertImg.run("r-v2-valid");

    // 2) 缺 themeFit 及 OCR 缺 blocks 的历史残缺 v2 夹具 -> 权威不可导出，0015 与权威回填均绝不能误标就绪！
    insertPre0015.run("r-v2-missing-themefit", "乙缺字段", JSON.stringify({ title: "残缺夹具" }), JSON.stringify({
      version: 2,
      grade: "A-",
      paragraphReviews: [{ paragraphId: "paragraph-1", suggestions: [{ advice: "保留" }], revisedText: "正文。" }],
    }), malformedOcrMissingBlocks, 1007);
    insertImg.run("r-v2-missing-themefit");

    // 2b) 报告完整但 OCR 缺 pages[].blocks 与 segment.text -> readStoredOcrCheckpoint 返回 null，权威不可导出
    insertPre0015.run("r-v2-ocr-missing-blocks", "乙二缺OCR块", JSON.stringify({ title: "OCR残缺" }), JSON.stringify({
      version: 2,
      themeFit: "fits",
      grade: "A-",
      diagnostics: validDiagnostics,
      paragraphReviews: [{ paragraphId: "paragraph-1", suggestions: [{ advice: "保留" }], revisedText: "正文。" }],
    }), malformedOcrMissingBlocks, 10065);
    insertImg.run("r-v2-ocr-missing-blocks");

    // 3) off_topic 却评了 B 等级 -> 权威不可导出
    insertPre0015.run("r-v2-offtopic-bad-grade", "丙错等级", JSON.stringify({ title: "偏题" }), JSON.stringify({
      version: 2,
      themeFit: "off_topic",
      grade: "B",
      paragraphReviews: [{ paragraphId: "paragraph-1", suggestions: [{ advice: "重写" }], revisedText: "正文。" }],
    }), validOcr1, 1006);
    insertImg.run("r-v2-offtopic-bad-grade");

    // 4) 双轨草稿冲突（rewrittenEssay 与 paragraphReviews 不一致）-> 权威不可导出
    insertPre0015.run("r-v2-dual-conflict", "丁双轨冲突", JSON.stringify({ title: "双轨冲突" }), JSON.stringify({
      version: 2,
      themeFit: "fits",
      grade: "B+",
      paragraphReviews: [{ paragraphId: "paragraph-1", suggestions: [{ advice: "保留" }], revisedText: "逐段稿。" }],
      rewrittenEssay: ["旧范文稿。"],
    }), validOcr1, 1005);
    insertImg.run("r-v2-dual-conflict");

    // 5) 段落覆盖不匹配（paragraph-2 vs OCR paragraph-1）-> 权威不可导出
    insertPre0015.run("r-v2-coverage-mismatch", "戊错段号", JSON.stringify({ title: "段号不符" }), JSON.stringify({
      version: 2,
      themeFit: "fits",
      grade: "B+",
      paragraphReviews: [{ paragraphId: "paragraph-2", suggestions: [{ advice: "保留" }], revisedText: "正文。" }],
    }), validOcr1, 1004);
    insertImg.run("r-v2-coverage-mismatch");

    // 6) 缺失图片页 -> 权威不可导出
    insertPre0015.run("r-v2-missing-img", "己缺图", JSON.stringify({ title: "缺图" }), JSON.stringify({
      version: 2,
      themeFit: "fits",
      grade: "A",
      paragraphReviews: [{ paragraphId: "paragraph-1", suggestions: [{ advice: "保留" }], revisedText: "正文。" }],
    }), validOcr1, 1003);

    // 7) 有效段落归组报告（3 段并 2 组）-> 0015 保守不误标，经权威回填后可导出
    insertPre0015.run("r-v2-grouped-valid", "庚归组有效", JSON.stringify({ title: "归组习作" }), JSON.stringify({
      version: 2,
      themeFit: "fits",
      grade: "A",
      diagnostics: validDiagnostics,
      paragraphReviews: [
        { paragraphId: "paragraph-1", sourceParagraphStart: 1, sourceParagraphEnd: 2, suggestions: [{ advice: "合并前两段" }], revisedText: "一段二段。" },
        { paragraphId: "paragraph-3", sourceParagraphStart: 3, sourceParagraphEnd: 3, suggestions: [{ advice: "收束" }], revisedText: "三段。" },
      ],
      rewrittenEssay: ["一段二段。", "三段。"],
    }), validOcr3, 1002);
    insertImg.run("r-v2-grouped-valid");

    // 8) 历史 40 分制旧版报告（36 分映射为 A-，不可直接按新格式导出）
    insertPre0015.run("r-legacy-36", "辛旧版", JSON.stringify({ title: "旧版题目" }), JSON.stringify({
      themeFit: "fits",
      themeReason: "切题",
      personalizedComment: "真实",
      painPoints: [],
      commonIssues: [],
      revisionSuggestions: [],
      parentFeedbacks: [],
      scores: { themeIntent: 8, contentSelection: 8, structure: 8, languageExpression: 8, writingConventions: 4, total: 36, level: "优秀作文" },
      sampleParagraphs: [{ title: "第一段", text: "示范", suggestion: "建议" }],
    }), null, 1001);

    // 9) 反例回归：0015 执行后、权威回填尚未运行前，老师先通过 D1ReviewWriter.update 修改姓名 -> 绝不能在后续导出中被漏掉
    const fullAssignmentConfig = JSON.stringify({
      title: "改名回归",
      grade: "六年级",
      writingRequirements: "叙事真实",
      targetCharacters: 600,
      structureRequirements: "结构完整",
      scoringFocus: "细节具体",
      templateType: "custom",
    });
    insertPre0015.run("r-v2-renamed-before-backfill", "壬待改名", fullAssignmentConfig, JSON.stringify({
      version: 2,
      themeFit: "fits",
      themeReason: "切题。",
      personalizedComment: "真实。",
      painPoints: [],
      commonIssues: [],
      revisionSuggestions: [],
      parentFeedbacks: [],
      grade: "A",
      diagnostics: validDiagnostics,
      paragraphReviews: [{ paragraphId: "paragraph-1", suggestions: [{ advice: "保留" }], revisedText: "正文。" }],
      rewrittenEssay: ["正文。"],
    }), validOcr1, 10005);
    insertImg.run("r-v2-renamed-before-backfill");

    // 10) 反例回归：ocr_checkpoint JSON 中整数以 1.0 / 2.0 浮点字面量存储（SQLite json_type='real'，JS Number.isInteger=true）
    const validOcrRealLiterals = validOcr1
      .replace('"version":2', '"version":2.0')
      .replace('"sourceRevision":2', '"sourceRevision":2.0')
      .replace('"ocrRevision":1', '"ocrRevision":1.0');
    insertPre0015.run("r-v2-real-json-int", "癸浮点字面量", JSON.stringify({ title: "浮点整数兼容" }), JSON.stringify({
      version: 2,
      themeFit: "fits",
      themeReason: "切题。",
      personalizedComment: "真实。",
      painPoints: [],
      commonIssues: [],
      revisionSuggestions: [],
      parentFeedbacks: [],
      grade: "A-",
      diagnostics: validDiagnostics,
      paragraphReviews: [{ paragraphId: "paragraph-1", suggestions: [{ advice: "保留" }], revisedText: "正文。" }],
      rewrittenEssay: ["正文。"],
    }), validOcrRealLiterals, 10002);
    insertImg.run("r-v2-real-json-int");

    files.filter((name) => name >= "0015").forEach(apply);

    // 阶段 A：仅执行 0015 SQL 后，所有历史已审核 v2 候选均保持 export_ready_version = NULL（零误标），且 1.0 整数正确提取为 1
    const preBackfillRows = db.prepare(`
      SELECT id, ocr_revision_cached, export_ready_version FROM reviews WHERE owner_id = 'u1'
    `).all() as Array<{ id: string; ocr_revision_cached: number | null; export_ready_version: string | null }>;
    expect(preBackfillRows.filter((r) => r.export_ready_version !== null).map((r) => r.id)).toEqual([]);
    expect(preBackfillRows.find((r) => r.id === "r-v2-real-json-int")?.ocr_revision_cached).toBe(1);

    // 模拟回填完成前老师在界面仅修改 r-v2-renamed-before-backfill 的学生姓名
    const shimDb = d1Shim(db);
    const renamed = await new D1ReviewWriter(shimDb).update("u1", "r-v2-renamed-before-backfill", {
      expectedRevision: 5,
      studentName: "壬回填前已改名",
    });
    expect(renamed).toEqual({ revision: 6 });

    // 逐篇计算权威 deliveryReadiness 集合作为黄金真值
    const allRows = db.prepare(`
      SELECT id, report, image_revision, ocr_checkpoint, report_ocr_revision, teacher_reviewed_at, export_ready_version
      FROM reviews WHERE owner_id = 'u1' ORDER BY updated_at DESC, created_at DESC, id DESC
    `).all() as Array<{
      id: string;
      report: string | null;
      image_revision: number;
      ocr_checkpoint: string | null;
      report_ocr_revision: number | null;
      teacher_reviewed_at: number | null;
      export_ready_version: string | null;
    }>;

    const authoritativeReadyIds = allRows.filter((row) => {
      try {
        const parsedReport = row.report ? evaluationReportSchema.parse(JSON.parse(row.report)) : null;
        const checkpoint = readStoredOcrCheckpoint(row.ocr_checkpoint, row.image_revision);
        const images = db.prepare("SELECT position, width, height FROM review_images WHERE review_id = ?").all(row.id) as Array<{ position: number; width: number; height: number }>;
        return deliveryReadiness({
          report: parsedReport,
          teacherReviewedAt: row.teacher_reviewed_at ? new Date(row.teacher_reviewed_at).toISOString() : null,
          reportStale: checkpoint === null || row.report_ocr_revision !== checkpoint.ocrRevision,
          reportOcrRevision: row.report_ocr_revision,
          ocr: checkpoint ? publicOcrView(checkpoint) : null,
          images,
        }).ready;
      } catch {
        return false;
      }
    }).map((r) => r.id);

    expect(authoritativeReadyIds).toEqual([
      "r-v2-renamed-before-backfill",
      "r-v2-real-json-int",
      "r-v2-valid",
      "r-v2-grouped-valid",
    ]);

    // 阶段 B：执行分批权威回填后，summaryPage.exportableReviewedIds 与 checkExportable 均与权威集合 100% 精确相等
    await backfillReviewSummaries(shimDb, { batchSize: 3 });
    const reader = new D1ReviewReader(shimDb);
    const summary = await reader.summaryPage("u1", { page: 1, pageSize: 20 });
    expect(summary.exportableReviewedIds).toEqual(authoritativeReadyIds);
    expect(summary.summaryBackfillPending).toBeUndefined();
    await expect(reader.checkExportable("u1", [
      { id: "r-v2-renamed-before-backfill", revision: 6 },
      { id: "r-v2-real-json-int", revision: 5 },
    ])).resolves.toBe(true);

    const legacyItem = summary.items.find((item) => item.id === "r-legacy-36");
    expect(legacyItem).toMatchObject({
      grade: "A-",
      isLegacyReport: true,
      exportEligibility: { eligible: false, reason: "旧版示范段落报告需要完整重新分析后才能导出新格式" },
    });
  });

  it("回填脚本 --dry-run 对不存在路径绝不创建文件，对已有 SQLite 只读零写入，且远端 20×60KB ENOBUFS 自动拆批完成全部回填", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "summary-backfill-ops-"));
    try {
      // 1) 不存在的路径 + dryRun=true：必须报错且磁盘上绝不生成任何 SQLite 文件
      const missingDbPath = path.join(tmpDir, "nonexistent.db");
      expect(() => createLocalSqliteAdapter(missingDbPath, true)).toThrow(/不存在/u);
      expect(existsSync(missingDbPath)).toBe(false);

      // 2) 已存在的 SQLite 数据库 + dryRun=true：只读预演准确统计且数据库字节与状态零修改
      const existingDbPath = path.join(tmpDir, "existing.db");
      const fileSqlite = new Database(existingDbPath);
      migrationFiles().forEach((name) => {
        const sql = readFileSync(path.join(MIGRATIONS, name), "utf8")
          .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*(OFF|ON)\s*;/gimu, "");
        fileSqlite.exec(sql);
      });
      fileSqlite.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES ('u1', 'teacher', 'x', 'teacher', 0, 1, 1)").run();

      const validDiagnostics = {
        authenticityAndRelevance: { finding: "真实。", action: "保留。" },
        materialAndDetails: { finding: "具体。", action: "保留。" },
        structure: { finding: "完整。", action: "保留。" },
        language: { finding: "通顺。", action: "保留。" },
      };
      // 构造 20 条每条 ~60KB 的大报告已审核 v2 记录（summary_state_key = NULL）
      const padding = "详".repeat(20_000);
      const largeReportJson = JSON.stringify({
        version: 2,
        themeFit: "fits",
        themeReason: "切题。",
        personalizedComment: `评语${padding}`,
        painPoints: [],
        commonIssues: [],
        revisionSuggestions: [],
        parentFeedbacks: [],
        grade: "A",
        diagnostics: validDiagnostics,
        paragraphReviews: [{ paragraphId: "paragraph-1", suggestions: [{ advice: "保留" }], revisedText: "正文。" }],
        rewrittenEssay: ["正文。"],
      });
      expect(Buffer.byteLength(largeReportJson, "utf8")).toBeGreaterThan(60_000);

      const validOcrJson = JSON.stringify({
        version: 2,
        sourceRevision: 1,
        ocrRevision: 1,
        editedAt: null,
        pages: [{ pageIndex: 0, text: "正文。", readable: true, warnings: [], blocks: [{ text: "正文。", x: 0.1, y: 0.2, width: 0.5, height: 0.1 }] }],
        paragraphs: [{ id: "paragraph-1", paragraphIndex: 0, text: "正文。", segments: [{ pageIndex: 0, text: "正文。", x: 0.1, y: 0.2, width: 0.5, height: 0.1 }] }],
      });

      const insertRow = fileSqlite.prepare(`
        INSERT INTO reviews (id, owner_id, status, student_name, class_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, teacher_reviewed_at, has_report, summary_title, summary_grade, summary_is_legacy, ocr_revision_cached, summary_state_key, created_at, updated_at)
        VALUES (?, 'u1', 'ready_for_review', ?, '六（1）班', ?, ?, 3, 1, ?, 1, 1000, 1, '长文测试', 'A', 0, 1, NULL, 900, ?)
      `);
      const insertImg = fileSqlite.prepare(`
        INSERT INTO review_images (review_id, page_index, path, position, original_name, mime_type, original_path, annotation_path, ai_path, width, height, rotation, created_at)
        VALUES (?, 0, 'images/p0.jpg', 0, 'p0.jpg', 'image/jpeg', 'images/p0.jpg', 'images/p0.jpg', 'images/p0.jpg', 1000, 1400, 0, 1)
      `);
      for (let i = 0; i < 20; i += 1) {
        const id = `large-${i + 1}`;
        insertRow.run(id, `学生${i + 1}`, JSON.stringify({ title: "长文测试" }), largeReportJson, validOcrJson, 1000 + i);
        insertImg.run(id);
      }
      fileSqlite.close();

      const sizeBeforeDryRun = statSync(existingDbPath).size;
      const roLocal = createLocalSqliteAdapter(existingDbPath, true);
      try {
        const dryReport = await inspectDryRunSummaryBackfill(roLocal.db);
        expect(dryReport).toEqual({
          staleCount: 20,
          inspectedCount: 20,
          readyCount: 20,
          blockedCount: 0,
        });
      } finally {
        roLocal.close();
      }
      expect(statSync(existingDbPath).size).toBe(sizeBeforeDryRun);
      expect(existsSync(`${existingDbPath}-wal`)).toBe(false);

      // 3) 模拟远端 Wrangler JSON 输出缓冲上限 256KB（20×60KB > 1.2MB 必触发 ENOBUFS）-> 自动拆批完成全部 20 条回填
      const rwSqlite = new Database(existingDbPath);
      try {
        const simulatedRemoteDb = createRemoteD1Adapter(false, (sql) => {
          const stmt = rwSqlite.prepare(sql);
          if (stmt.reader) {
            const rows = stmt.all() as Array<Record<string, unknown>>;
            const serialized = JSON.stringify([{ results: rows }]);
            if (Buffer.byteLength(serialized, "utf8") > 256 * 1024) {
              const err = new Error("spawnSync wrangler ENOBUFS") as Error & { code?: string };
              err.code = "ENOBUFS";
              throw err;
            }
            return { rows, changes: 0 };
          }
          const info = stmt.run();
          return { rows: [], changes: info.changes };
        });

        const outcome = await adaptiveBackfillSummaries(simulatedRemoteDb, { initialBatchSize: 20 });
        expect(outcome.remainingStaleCount).toBe(0);
        expect(outcome.updatedRows).toBe(20);
        expect(outcome.minBatchSizeUsed).toBeLessThan(20);

        const summary = await new D1ReviewReader(d1Shim(rwSqlite)).summaryPage("u1", { page: 1, pageSize: 20 });
        expect(summary.exportableReviewedIds).toHaveLength(20);
        expect(summary.summaryBackfillPending).toBeUndefined();
      } finally {
        rwSqlite.close();
      }

      // 4) WAL 模式 SQLite 数据库 --dry-run：预演期间与关闭后原目录清单恒为 ['wal-clean.db']（零 -wal/-shm 旁文件），主库 SHA-256 恒定不变
      const walDir = path.join(tmpDir, "wal-isolated");
      const walCreated = mkdtempSync(`${walDir}-`);
      const walDbPath = path.join(walCreated, "wal-clean.db");
      const walSqlite = new Database(walDbPath);
      walSqlite.pragma("journal_mode = WAL");
      migrationFiles().forEach((name) => {
        const sql = readFileSync(path.join(MIGRATIONS, name), "utf8")
          .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*(OFF|ON)\s*;/gimu, "");
        walSqlite.exec(sql);
      });
      walSqlite.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES ('u1', 'teacher', 'x', 'teacher', 0, 1, 1)").run();
      walSqlite.prepare(`
        INSERT INTO reviews (id, owner_id, status, student_name, class_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, teacher_reviewed_at, has_report, summary_title, summary_grade, summary_is_legacy, summary_state_key, created_at, updated_at)
        VALUES ('wal-r1', 'u1', 'ready_for_review', '学生甲', '六（1）班', '{"title":"WAL预演"}', ?, 1, 1, ?, 1, 1000, 1, 'WAL预演', 'A', 0, NULL, 900, 1000)
      `).run(largeReportJson, validOcrJson);
      walSqlite.prepare(`
        INSERT INTO review_images (review_id, page_index, path, position, original_name, mime_type, original_path, annotation_path, ai_path, width, height, rotation, created_at)
        VALUES ('wal-r1', 0, 'images/p0.jpg', 0, 'p0.jpg', 'image/jpeg', 'images/p0.jpg', 'images/p0.jpg', 'images/p0.jpg', 1000, 1400, 0, 1)
      `).run();
      walSqlite.close();

      expect(readdirSync(walCreated)).toEqual(["wal-clean.db"]);
      const shaBefore = createHash("sha256").update(readFileSync(walDbPath)).digest("hex");

      const walRo = createLocalSqliteAdapter(walDbPath, true);
      try {
        // 打开期间目标目录也绝不出现 -wal 或 -shm
        expect(readdirSync(walCreated)).toEqual(["wal-clean.db"]);
        const walReport = await inspectDryRunSummaryBackfill(walRo.db);
        expect(readdirSync(walCreated)).toEqual(["wal-clean.db"]);
        expect(walReport).toEqual({
          staleCount: 1,
          inspectedCount: 1,
          readyCount: 1,
          blockedCount: 0,
        });
      } finally {
        walRo.close();
      }
      expect(readdirSync(walCreated)).toEqual(["wal-clean.db"]);
      const shaAfter = createHash("sha256").update(readFileSync(walDbPath)).digest("hex");
      expect(shaAfter).toBe(shaBefore);

      // 5) 活跃 WAL 数据库拒绝非一致性预演 + 主库复制后发生 ENOENT / 并发连接变化时必须彻底清理临时目录（零 snapshot.db 残留）
      const isolatedTempRoot = mkdtempSync(path.join(tmpDir, "temp-root-"));

      // 5a) 存在活跃 WAL 连接（产生 -wal/-shm）时：在打开前明确拒绝，源目录与临时目录均无多余残留
      const liveWriter = new Database(walDbPath);
      liveWriter.exec("UPDATE reviews SET student_name = '写入中' WHERE id = 'wal-r1'");
      expect(existsSync(`${walDbPath}-wal`)).toBe(true);
      expect(() => createLocalSqliteAdapter(walDbPath, true, { tempRootDir: isolatedTempRoot })).toThrow(/活跃 WAL/u);
      expect(readdirSync(isolatedTempRoot)).toEqual([]);
      liveWriter.close();
      expect(readdirSync(walCreated)).toEqual(["wal-clean.db"]);

      // 5b) 主库 snapshot.db 已写入临时目录后，二次核验阶段触发 ENOENT（如源库被移走/清理）：必须清理临时目录，不留任何 snapshot.db
      const transientDir = mkdtempSync(path.join(tmpDir, "transient-"));
      const transientDbPath = path.join(transientDir, "transient.db");
      const transientCopy = new Database(transientDbPath);
      transientCopy.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      transientCopy.close();

      expect(() => createLocalSqliteAdapter(transientDbPath, true, {
        tempRootDir: isolatedTempRoot,
        onAfterMainCopy: (snapshotDbPath) => {
          // 确认此时 snapshot.db 确实已被创建在临时目录中，随后模拟 ENOENT
          expect(existsSync(snapshotDbPath)).toBe(true);
          rmSync(transientDbPath);
        },
      })).toThrow(/ENOENT/u);
      expect(readdirSync(transientDir)).toEqual([]);
      expect(readdirSync(isolatedTempRoot)).toEqual([]);

      // 5c) 主库 snapshot.db 已复制后，源库突然被新写入连接打开产生 -wal：必须拒绝撕裂快照并彻底清理临时目录
      expect(() => createLocalSqliteAdapter(walDbPath, true, {
        tempRootDir: isolatedTempRoot,
        onAfterMainCopy: (snapshotDbPath) => {
          expect(existsSync(snapshotDbPath)).toBe(true);
          const raceConn = new Database(walDbPath);
          raceConn.exec("UPDATE reviews SET student_name = '复制期并发写' WHERE id = 'wal-r1'");
          // 保持连接打开使 -wal 存在，随后在断言外关闭
          setTimeout(() => {
            try { raceConn.close(); } catch { /* ignore */ }
          }, 0);
        },
      })).toThrow(/并发写入或连接变动/u);
      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(readdirSync(walCreated)).toEqual(["wal-clean.db"]);
      expect(readdirSync(isolatedTempRoot)).toEqual([]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("前 20 条历史记录含异常 JSON 类型（如 version 为字符串 '2'）时保守判为不可导出，绝不卡死或饿死第 21 条正常记录", async () => {
    const { db, apply } = openLikeD1();
    migrationFiles().forEach(apply);
    db.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES ('u1', 'teacher', 'x', 'teacher', 0, 1, 1)").run();

    const validDiagnostics = {
      authenticityAndRelevance: { finding: "真实。", action: "保留。" },
      materialAndDetails: { finding: "具体。", action: "保留。" },
      structure: { finding: "完整。", action: "保留。" },
      language: { finding: "通顺。", action: "保留。" },
    };
    const validReportJson = JSON.stringify({
      version: 2,
      themeFit: "fits",
      themeReason: "切题。",
      personalizedComment: "真实。",
      painPoints: [],
      commonIssues: [],
      revisionSuggestions: [],
      parentFeedbacks: [],
      grade: "A",
      diagnostics: validDiagnostics,
      paragraphReviews: [{ paragraphId: "paragraph-1", suggestions: [{ advice: "保留" }], revisedText: "正文。" }],
      rewrittenEssay: ["正文。"],
    });
    const validOcrJson = JSON.stringify({
      version: 2,
      sourceRevision: 1,
      ocrRevision: 1,
      editedAt: null,
      pages: [{ pageIndex: 0, text: "正文。", readable: true, warnings: [], blocks: [{ text: "正文。", x: 0.1, y: 0.2, width: 0.5, height: 0.1 }] }],
      paragraphs: [{ id: "paragraph-1", paragraphIndex: 0, text: "正文。", segments: [{ pageIndex: 0, text: "正文。", x: 0.1, y: 0.2, width: 0.5, height: 0.1 }] }],
    });

    const insertRow = db.prepare(`
      INSERT INTO reviews (id, owner_id, status, student_name, class_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, teacher_reviewed_at, summary_state_key, created_at, updated_at)
      VALUES (?, 'u1', 'ready_for_review', ?, '六（1）班', '{"title":"异常OCR回归"}', ?, 3, 1, ?, 1, 1000, NULL, 900, ?)
    `);
    const insertImg = db.prepare(`
      INSERT INTO review_images (review_id, page_index, path, position, original_name, mime_type, original_path, annotation_path, ai_path, width, height, rotation, created_at)
      VALUES (?, 0, 'images/p0.jpg', 0, 'p0.jpg', 'image/jpeg', 'images/p0.jpg', 'images/p0.jpg', 'images/p0.jpg', 1000, 1400, 0, 1)
    `);

    // 前 20 条（updated_at 更大，排在最前）：ocr_checkpoint 含字符串 version ("2")
    for (let i = 0; i < 20; i += 1) {
      const id = `bad-ocr-${i + 1}`;
      insertRow.run(id, `异常生${i + 1}`, validReportJson, '{"version":"2"}', 5000 - i);
      insertImg.run(id);
    }
    // 第 21 条（排在 20 条之后）：完全正常的有效 v2 已审核记录
    insertRow.run("normal-21", "正常生21", validReportJson, validOcrJson, 1000);
    insertImg.run("normal-21");

    const shimDb = d1Shim(db);
    const outcome = await adaptiveBackfillSummaries(shimDb, { initialBatchSize: 20 });
    expect(outcome).toEqual({
      updatedRows: 21,
      remainingStaleCount: 0,
      minBatchSizeUsed: 20,
    });

    const summary = await new D1ReviewReader(shimDb).summaryPage("u1", { page: 1, pageSize: 20 });
    expect(summary.summaryBackfillPending).toBeUndefined();
    expect(summary.exportableReviewedIds).toEqual(["normal-21"]);
  });

  it("前 120 条记录在回填读取后持续并发递增 revision 时，Keyset 游标仍先完成后续正常尾行回填，再带已更新数与剩余冲突数报错非零退出", async () => {
    const { db, apply } = openLikeD1();
    migrationFiles().forEach(apply);
    db.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES ('u1', 'teacher', 'x', 'teacher', 0, 1, 1)").run();

    const validDiagnostics = {
      authenticityAndRelevance: { finding: "真实。", action: "保留。" },
      materialAndDetails: { finding: "具体。", action: "保留。" },
      structure: { finding: "完整。", action: "保留。" },
      language: { finding: "通顺。", action: "保留。" },
    };
    const validReportJson = JSON.stringify({
      version: 2,
      themeFit: "fits",
      themeReason: "切题。",
      personalizedComment: "真实。",
      painPoints: [],
      commonIssues: [],
      revisionSuggestions: [],
      parentFeedbacks: [],
      grade: "A",
      diagnostics: validDiagnostics,
      paragraphReviews: [{ paragraphId: "paragraph-1", suggestions: [{ advice: "保留" }], revisedText: "正文。" }],
      rewrittenEssay: ["正文。"],
    });
    const validOcrJson = JSON.stringify({
      version: 2,
      sourceRevision: 1,
      ocrRevision: 1,
      editedAt: null,
      pages: [{ pageIndex: 0, text: "正文。", readable: true, warnings: [], blocks: [{ text: "正文。", x: 0.1, y: 0.2, width: 0.5, height: 0.1 }] }],
      paragraphs: [{ id: "paragraph-1", paragraphIndex: 0, text: "正文。", segments: [{ pageIndex: 0, text: "正文。", x: 0.1, y: 0.2, width: 0.5, height: 0.1 }] }],
    });

    const insertRow = db.prepare(`
      INSERT INTO reviews (id, owner_id, status, student_name, class_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, teacher_reviewed_at, summary_state_key, created_at, updated_at)
      VALUES (?, 'u1', 'ready_for_review', ?, '六（1）班', '{"title":"120冲突尾行回归"}', ?, 3, 1, ?, 1, 1000, NULL, 900, ?)
    `);
    const insertImg = db.prepare(`
      INSERT INTO review_images (review_id, page_index, path, position, original_name, mime_type, original_path, annotation_path, ai_path, width, height, rotation, created_at)
      VALUES (?, 0, 'images/p0.jpg', 0, 'p0.jpg', 'image/jpeg', 'images/p0.jpg', 'images/p0.jpg', 'images/p0.jpg', 1000, 1400, 0, 1)
    `);

    const conflictingSet = new Set<string>();
    for (let i = 0; i < 120; i += 1) {
      const id = `conflict-${String(i + 1).padStart(3, "0")}`;
      conflictingSet.add(id);
      insertRow.run(id, `冲突生${i + 1}`, validReportJson, validOcrJson, 10_000 - i);
      insertImg.run(id);
    }
    const normalTailIds = ["tail-121", "tail-122", "tail-123", "tail-124", "tail-125"];
    normalTailIds.forEach((id, idx) => {
      insertRow.run(id, `正常尾生${idx + 1}`, validReportJson, validOcrJson, 1_000 - idx);
      insertImg.run(id);
    });

    const baseShim = d1Shim(db);
    const bumpRevisionStmt = db.prepare("UPDATE reviews SET revision = revision + 1 WHERE id = ?");
    const contendingDb: D1Database = {
      prepare(sql: string) {
        const inner = baseShim.prepare(sql);
        return {
          bind(...args: unknown[]) {
            const bound = inner.bind(...args);
            return {
              async all<T = Record<string, unknown>>() {
                const res = await bound.all<T>();
                if (sql.includes("FROM reviews") && sql.includes("summary_state_key")) {
                  for (const row of (res.results ?? []) as Array<{ id?: string }>) {
                    if (row.id && conflictingSet.has(row.id)) {
                      bumpRevisionStmt.run(row.id);
                    }
                  }
                }
                return res;
              },
              first: <T = unknown>() => bound.first<T>(),
              run: () => bound.run(),
            } as unknown as D1PreparedStatement;
          },
        } as unknown as D1PreparedStatement;
      },
      batch: (stmts: D1PreparedStatement[]) => baseShim.batch(stmts),
    } as unknown as D1Database;

    // 1) 执行自适应发布回填：由于前 120 条持续并发冲突，最终必须抛 SummaryBackfillIncompleteError（对应 CLI exitCode=1）
    let caughtError: unknown = null;
    try {
      await adaptiveBackfillSummaries(contendingDb, { initialBatchSize: 20 });
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toBeInstanceOf(SummaryBackfillIncompleteError);
    const incomplete = caughtError as SummaryBackfillIncompleteError;
    // 2) 同时断言：排在 120 条冲突行后面的 5 条正常尾行已全部完成回填更新，绝未被队首冲突饿死！
    expect(incomplete.updatedRows).toBe(5);
    expect(incomplete.remainingStaleCount).toBe(120);

    const tailStates = db.prepare(`
      SELECT id, summary_state_key, export_ready_version FROM reviews WHERE id IN ('tail-121', 'tail-122', 'tail-123', 'tail-124', 'tail-125') ORDER BY id ASC
    `).all() as Array<{ id: string; summary_state_key: string | null; export_ready_version: string | null }>;
    for (const row of tailStates) {
      expect(row.summary_state_key).not.toBeNull();
      expect(row.export_ready_version).toBe("3:1:1:1");
    }
  });

  it("默认 journal_mode=DELETE 下开启未提交大事务时拒绝预演脏读；CLI 拒绝 --dryrun 等拼写错误与无 --apply 写入；144KB 大 OCR 单条远端 UPDATE 低于 100KB 上限", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "round7-regressions-"));
    try {
      // 1) 默认 journal_mode=DELETE 开启大事务更新 400 条未提交（产生 -journal 并溢出脏页到主库）：预演必须拒绝脏读，回滚后读取原值
      const deleteModeDir = mkdtempSync(path.join(tmpDir, "delete-journal-"));
      const deleteDbPath = path.join(deleteModeDir, "rollback-mode.db");
      const isolatedTempRoot = mkdtempSync(path.join(tmpDir, "temp-root-"));

      const setupConn = new Database(deleteDbPath);
      expect(setupConn.pragma("journal_mode", { simple: true })).toBe("delete");
      setupConn.pragma("cache_size = 10"); // 强制小页缓存，使 400 条未提交更新立即溢出脏页到主库并写出 -journal
      migrationFiles().forEach((name) => {
        const sql = readFileSync(path.join(MIGRATIONS, name), "utf8")
          .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*(OFF|ON)\s*;/gimu, "");
        setupConn.exec(sql);
      });
      setupConn.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES ('u1', 'teacher', 'x', 'teacher', 0, 1, 1)").run();

      const validDiagnostics = {
        authenticityAndRelevance: { finding: "真实。", action: "保留。" },
        materialAndDetails: { finding: "具体。", action: "保留。" },
        structure: { finding: "完整。", action: "保留。" },
        language: { finding: "通顺。", action: "保留。" },
      };
      const reportJson = JSON.stringify({
        version: 2,
        themeFit: "fits",
        grade: "A",
        diagnostics: validDiagnostics,
        paragraphReviews: [{ paragraphId: "paragraph-1", suggestions: [{ advice: "保留" }], revisedText: "正文。" }],
        rewrittenEssay: ["正文。"],
      });
      const ocrJson = JSON.stringify({
        version: 2,
        sourceRevision: 1,
        ocrRevision: 1,
        editedAt: null,
        pages: [{ pageIndex: 0, text: "正文。", readable: true, warnings: [], blocks: [{ text: "正文。", x: 0.1, y: 0.2, width: 0.5, height: 0.1 }] }],
        paragraphs: [{ id: "paragraph-1", paragraphIndex: 0, text: "正文。", segments: [{ pageIndex: 0, text: "正文。", x: 0.1, y: 0.2, width: 0.5, height: 0.1 }] }],
      });

      const ins = setupConn.prepare(`
        INSERT INTO reviews (id, owner_id, status, student_name, class_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, teacher_reviewed_at, summary_state_key, created_at, updated_at)
        VALUES (?, 'u1', 'ready_for_review', ?, '六（1）班', '{"title":"回滚日志测试"}', ?, 1, 1, ?, 1, 1000, NULL, 900, ?)
      `);
      setupConn.exec("BEGIN");
      for (let i = 0; i < 400; i += 1) {
        ins.run(`del-${i + 1}`, `学生${i + 1}`, reportJson, ocrJson, 2000 + i);
      }
      setupConn.exec("COMMIT");

      // 开启未提交写事务修改全部 400 条使 summary_state_key 非空并撑大页面触发 spillover
      setupConn.exec("BEGIN");
      setupConn.prepare("UPDATE reviews SET student_name = ?, summary_state_key = '1:1:1:1:ready_for_review:1000'").run("未提交填充".repeat(80));
      expect(existsSync(`${deleteDbPath}-journal`)).toBe(true);

      // 此时预演必须拒绝读取含未提交回滚日志的数据库，绝不能把 399/400 条未提交改动当成已提交事实返回
      expect(() => createLocalSqliteAdapter(deleteDbPath, true, { tempRootDir: isolatedTempRoot })).toThrow(/-journal/u);
      expect(readdirSync(isolatedTempRoot)).toEqual([]);

      // 回滚事务并关闭连接后，预演应准确读到全部 400 条仍待回填
      setupConn.exec("ROLLBACK");
      setupConn.close();
      expect(existsSync(`${deleteDbPath}-journal`)).toBe(false);

      const cleanRo = createLocalSqliteAdapter(deleteDbPath, true, { tempRootDir: isolatedTempRoot });
      try {
        const cleanReport = await inspectDryRunSummaryBackfill(cleanRo.db);
        expect(cleanReport.staleCount).toBe(400);
        expect(cleanReport.inspectedCount).toBe(400);
      } finally {
        cleanRo.close();
      }
      expect(readdirSync(isolatedTempRoot)).toEqual([]);

      // 2) CLI 参数严格校验：拼写错误 --dryrun、重复传入 --sqlite A.db --sqlite B.db、重复 --d1/--apply/--dry-run、缺少模式参数一律拒绝（退出码 2，数据库 0 改动）
      expect(parseBackfillCliArgs(["--sqlite", deleteDbPath, "--dryrun"]).kind).toBe("error");
      expect(parseBackfillCliArgs(["--sqlite", path.join(tmpDir, "A.db"), "--sqlite", deleteDbPath, "--apply"]).kind).toBe("error");
      expect(parseBackfillCliArgs(["--d1", "--d1", "--apply"]).kind).toBe("error");
      expect(parseBackfillCliArgs(["--d1", "--apply", "--apply"]).kind).toBe("error");
      expect(parseBackfillCliArgs(["--d1", "--dry-run", "--dry-run"]).kind).toBe("error");
      expect(parseBackfillCliArgs(["--d1", "--apply", "--help"]).kind).toBe("error");
      expect(parseBackfillCliArgs(["--d1", "--dryrun"]).kind).toBe("error");
      expect(parseBackfillCliArgs(["--d1"]).kind).toBe("error");
      expect(parseBackfillCliArgs(["--sqlite", deleteDbPath]).kind).toBe("error");
      expect(parseBackfillCliArgs(["--d1", "--dry-run", "--apply"]).kind).toBe("error");
      expect(parseBackfillCliArgs(["--d1", "--apply"])).toEqual({
        kind: "run",
        target: "d1",
        sqlitePath: undefined,
        dryRun: false,
      });

      const cliTypoRun = spawnSync(
        process.execPath,
        [path.resolve(__dirname, "../node_modules/tsx/dist/cli.mjs"), path.resolve(__dirname, "../scripts/backfill-review-summaries.ts"), "--sqlite", deleteDbPath, "--dryrun"],
        { encoding: "utf8", cwd: path.resolve(__dirname, "..") },
      );
      expect(cliTypoRun.status).toBe(2);

      const cliDuplicateSqliteRun = spawnSync(
        process.execPath,
        [path.resolve(__dirname, "../node_modules/tsx/dist/cli.mjs"), path.resolve(__dirname, "../scripts/backfill-review-summaries.ts"), "--sqlite", path.join(tmpDir, "nonexistent-a.db"), "--sqlite", deleteDbPath, "--apply"],
        { encoding: "utf8", cwd: path.resolve(__dirname, "..") },
      );
      expect(cliDuplicateSqliteRun.status).toBe(2);
      expect(cliDuplicateSqliteRun.stderr).toContain("--sqlite");
      const verifyAfterTypo = new Database(deleteDbPath, { readonly: true });
      const nonNullAfterTypo = verifyAfterTypo.prepare("SELECT COUNT(*) AS n FROM reviews WHERE summary_state_key IS NOT NULL").get() as { n: number };
      verifyAfterTypo.close();
      expect(nonNullAfterTypo.n).toBe(0);

      // 3) 单条合法 > 144KB 的大 OCR 记录在模拟 D1 100KB 单语句上限下仍顺利完成正式回填（生成的 UPDATE 语句 < 5KB）
      const largeOcrDb = new Database(":memory:");
      largeOcrDb.pragma("foreign_keys = ON");
      migrationFiles().forEach((name) => {
        const sql = readFileSync(path.join(MIGRATIONS, name), "utf8")
          .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*(OFF|ON)\s*;/gimu, "");
        largeOcrDb.exec(sql);
      });
      largeOcrDb.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES ('u1', 'teacher', 'x', 'teacher', 0, 1, 1)").run();

      const denseBlocks = Array.from({ length: 900 }, (_, idx) => ({
        text: `第${idx + 1}行密集识别文本块内容用于压测超长合法检查点字节体积。`,
        x: 0.05,
        y: Number(((idx % 90) * 0.01).toFixed(4)),
        width: 0.85,
        height: 0.008,
      }));
      const fullPageText = denseBlocks.map((b) => b.text).join("");
      const hugeValidOcrJson = JSON.stringify({
        version: 2,
        sourceRevision: 1,
        ocrRevision: 1,
        editedAt: null,
        pages: [{
          pageIndex: 0,
          text: fullPageText,
          readable: true,
          warnings: [],
          blocks: denseBlocks,
        }],
        paragraphs: [{
          id: "paragraph-1",
          paragraphIndex: 0,
          text: fullPageText,
          segments: [{ pageIndex: 0, text: fullPageText, x: 0.05, y: 0.05, width: 0.85, height: 0.85 }],
        }],
      });
      expect(Buffer.byteLength(hugeValidOcrJson, "utf8")).toBeGreaterThan(144_000);
      expect(readStoredOcrCheckpoint(hugeValidOcrJson, 1)?.version).toBe(2);

      largeOcrDb.prepare(`
        INSERT INTO reviews (id, owner_id, status, student_name, class_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, teacher_reviewed_at, summary_state_key, created_at, updated_at)
        VALUES ('huge-ocr-1', 'u1', 'ready_for_review', '大OCR生', '六（1）班', '{"title":"大OCR回归"}', ?, 2, 1, ?, 1, 1000, NULL, 900, 1000)
      `).run(reportJson, hugeValidOcrJson);
      largeOcrDb.prepare(`
        INSERT INTO review_images (review_id, page_index, path, position, original_name, mime_type, original_path, annotation_path, ai_path, width, height, rotation, created_at)
        VALUES ('huge-ocr-1', 0, 'images/p0.jpg', 0, 'p0.jpg', 'image/jpeg', 'images/p0.jpg', 'images/p0.jpg', 'images/p0.jpg', 1000, 1400, 0, 1)
      `).run();

      const updateStatementBytes: number[] = [];
      const strict100KbRemoteDb = createRemoteD1Adapter(false, (sql) => {
        const byteLen = Buffer.byteLength(sql, "utf8");
        if (byteLen > 100_000) {
          throw new Error(`D1 SQL statement exceeded 100KB limit: ${byteLen} bytes`);
        }
        if (/^\s*UPDATE\s+reviews\b/iu.test(sql)) {
          updateStatementBytes.push(byteLen);
        }
        const stmt = largeOcrDb.prepare(sql);
        if (stmt.reader) {
          return { rows: stmt.all() as Array<Record<string, unknown>>, changes: 0 };
        }
        const info = stmt.run();
        return { rows: [], changes: info.changes };
      });

      const hugeOutcome = await adaptiveBackfillSummaries(strict100KbRemoteDb, { initialBatchSize: 20 });
      expect(hugeOutcome).toEqual({
        updatedRows: 1,
        remainingStaleCount: 0,
        minBatchSizeUsed: 20,
      });
      expect(updateStatementBytes).toHaveLength(1);
      expect(updateStatementBytes[0]!).toBeLessThan(5_000);

      const hugeSummary = await new D1ReviewReader(d1Shim(largeOcrDb)).summaryPage("u1", { page: 1, pageSize: 20 });
      expect(hugeSummary.exportableReviewedIds).toEqual(["huge-ocr-1"]);

      // 4) 对抗性超长字段回归：108KB 超长小数秒 editedAt 时间戳（通过 OCR 校验器）及 108KB 异常历史 version 字符串，UPDATE 语句仍严格 < 10KB（远低于 100KB 上限）
      const longFractionEditedAt = `2026-11-24T13:28:25.${"9".repeat(108_000)}Z`;
      const longEditedAtOcr = JSON.stringify({
        version: 2,
        sourceRevision: 1,
        ocrRevision: 1,
        editedAt: longFractionEditedAt,
        pages: [{ pageIndex: 0, text: "正文。", readable: true, warnings: [], blocks: [{ text: "正文。", x: 0.1, y: 0.2, width: 0.5, height: 0.1 }] }],
        paragraphs: [{ id: "paragraph-1", paragraphIndex: 0, text: "正文。", segments: [{ pageIndex: 0, text: "正文。", x: 0.1, y: 0.2, width: 0.5, height: 0.1 }] }],
      });
      expect(readStoredOcrCheckpoint(longEditedAtOcr, 1)?.version).toBe(2);

      const longAnomalousVersionOcr = JSON.stringify({
        version: `legacy-v2-${"x".repeat(108_000)}`,
        sourceRevision: 1,
        ocrRevision: 1,
      });

      largeOcrDb.prepare(`
        INSERT INTO reviews (id, owner_id, status, student_name, class_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, teacher_reviewed_at, summary_state_key, created_at, updated_at)
        VALUES ('huge-edited-at', 'u1', 'ready_for_review', '超长时间戳生', '六（1）班', '{"title":"超长时间戳"}', ?, 2, 1, ?, 1, 1000, NULL, 900, 999)
      `).run(reportJson, longEditedAtOcr);
      largeOcrDb.prepare(`
        INSERT INTO review_images (review_id, page_index, path, position, original_name, mime_type, original_path, annotation_path, ai_path, width, height, rotation, created_at)
        VALUES ('huge-edited-at', 0, 'images/p0.jpg', 0, 'p0.jpg', 'image/jpeg', 'images/p0.jpg', 'images/p0.jpg', 'images/p0.jpg', 1000, 1400, 0, 1)
      `).run();

      largeOcrDb.prepare(`
        INSERT INTO reviews (id, owner_id, status, student_name, class_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, teacher_reviewed_at, summary_state_key, created_at, updated_at)
        VALUES ('huge-bad-version', 'u1', 'ready_for_review', '超长异常版本生', '六（1）班', '{"title":"超长异常版本"}', ?, 2, 1, ?, 1, 1000, NULL, 900, 998)
      `).run(reportJson, longAnomalousVersionOcr);

      updateStatementBytes.length = 0;
      const adversarialOutcome = await adaptiveBackfillSummaries(strict100KbRemoteDb, { initialBatchSize: 20 });
      expect(adversarialOutcome).toEqual({
        updatedRows: 2,
        remainingStaleCount: 0,
        minBatchSizeUsed: 20,
      });
      expect(updateStatementBytes).toHaveLength(2);
      for (const byteLen of updateStatementBytes) {
        expect(byteLen).toBeLessThan(10_000);
      }

      const afterAdversarial = await new D1ReviewReader(d1Shim(largeOcrDb)).summaryPage("u1", { page: 1, pageSize: 20 });
      expect(afterAdversarial.exportableReviewedIds).toEqual(["huge-ocr-1", "huge-edited-at"]);

      // 5) 合法超长四维诊断回归（总字节 > 112KB，完全符合报告契约且预演 readyCount=1）：摘要预览截断使远端 UPDATE 严格 < 20KB，单批一次回填成功且完整报告原文无损
      const hugeValidDiagnosticsReport = JSON.stringify({
        version: 2,
        themeFit: "fits",
        themeReason: "切题。",
        personalizedComment: "真实感人。",
        painPoints: [],
        commonIssues: [],
        revisionSuggestions: [],
        parentFeedbacks: [],
        grade: "A",
        diagnostics: {
          authenticityAndRelevance: {
            finding: `细节真实自然。${"真".repeat(12_000)}`,
            action: `继续保持现场观察。${"实".repeat(12_000)}`,
          },
          materialAndDetails: validDiagnostics.materialAndDetails,
          structure: {
            finding: `段落推进清晰。${"结".repeat(12_000)}`,
            action: `过渡句再凝练一句。${"构".repeat(12_000)}`,
          },
          language: validDiagnostics.language,
        },
        paragraphReviews: [{ paragraphId: "paragraph-1", suggestions: [{ advice: "保留" }], revisedText: fullPageText }],
        rewrittenEssay: [fullPageText],
      });
      expect(Buffer.byteLength(hugeValidDiagnosticsReport, "utf8")).toBeGreaterThan(140_000);

      largeOcrDb.prepare(`
        INSERT INTO reviews (id, owner_id, status, student_name, class_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, teacher_reviewed_at, summary_state_key, created_at, updated_at)
        VALUES ('huge-diag-1', 'u1', 'ready_for_review', '超长诊断生', '六（1）班', ?, ?, 2, 1, ?, 1, 1000, NULL, 900, 997)
      `).run(JSON.stringify({ title: `超长题目${"题".repeat(500)}` }), hugeValidDiagnosticsReport, hugeValidOcrJson);
      largeOcrDb.prepare(`
        INSERT INTO review_images (review_id, page_index, path, position, original_name, mime_type, original_path, annotation_path, ai_path, width, height, rotation, created_at)
        VALUES ('huge-diag-1', 0, 'images/p0.jpg', 0, 'p0.jpg', 'image/jpeg', 'images/p0.jpg', 'images/p0.jpg', 'images/p0.jpg', 1000, 1400, 0, 1)
      `).run();

      const dryRunHugeDiag = await inspectDryRunSummaryBackfill(d1Shim(largeOcrDb));
      expect(dryRunHugeDiag.staleCount).toBe(1);
      expect(dryRunHugeDiag.readyCount).toBe(1);

      updateStatementBytes.length = 0;
      const hugeDiagOutcome = await adaptiveBackfillSummaries(strict100KbRemoteDb, { initialBatchSize: 1 });
      expect(hugeDiagOutcome).toEqual({
        updatedRows: 1,
        remainingStaleCount: 0,
        minBatchSizeUsed: 1,
      });
      expect(updateStatementBytes).toHaveLength(1);
      expect(updateStatementBytes[0]!).toBeLessThan(20_000);

      const afterHugeDiag = await new D1ReviewReader(d1Shim(largeOcrDb)).summaryPage("u1", { page: 1, pageSize: 20 });
      expect(afterHugeDiag.exportableReviewedIds).toContain("huge-diag-1");
      const storedRow = largeOcrDb.prepare(
        "SELECT report, summary_title, summary_grade, summary_diagnostics FROM reviews WHERE id = 'huge-diag-1'",
      ).get() as { report: string; summary_title: string; summary_grade: string; summary_diagnostics: string };
      expect(storedRow.report).toBe(hugeValidDiagnosticsReport);
      // 严格断言省略号已计入字符上限：标题 <= 200（精确 200）、等级 <= 16、四项诊断预览各自 <= 500（精确 500）
      expect(Array.from(storedRow.summary_title)).toHaveLength(200);
      expect(Array.from(storedRow.summary_grade).length).toBeLessThanOrEqual(16);
      const parsedStoredDiag = JSON.parse(storedRow.summary_diagnostics) as {
        authenticityAndRelevance: { finding: string; action: string };
        structure: { finding: string; action: string };
      };
      expect(Array.from(parsedStoredDiag.authenticityAndRelevance.finding)).toHaveLength(500);
      expect(Array.from(parsedStoredDiag.authenticityAndRelevance.action)).toHaveLength(500);
      expect(Array.from(parsedStoredDiag.structure.finding)).toHaveLength(500);
      expect(Array.from(parsedStoredDiag.structure.action)).toHaveLength(500);

      // 同时核验 0015 SQL 迁移自身对已有超长标题与超长诊断行的截断长度同样严格 <= 200 / <= 500（省略号计入上限）
      const migCapDb = new Database(":memory:");
      migrationFiles()
        .filter((name) => name < "0015")
        .forEach((name) => {
          const sql = readFileSync(path.join(MIGRATIONS, name), "utf8")
            .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*(OFF|ON)\s*;/gimu, "");
          migCapDb.exec(sql);
        });
      migCapDb.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES ('u1', 'teacher', 'x', 'teacher', 0, 1, 1)").run();
      migCapDb.prepare(`
        INSERT INTO reviews (id, owner_id, status, student_name, class_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, teacher_reviewed_at, created_at, updated_at)
        VALUES ('mig-cap-1', 'u1', 'ready_for_review', '迁移限长生', '六（1）班', ?, ?, 1, 1, NULL, NULL, NULL, 100, 100)
      `).run(JSON.stringify({ title: `题${"目".repeat(400)}` }), hugeValidDiagnosticsReport);
      migCapDb.exec(readFileSync(path.join(MIGRATIONS, "0015_review_summary_fields.sql"), "utf8"));
      const migRow = migCapDb.prepare("SELECT summary_title, summary_diagnostics FROM reviews WHERE id = 'mig-cap-1'").get() as {
        summary_title: string;
        summary_diagnostics: string;
      };
      expect(Array.from(migRow.summary_title)).toHaveLength(200);
      const migDiag = JSON.parse(migRow.summary_diagnostics) as {
        authenticityAndRelevance: { finding: string; action: string };
        structure: { finding: string; action: string };
      };
      expect(Array.from(migDiag.authenticityAndRelevance.finding)).toHaveLength(500);
      expect(Array.from(migDiag.authenticityAndRelevance.action)).toHaveLength(500);
      expect(Array.from(migDiag.structure.finding)).toHaveLength(500);
      expect(Array.from(migDiag.structure.action)).toHaveLength(500);

      // 6) 含嵌入 U+0000 空字符的超长文本（"甲\u0000" + 900 个 "乙"）经 0015 迁移后：
      //    在 JavaScript 中按码点回读标题与四项诊断长度严格为 200 与 500（不被 SQLite length(TEXT) 遇 NUL 截断绕过），且未审核记录保持 summary_state_key = NULL
      const embeddedNullDb = new Database(":memory:");
      migrationFiles()
        .filter((name) => name < "0015")
        .forEach((name) => {
          const sql = readFileSync(path.join(MIGRATIONS, name), "utf8")
            .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*(OFF|ON)\s*;/gimu, "");
          embeddedNullDb.exec(sql);
        });
      embeddedNullDb.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES ('u1', 'teacher', 'x', 'teacher', 0, 1, 1)").run();
      const textWithEmbeddedNull = `甲\u0000${"乙".repeat(900)}`;
      expect(Array.from(textWithEmbeddedNull)).toHaveLength(902);
      const nullReportJson = JSON.stringify({
        version: 2,
        themeFit: "fits",
        grade: `A\u0000${"B".repeat(40)}`,
        diagnostics: {
          authenticityAndRelevance: { finding: textWithEmbeddedNull, action: textWithEmbeddedNull },
          materialAndDetails: { finding: "具体。", action: "保留。" },
          structure: { finding: textWithEmbeddedNull, action: textWithEmbeddedNull },
          language: { finding: "通顺。", action: "保留。" },
        },
        paragraphReviews: [{ paragraphId: "paragraph-1", suggestions: [{ advice: "保留" }], revisedText: "正文。" }],
      });
      embeddedNullDb.prepare(`
        INSERT INTO reviews (id, owner_id, status, student_name, class_name, config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, teacher_reviewed_at, created_at, updated_at)
        VALUES ('null-cap-1', 'u1', 'ready_for_review', '空字符超长生', '六（1）班', ?, ?, 1, 1, NULL, NULL, NULL, 100, 100)
      `).run(JSON.stringify({ title: textWithEmbeddedNull }), nullReportJson);
      embeddedNullDb.exec(readFileSync(path.join(MIGRATIONS, "0015_review_summary_fields.sql"), "utf8"));

      const nullMigRow = embeddedNullDb.prepare(
        "SELECT summary_title, summary_grade, summary_diagnostics, summary_state_key FROM reviews WHERE id = 'null-cap-1'",
      ).get() as {
        summary_title: string;
        summary_grade: string;
        summary_diagnostics: string;
        summary_state_key: string | null;
      };
      expect(Array.from(nullMigRow.summary_title)).toHaveLength(200);
      expect(nullMigRow.summary_title).toBe(`甲\u0000${"乙".repeat(197)}…`);
      expect(Array.from(nullMigRow.summary_grade)).toHaveLength(16);
      expect(nullMigRow.summary_state_key).toBeNull();
      const nullMigDiag = JSON.parse(nullMigRow.summary_diagnostics) as {
        authenticityAndRelevance: { finding: string; action: string };
        structure: { finding: string; action: string };
      };
      expect(Array.from(nullMigDiag.authenticityAndRelevance.finding)).toHaveLength(500);
      expect(Array.from(nullMigDiag.authenticityAndRelevance.action)).toHaveLength(500);
      expect(Array.from(nullMigDiag.structure.finding)).toHaveLength(500);
      expect(Array.from(nullMigDiag.structure.action)).toHaveLength(500);
      expect(nullMigDiag.authenticityAndRelevance.finding).toBe(`甲\u0000${"乙".repeat(497)}…`);

      // 随后走生产发布脚本的真实远端序列化适配器（createRemoteD1Adapter + bindSqlForRemoteD1 + 真实 Node spawnSync 参数校验 + SQLite 执行）：
      // 断言生成的 SQL 零字面 NUL、不触发 ERR_INVALID_ARG_VALUE、单批清零且标题与等级逐码点无损一致
      const nullRemoteStatements: string[] = [];
      const nullRemoteDb = createRemoteD1Adapter(false, (sql) => {
        expect(sql.includes("\u0000")).toBe(false);
        expect(Buffer.byteLength(sql, "utf8")).toBeLessThan(100_000);
        const argvCheck = spawnSync(process.execPath, ["-e", "process.exit(0)", "--", "--command", sql]);
        expect(argvCheck.error).toBeUndefined();
        expect(argvCheck.status).toBe(0);
        nullRemoteStatements.push(sql);
        const stmt = embeddedNullDb.prepare(sql);
        if (stmt.reader) {
          return { rows: stmt.all() as Array<Record<string, unknown>>, changes: 0 };
        }
        const info = stmt.run();
        return { rows: [], changes: info.changes };
      });
      const nullBackfillOutcome = await adaptiveBackfillSummaries(nullRemoteDb, { initialBatchSize: 20 });
      expect(nullBackfillOutcome.updatedRows).toBe(1);
      expect(nullBackfillOutcome.remainingStaleCount).toBe(0);
      expect(nullRemoteStatements.some((sql) => /^\s*UPDATE\s+reviews\b/iu.test(sql))).toBe(true);

      const afterNullRemote = embeddedNullDb.prepare(
        "SELECT summary_title, summary_grade, summary_diagnostics, summary_state_key FROM reviews WHERE id = 'null-cap-1'",
      ).get() as {
        summary_title: string;
        summary_grade: string;
        summary_diagnostics: string;
        summary_state_key: string | null;
      };
      expect(afterNullRemote.summary_title).toBe(`甲\u0000${"乙".repeat(197)}…`);
      expect(Array.from(afterNullRemote.summary_title)).toHaveLength(200);
      expect(afterNullRemote.summary_grade).toBe(`A\u0000${"B".repeat(14)}`);
      expect(Array.from(afterNullRemote.summary_grade)).toHaveLength(16);
      expect(afterNullRemote.summary_state_key).not.toBeNull();
      embeddedNullDb.close();
      migCapDb.close();
      largeOcrDb.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("0016 班级整体花名册与作文题目索引迁移", () => {
  it("只新建表与增量索引，不改动已有表，且按题目/班级+题目筛选命中新索引", () => {
    const sql = readFileSync(path.join(MIGRATIONS, "0016_class_rosters_and_title_index.sql"), "utf8");
    expect(sql).not.toMatch(/DROP\s+TABLE|ALTER\s+TABLE|DELETE\s+FROM|UPDATE\s+/iu);

    const { db, apply } = openLikeD1();
    migrationFiles().forEach(apply);

    db.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES ('u1', 'teacher', 'x', 'teacher', 0, 1, 1)").run();
    db.prepare("INSERT INTO class_rosters (id, owner_id, class_name, students, created_at, updated_at) VALUES ('cr1', 'u1', '六（1）班', '[\"张三\",\"李四\"]', 1, 1)").run();
    expect(count(db, "class_rosters")).toBe(1);

    const titlePlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id FROM reviews WHERE owner_id = 'u1' AND deleting_at IS NULL AND summary_title = '为自己鼓掌' ORDER BY updated_at DESC, created_at DESC
    `).all() as Array<{ detail: string }>;
    expect(titlePlan.map((r) => r.detail).join(" ")).toContain("reviews_owner_title_updated_idx");

    const classTitlePlan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id FROM reviews WHERE owner_id = 'u1' AND deleting_at IS NULL AND class_name = '六（1）班' AND summary_title = '为自己鼓掌' ORDER BY updated_at DESC, created_at DESC
    `).all() as Array<{ detail: string }>;
    expect(classTitlePlan.map((r) => r.detail).join(" ")).toContain("reviews_owner_class_title_updated_idx");

    db.prepare("DELETE FROM users WHERE id = 'u1'").run();
    expect(count(db, "class_rosters")).toBe(0);
  });
});
