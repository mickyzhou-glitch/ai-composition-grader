// @vitest-environment node

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { openAppDatabase } from "../src/db/client";
import { reviews } from "../src/db/schema";
import {
  buildD1UpdateSql,
  createD1EssayStore,
  createSqliteEssayStore,
  formatSyncSummary,
  parseD1Payload,
  quoteSql,
  readSyncBackup,
  rollbackModelEssays,
  syncModelEssays,
  writeSyncBackup,
} from "./sync-model-essays";

const NOW = new Date("2026-08-22T02:00:00.000Z");
const essay = ["开篇改后。", "抑。", "扬。", "真相。", "结尾。"];

function paragraphReport(revised: string[], rewritten: string[] = essay) {
  return {
    version: 2,
    themeFit: "fits",
    themeReason: "切题",
    personalizedComment: "真实",
    painPoints: [],
    commonIssues: [],
    revisionSuggestions: [],
    grade: "A-",
    diagnostics: {
      authenticityAndRelevance: { finding: "真实", action: "保留" },
      materialAndDetails: { finding: "细节少", action: "补动作" },
      structure: { finding: "完整", action: "保留" },
      language: { finding: "普通", action: "改具体" },
    },
    rewrittenEssay: rewritten,
    paragraphReviews: revised.map((revisedText, index) => ({
      paragraphId: `paragraph-${index + 1}`,
      suggestions: [{ advice: "补细节" }],
      revisedText,
    })),
    parentFeedbacks: [],
  };
}

