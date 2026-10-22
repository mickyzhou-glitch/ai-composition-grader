// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { openAppDatabase } from "../src/db/client";
import { reviews } from "../src/db/schema";
import { repairReviewedEssays } from "./repair-reviewed-essay-paragraphs";

const NOW = new Date("2026-08-22T02:00:00.000Z");
const essay = ["开篇改后。", "抑。", "扬。", "真相。", "结尾。"];

function paragraphReport(revised: string[]) {
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
    rewrittenEssay: essay,
    paragraphReviews: revised.map((revisedText, index) => ({
      paragraphId: `paragraph-${index + 1}`,
      suggestions: [{ advice: "补细节" }],
      revisedText,
    })),
    parentFeedbacks: [],
  };
}

describe("历史已审核作文一次性修复", () => {
  let directory = "";
  const openedDatabases: Array<ReturnType<typeof openAppDatabase>> = [];

  afterEach(() => {
    for (const opened of openedDatabases) opened.close();
    openedDatabases.length = 0;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function createDatabase() {
    directory = mkdtempSync(path.join(os.tmpdir(), "grader-essay-repair-"));
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
      report: unknown;
      teacherReviewedAt?: number | null;
      status?: string;
    },
  ) {
    opened.sqlite.prepare(`
      INSERT INTO reviews (
        id, owner_id, status, student_name, config, report, revision,
        teacher_reviewed_at, pdf_filename, pdf_path, pdf_revision, exported_at,
        created_at, updated_at
      ) VALUES (
        @id, 'teacher-a', @status, @studentName, @config, @report, 4,
        @teacherReviewedAt, 'old.pdf', 'pdf/old.pdf', 4, @exportedAt,
        @createdAt, @updatedAt
      )
    `).run({
      id: values.id,
      status: values.status ?? "exported",
      studentName: values.id === "review-kept" ? "张小明" : "王若宁",
      config: JSON.stringify({
        title: "为自己鼓掌",
        grade: "六年级",
        writingRequirements: "写一件事",
        targetCharacters: 600,
        structureRequirements: "严格五段",
        scoringFocus: "细节",
        templateType: "custom",
      }),
      report: JSON.stringify(values.report),
      teacherReviewedAt: values.teacherReviewedAt === undefined ? NOW.valueOf() : values.teacherReviewedAt,
      exportedAt: NOW.valueOf(),
      createdAt: NOW.valueOf(),
      updatedAt: NOW.valueOf(),
    });
  }

  it("默认只列出不一致的已审核作文，--apply 才按范文覆盖改后全段", () => {
    const opened = createDatabase();
    insertReview(opened, {
      id: "review-fix",
      report: paragraphReport(["开篇。", "抑。", "扬。", "真相。", "结尾。"]),
    });
    insertReview(opened, {
      id: "review-kept",
      report: paragraphReport(essay),
    });
    insertReview(opened, {
      id: "review-open",
      report: paragraphReport(["开篇。", "抑。", "扬。", "真相。", "结尾。"]),
      teacherReviewedAt: null,
      status: "ready_for_review",
    });

    const preview = repairReviewedEssays(opened.db, { apply: false, now: NOW });
    expect(preview).toMatchObject({
      apply: false,
      inspected: 2,
      applied: 0,
      changed: [{ id: "review-fix", studentName: "王若宁", title: "为自己鼓掌" }],
    });
    const before = opened.db.select().from(reviews).where(eq(reviews.id, "review-fix")).get();
    expect(before?.revision).toBe(4);
    expect(before?.pdfFilename).toBe("old.pdf");

    const applied = repairReviewedEssays(opened.db, { apply: true, now: NOW });
    expect(applied.applied).toBe(1);
    const after = opened.db.select().from(reviews).where(eq(reviews.id, "review-fix")).get();
    expect(after?.revision).toBe(5);
    expect(after?.teacherReviewedAt).toEqual(NOW);
    expect(after?.status).toBe("exported");
    expect(after?.pdfFilename).toBeNull();
    expect(after?.report).toMatchObject({
      rewrittenEssay: essay,
      paragraphReviews: essay.map((revisedText) => expect.objectContaining({ revisedText })),
    });
    const untouched = opened.db.select().from(reviews).where(eq(reviews.id, "review-open")).get();
    expect(untouched?.revision).toBe(4);
    const untouchedReport = untouched?.report as { paragraphReviews: Array<{ revisedText: string }> };
    expect(untouchedReport.paragraphReviews[0]?.revisedText).toBe("开篇。");
  });
});
