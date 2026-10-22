// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { openAppDatabase } from "../src/db/client";
import { gradingOpinions } from "../src/db/schema";
import {
  D1_ESSAY_OPINIONS_SELECT,
  importHistoricalGradingOpinions,
  previewStandingOpinionsByTitle,
  previewStandingOpinionsByTitleFromD1,
} from "./import-grading-opinions";

const NOW = new Date("2026-10-22T02:00:00.000Z");
const LEGACY_HEADER = "以下是这位老师存档的长期批改要求，每次批改都必须遵守。与本次补充意见冲突时，以本次补充意见为准；与原文事实冲突时，以原文为准。";

describe("历史退回说明导入存档", () => {
  let directory = "";
  const openedDatabases: Array<ReturnType<typeof openAppDatabase>> = [];

  afterEach(() => {
    for (const opened of openedDatabases) opened.close();
    openedDatabases.length = 0;
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function createDatabase() {
    directory = mkdtempSync(path.join(os.tmpdir(), "grader-opinion-import-"));
    const opened = openAppDatabase(path.join(directory, "app.db"));
    openedDatabases.push(opened);
    opened.sqlite.prepare(`
      INSERT INTO users (
        id, username, password_hash, role, must_change_password, created_at, updated_at
      ) VALUES ('teacher-a', 'teacher-a', '!test', 'teacher', 0, ?, ?)
    `).run(NOW.valueOf(), NOW.valueOf());
    return opened;
  }

  function insertReview(opened: ReturnType<typeof openAppDatabase>, id: string) {
    opened.sqlite.prepare(`
      INSERT INTO reviews (
        id, owner_id, status, student_name, class_name, config, revision, created_at, updated_at
      ) VALUES (?, 'teacher-a', 'ready_for_review', '小明', '六1班', ?, 2, ?, ?)
    `).run(id, JSON.stringify({
      title: "我终于明白了",
      grade: "六年级",
      writingRequirements: "写一件事",
      targetCharacters: 600,
      structureRequirements: "五段",
      scoringFocus: "细节",
      templateType: "custom",
    }), NOW.valueOf(), NOW.valueOf());
  }

  function insertJob(
    opened: ReturnType<typeof openAppDatabase>,
    values: { id: string; reviewId: string; guidance: string | null; createdAt?: number },
  ) {
    const createdAt = values.createdAt ?? NOW.valueOf();
    opened.sqlite.prepare(`
      INSERT INTO analysis_jobs (
        id, review_id, owner_id, mode, status, attempt, available_at, progress_stage,
        teacher_guidance, created_at
      ) VALUES (?, ?, 'teacher-a', 'full', 'succeeded', 1, ?, 'saving_result', ?, ?)
    `).run(values.id, values.reviewId, createdAt, values.guidance, createdAt);
  }

  it("默认只列出历史退回说明，再次执行不会重复写入", () => {
    const opened = createDatabase();
    insertReview(opened, "review-1");
    insertJob(opened, {
      id: "job-revision",
      reviewId: "review-1",
      guidance: `[不合适原因]\n第2段太空\n[修改要求]\n写具体\n\n${LEGACY_HEADER}\n1. 旧规则`,
    });
    insertJob(opened, {
      id: "job-note",
      reviewId: "review-1",
      guidance: "老师补充：这次多看心理",
      createdAt: NOW.valueOf() + 1,
    });
    insertJob(opened, {
      id: "job-standing",
      reviewId: "review-1",
      guidance: `${LEGACY_HEADER}\n【结构】\n1. 应该怎么改：旧规则`,
      createdAt: NOW.valueOf() + 2,
    });
    insertJob(opened, {
      id: "job-done",
      reviewId: "review-1",
      guidance: "[不合适原因]\n已经存过\n[修改要求]\n保持",
      createdAt: NOW.valueOf() + 3,
    });
    opened.sqlite.prepare(`
      INSERT INTO grading_opinions (
        id, owner_id, body, reason, change_request, category, source_review_id, source_job_id,
        source_student_name, source_class_name, source_title, created_at, updated_at
      ) VALUES (
        'opinion-done', 'teacher-a', '为什么不合适：已经存过\n应该怎么改：保持',
        '已经存过', '保持', '其他', 'review-1', 'job-done', '小明', '六1班', '我终于明白了', ?, ?
      )
    `).run(NOW.valueOf(), NOW.valueOf());
    opened.sqlite.prepare(`
      INSERT INTO grading_opinions (
        id, owner_id, body, reason, change_request, source_review_id,
        source_student_name, source_class_name, source_title, created_at, updated_at
      ) VALUES (
        'opinion-old', 'teacher-a', '为什么不合适：结构散\n应该怎么改：严格五段',
        '', '', 'review-1', '小明', '六1班', '我终于明白了', ?, ?
      )
    `).run(NOW.valueOf() - 1_000, NOW.valueOf() - 1_000);
    insertJob(opened, {
      id: "job-old",
      reviewId: "review-1",
      guidance: "[不合适原因]\n结构散\n[修改要求]\n严格五段",
      createdAt: NOW.valueOf() - 1_000,
    });

    const preview = importHistoricalGradingOpinions(opened.db, { apply: false });
    expect(preview).toMatchObject({
      apply: false,
      inspected: 5,
      skipped: 3,
      applied: 0,
    });
    expect(preview.imported).toEqual([
      expect.objectContaining({
        jobId: "job-old",
        action: "link",
        studentName: "小明",
        className: "六1班",
        title: "我终于明白了",
        reason: "结构散",
        changeRequest: "严格五段",
        category: "结构",
      }),
      expect.objectContaining({
        jobId: "job-revision",
        action: "insert",
        reason: "第2段太空",
        changeRequest: "写具体",
        paragraphLabel: "第2段",
        category: "结构",
      }),
    ]);
    expect(opened.db.select().from(gradingOpinions).all()).toHaveLength(2);

    let next = 0;
    const applied = importHistoricalGradingOpinions(opened.db, {
      apply: true,
      createId: () => `opinion-new-${++next}`,
    });
    expect(applied.applied).toBe(2);
    const linked = opened.db.select().from(gradingOpinions).where(eq(gradingOpinions.id, "opinion-old")).get();
    expect(linked).toMatchObject({
      reason: "结构散",
      changeRequest: "严格五段",
      sourceJobId: "job-old",
      category: "结构",
    });
    const inserted = opened.db.select().from(gradingOpinions).where(eq(gradingOpinions.sourceJobId, "job-revision")).get();
    expect(inserted).toMatchObject({
      id: "opinion-new-1",
      reason: "第2段太空",
      changeRequest: "写具体",
      paragraphLabel: "第2段",
      sourceStudentName: "小明",
      sourceClassName: "六1班",
      sourceTitle: "我终于明白了",
      createdAt: NOW,
    });

    const again = importHistoricalGradingOpinions(opened.db, { apply: true });
    expect(again.imported).toEqual([]);
    expect(again.applied).toBe(0);
    expect(opened.db.select().from(gradingOpinions).all()).toHaveLength(3);
  });

  it("重新打开数据库时把合并正文拆成两项文字", () => {
    const opened = createDatabase();
    const body = "为什么不合适：结构散\n应该怎么改：严格五段";
    opened.sqlite.prepare(`
      INSERT INTO grading_opinions (
        id, owner_id, body, reason, change_request, created_at, updated_at
      ) VALUES ('opinion-merged', 'teacher-a', ?, ?, '', ?, ?)
    `).run(body, body, NOW.valueOf(), NOW.valueOf());
    opened.close();
    openedDatabases.length = 0;

    const reopened = openAppDatabase(path.join(directory, "app.db"));
    openedDatabases.push(reopened);
    expect(reopened.sqlite.prepare(`
      SELECT reason, change_request AS changeRequest FROM grading_opinions WHERE id = 'opinion-merged'
    `).get()).toEqual({ reason: "结构散", changeRequest: "严格五段" });
  });

  it("按来源题目列出历史共性意见，并且不写入", () => {
    const opened = createDatabase();
    const insert = opened.sqlite.prepare(`
      INSERT INTO grading_opinions (
        id, owner_id, body, reason, change_request, category, scope,
        source_student_name, source_title, created_at, updated_at
      ) VALUES (?, 'teacher-a', ?, '', ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run("essay-structure", "严格五段", "严格五段", "结构", "essay", "小明", "我终于明白了", NOW.valueOf(), NOW.valueOf());
    insert.run("essay-common", "这是共性意见", "这是共性意见", "内容", "essay", "小红", "我终于明白了", NOW.valueOf() + 1, NOW.valueOf() + 1);
    insert.run("essay-content", "写具体心理", "写具体心理", "内容", "essay", "小刚", "我终于明白了", NOW.valueOf() + 2, NOW.valueOf() + 2);
    insert.run("essay-other-title", "开头点题", "开头点题", "结构", "essay", "小李", "另一篇题目", NOW.valueOf(), NOW.valueOf());
    insert.run("standing-rule", "已经是长期规则", "已经是长期规则", "结构", "standing", "小明", "我终于明白了", NOW.valueOf(), NOW.valueOf());

    expect(previewStandingOpinionsByTitle(opened.db)).toEqual([
      {
        title: "另一篇题目",
        count: 1,
        opinions: [{ id: "essay-other-title", text: "开头点题", category: "结构", studentName: "小李" }],
      },
      {
        title: "我终于明白了",
        count: 2,
        opinions: [
          { id: "essay-structure", text: "严格五段", category: "结构", studentName: "小明" },
          { id: "essay-common", text: "这是共性意见", category: "内容", studentName: "小红" },
        ],
      },
    ]);
    expect(opened.db.select().from(gradingOpinions).all()).toHaveLength(5);
    expect(opened.db.select().from(gradingOpinions).where(eq(gradingOpinions.scope, "standing")).all()).toHaveLength(1);
  });

  it("--d1 预览只执行 SELECT，合并已存档意见和未导入的旧退回说明", () => {
    const statements: string[] = [];
    const execute = (statement: string) => {
      statements.push(statement);
      if (statement === D1_ESSAY_OPINIONS_SELECT) {
        return { changes: 0, rows: [
          { id: "op-1", reason: "", change_request: "严格五段", body: "严格五段", category: "结构", source_title: "我终于明白了", source_student_name: "小明", source_job_id: "job-archived", created_at: 1 },
          { id: "op-2", reason: "", change_request: "写具体心理", body: "写具体心理", category: "内容", source_title: "我终于明白了", source_student_name: "小刚", source_job_id: null, created_at: 2 },
        ] };
      }
      return { changes: 0, rows: [
        { job_id: "job-archived", teacher_guidance: "[不合适原因]\n结构乱\n[修改要求]\n分五段", created_at: 3, student_name: "小明", config: JSON.stringify({ title: "我终于明白了" }) },
      ] };
    };
    const preview = previewStandingOpinionsByTitleFromD1(execute);
    expect(statements.every((statement) => statement.trimStart().startsWith("SELECT"))).toBe(true);
    expect(preview).toEqual([
      { title: "我终于明白了", count: 1, opinions: [{ id: "op-1", text: "严格五段", category: "结构", studentName: "小明" }] },
    ]);
  });
});