describe("sync-model-essays", () => {
  let directory = "";
  const openedDatabases: Array<ReturnType<typeof openAppDatabase>> = [];

  afterEach(() => {
    for (const opened of openedDatabases) opened.close();
    openedDatabases.length = 0;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function createDatabase() {
    directory = mkdtempSync(path.join(os.tmpdir(), "grader-sync-essays-"));
    const opened = openAppDatabase(path.join(directory, "app.db"));
    openedDatabases.push(opened);
    opened.sqlite.prepare(`
      INSERT INTO users (
        id, username, password_hash, role, must_change_password, created_at, updated_at
      ) VALUES ('teacher-a', 'teacher-a', '!test', 'teacher', 0, ?, ?)
    `).run(NOW.valueOf(), NOW.valueOf());
    return opened;
  }

  function insertReview(
    opened: ReturnType<typeof openAppDatabase>,
    values: {
      id: string;
      studentName: string;
      report: unknown;
      teacherReviewedAt?: number | null;
      ocrParagraphs?: number;
    },
  ) {
    const ocrParagraphs = values.ocrParagraphs ?? (
      (values.report as { paragraphReviews?: unknown[] }).paragraphReviews?.length ?? 1
    );
    opened.sqlite.prepare(`
      INSERT INTO reviews (
        id, owner_id, status, student_name, config, report, revision,
        teacher_reviewed_at, ocr_checkpoint, pdf_filename, pdf_path, pdf_revision, exported_at,
        created_at, updated_at
      ) VALUES (
        @id, 'teacher-a', 'exported', @studentName, @config, @report, 4,
        @teacherReviewedAt, @ocr, 'old.pdf', 'pdf/old.pdf', 4, @exportedAt,
        @createdAt, @updatedAt
      )
    `).run({
      id: values.id,
      studentName: values.studentName,
      config: JSON.stringify({
        title: "那一刻，我长大了",
        grade: "六年级",
        writingRequirements: "写一件事",
        targetCharacters: 600,
        structureRequirements: "严格五段",
        scoringFocus: "细节",
        templateType: "custom",
      }),
      report: JSON.stringify(values.report),
      teacherReviewedAt: values.teacherReviewedAt === undefined ? NOW.valueOf() : values.teacherReviewedAt,
      ocr: JSON.stringify({
        paragraphs: Array.from({ length: ocrParagraphs }, (_, index) => ({ id: `paragraph-${index + 1}` })),
      }),
      exportedAt: NOW.valueOf(),
      createdAt: NOW.valueOf(),
      updatedAt: NOW.valueOf(),
    });
  }

  it("dry-run 只列出改前改后段数，apply 先备份再写入，rollback 能恢复", () => {
    const opened = createDatabase();
    insertReview(opened, {
      id: "review-text",
      studentName: "任思蔚",
      report: paragraphReport(["开篇。", "抑。", "扬。", "真相。", "结尾。"]),
    });
    insertReview(opened, {
      id: "review-count",
      studentName: "喻佳妍",
      report: paragraphReport(["旧一", "旧二", "旧三", "旧四", "旧五", "旧六", "旧七"]),
      ocrParagraphs: 7,
    });
    insertReview(opened, {
      id: "review-same",
      studentName: "张宸熙",
      report: paragraphReport(essay),
    });
    insertReview(opened, {
      id: "review-open",
      studentName: "顾靖芊",
      report: paragraphReport(["开篇。", "抑。", "扬。", "真相。", "结尾。"]),
      teacherReviewedAt: null,
    });
    const backupPath = path.join(directory, "backup.json");
    const store = createSqliteEssayStore(opened.db);

    const preview = syncModelEssays(store, { apply: false, now: NOW, backupPath });
    expect(preview).toMatchObject({
      apply: false,
      target: "sqlite",
      inspected: 3,
      unchanged: 1,
      applied: 0,
      backupPath: null,
    });
    const textChange = preview.changed.find((item) => item.studentName === "任思蔚");
    const countChange = preview.changed.find((item) => item.studentName === "喻佳妍");
    expect(textChange).toMatchObject({
      beforeEssayCount: 5,
      beforeReviewCount: 5,
      afterEssayCount: 5,
      afterReviewCount: 5,
    });
    expect(countChange).toMatchObject({
      beforeEssayCount: 5,
      beforeReviewCount: 7,
      afterEssayCount: 5,
      afterReviewCount: 5,
    });
    expect(textChange?.summary).toContain("内容不一致");
    expect(countChange?.summary).toContain("段数不同");
    expect(formatSyncSummary(preview)).toContain("dry-run");
    expect(formatSyncSummary(preview)).toContain("任思蔚");
    expect(existsSync(backupPath)).toBe(false);
    expect(opened.db.select().from(reviews).where(eq(reviews.id, "review-text")).get()?.revision).toBe(4);

    const applied = syncModelEssays(store, { apply: true, now: NOW, backupPath });
    expect(applied.applied).toBe(2);
    expect(applied.backupPath).toBe(backupPath);
    const backup = readSyncBackup(backupPath);
    expect(backup.entries).toHaveLength(2);
    expect(backup.entries[0]?.pdfFilename).toBe("old.pdf");
    const textRow = opened.db.select().from(reviews).where(eq(reviews.id, "review-text")).get();
    expect(textRow?.revision).toBe(5);
    expect(textRow?.pdfFilename).toBeNull();
    expect(textRow?.teacherReviewedAt).toEqual(NOW);
    const textReport = textRow?.report as { paragraphReviews: Array<{ revisedText: string }> };
    expect(textReport.paragraphReviews[0]?.revisedText).toBe("开篇改后。");
    const countReport = opened.db.select().from(reviews).where(eq(reviews.id, "review-count")).get()?.report as {
      rewrittenEssay: string[];
      paragraphReviews: Array<{ revisedText: string }>;
    };
    expect(countReport.paragraphReviews).toHaveLength(5);
    expect(countReport.paragraphReviews.map((item) => item.revisedText)).toEqual(countReport.rewrittenEssay);
    const untouched = opened.db.select().from(reviews).where(eq(reviews.id, "review-open")).get();
    expect(untouched?.revision).toBe(4);

    const rolled = rollbackModelEssays(store, backup, { apply: true });
    expect(rolled.restored.map((item) => item.id)).toEqual(["review-text", "review-count"]);
    const restored = opened.db.select().from(reviews).where(eq(reviews.id, "review-text")).get();
    expect(restored?.revision).toBe(4);
    expect(restored?.pdfFilename).toBe("old.pdf");
    const restoredReport = restored?.report as { paragraphReviews: Array<{ revisedText: string }> };
    expect(restoredReport.paragraphReviews[0]?.revisedText).toBe("开篇。");
  });

  it("远程更新语句转义引号，并用返回的 changes 判断是否写到一行", () => {
    expect(quoteSql("老师说'好'。")).toBe("'老师说''好''。'");
    const calls: string[] = [];
    const store = createD1EssayStore((statement) => {
      calls.push(statement);
      if (statement.startsWith("SELECT")) {
        return parseD1Payload([{
          success: true,
          meta: { changes: 0 },
          results: [{
            id: "review-1",
            studentName: "杨宇宸",
            config: JSON.stringify({
              title: "那一刻，我长大了",
              structureRequirements: "严格五段",
            }),
            report: JSON.stringify(paragraphReport(["开篇。", "抑。", "扬。", "真相。", "结尾。"])),
            revision: 4,
            teacherReviewedAt: NOW.valueOf(),
            deletingAt: null,
            ocrCheckpoint: JSON.stringify({
              paragraphs: essay.map((_, index) => ({ id: `paragraph-${index + 1}` })),
            }),
            pdfFilename: "old.pdf",
            pdfPath: "pdf/old.pdf",
            pdfRevision: 4,
            exportedAt: NOW.valueOf(),
            updatedAt: NOW.valueOf(),
          }],
        }]);
      }
      return { rows: [], changes: 1 };
    });
    const backupPath = path.join(os.tmpdir(), `sync-d1-${Date.now()}.json`);
    const summary = syncModelEssays(store, {
      apply: true,
      now: NOW,
      backupPath,
      writeBackup: writeSyncBackup,
    });
    expect(summary.target).toBe("d1");
    expect(summary.applied).toBe(1);
    expect(summary.changed[0]).toMatchObject({
      studentName: "杨宇宸",
      beforeReviewCount: 5,
      afterReviewCount: 5,
    });
    expect(calls[1]).toContain("开篇改后。");
    expect(calls[1]).toContain("revision = 4");
    expect(calls[1]).not.toContain("开篇。");
    rmSync(backupPath, { force: true });
  });

  it("buildD1UpdateSql 带上修订号条件", () => {
    const statement = buildD1UpdateSql({
      id: "review-1",
      studentName: "杨宇宸",
      title: "那一刻",
      teacherReviewedAt: NOW,
      revision: 4,
      report: paragraphReport(essay),
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
      updatedAt: null,
    }, paragraphReport(essay), NOW);
    expect(statement).toContain("WHERE id = 'review-1' AND revision = 4");
    expect(statement).toContain("revision = revision + 1");
  });
});
