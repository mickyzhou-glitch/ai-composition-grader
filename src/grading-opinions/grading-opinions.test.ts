// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { D1GradingOpinions, listD1StandingOpinions } from "../cloudflare/d1-grading-opinions";
import { openAppDatabase } from "../db/client";
import { initializeSchema } from "../db/init";
import { AnalysisJobRepository } from "../jobs/analysis-job-repository";
import { ReanalysisRepository } from "../reanalysis/reanalysis-repository";
import { GradingOpinionRepository } from "./grading-opinion-repository";
import { STANDING_GUIDANCE_HEADER } from "./standing-guidance";

const NOW = new Date("2026-10-22T02:00:00.000Z");
const OWNER = "teacher-a";
const OTHER = "teacher-b";
const config = {
  title: "我终于明白了",
  grade: "六年级",
  writingRequirements: "写一件事",
  targetCharacters: 600,
  structureRequirements: "五段",
  scoringFocus: "细节",
  templateType: "custom" as const,
};

function d1From(sqlite: Database.Database) {
  return {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let args: unknown[] = [];
      return {
        bind(...bindings: unknown[]) {
          args = bindings;
          return this;
        },
        async first<T>() {
          return (statement.get(...args) as T | undefined) ?? null;
        },
        async all<T>() {
          return { results: statement.all(...args) as T[] };
        },
        async run() {
          return { meta: { changes: statement.run(...args).changes } };
        },
      };
    },
  } as unknown as D1Database;
}

describe("批改意见存档", () => {
  let directory: string;
  let opened: ReturnType<typeof openAppDatabase>;
  let reanalysis: ReanalysisRepository;
  let jobs: AnalysisJobRepository;
  let opinions: GradingOpinionRepository;

  afterEach(() => {
    opened?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  function setup() {
    directory = mkdtempSync(path.join(os.tmpdir(), "grading-opinions-"));
    opened = openAppDatabase(path.join(directory, "app.db"));
    for (const ownerId of [OWNER, OTHER]) {
      opened.sqlite.prepare(`
        INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at)
        VALUES (?, ?, '!test', 'teacher', 0, ?, ?)
      `).run(ownerId, ownerId, NOW.valueOf(), NOW.valueOf());
    }
    let nextJob = 0;
    let nextOpinion = 0;
    reanalysis = new ReanalysisRepository(opened.db, { now: () => NOW, createId: () => "job-reanalysis" });
    jobs = new AnalysisJobRepository(opened.db, { now: () => NOW, createId: () => `job-${++nextJob}` });
    opinions = new GradingOpinionRepository(opened.db, { now: () => new Date(NOW.valueOf() + 60_000), createId: () => `opinion-${++nextOpinion}` });
  }

  function insertReview(id: string, ownerId = OWNER, revision = 1) {
    opened.sqlite.prepare(`
      INSERT INTO reviews (
        id, owner_id, status, student_name, class_name, config, revision, created_at, updated_at
      ) VALUES (?, ?, 'ready_for_review', '小明', '六1班', ?, ?, ?, ?)
    `).run(id, ownerId, JSON.stringify(config), revision, NOW.valueOf(), NOW.valueOf());
    opened.sqlite.prepare(`
      INSERT INTO review_images (
        review_id, page_index, path, position, original_name, mime_type,
        original_path, annotation_path, ai_path, width, height, rotation, created_at
      ) VALUES (?, 0, 'images/page.jpg', 0, 'page.jpg', 'image/jpeg',
        'images/original.jpg', 'images/annotation.jpg', 'images/ai.jpg', 20, 20, 0, ?)
    `).run(id, NOW.valueOf());
  }

  it("第一框成为长期规则，第二框只留在当前作文，完全不能用都不写入", () => {
    setup();
    insertReview("review-1");

    reanalysis.rejectReview(OWNER, "review-1", {
      expectedRevision: 1,
      reason: "只写了一件事",
      changeRequest: "不要编情节",
    });
    expect(opinions.list(OWNER)).toEqual([]);

    reanalysis.requestRevision(OWNER, "review-1", {
      expectedRevision: 2,
      commonIssue: "第2段太空就收成一段",
      contentSuggestion: "写具体心理",
    });
    expect(opinions.list(OWNER)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: "standing",
        changeRequest: "第2段太空就收成一段",
        paragraphLabel: "第2段",
        category: "结构",
        sourceReviewId: "review-1",
        sourceJobId: "job-reanalysis",
        sourceStudentName: "小明",
        sourceClassName: "六1班",
        sourceTitle: "我终于明白了",
      }),
      expect.objectContaining({
        scope: "essay",
        changeRequest: "写具体心理",
        category: "内容",
        sourceReviewId: "review-1",
        sourceJobId: "job-reanalysis",
      }),
    ]));
  });

  it("删掉作文或重新分析后意见还在，并注入这位老师之后的全部批改", () => {
    setup();
    insertReview("review-1");
    reanalysis.requestRevision(OWNER, "review-1", {
      expectedRevision: 1,
      commonIssue: "严格五段",
      contentSuggestion: "写具体心理",
    });
    opened.sqlite.prepare("UPDATE reviews SET report = '{\"saved\":true}' WHERE id = 'review-1'").run();
    expect(opinions.list(OWNER)).toHaveLength(2);

    opened.sqlite.prepare("DELETE FROM reviews WHERE id = 'review-1'").run();
    expect(opinions.list(OWNER)).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: "standing", changeRequest: "严格五段", sourceStudentName: "小明", sourceTitle: "我终于明白了" }),
      expect.objectContaining({ scope: "essay", changeRequest: "写具体心理" }),
    ]));

    insertReview("review-2");
    jobs.createOrGet(OWNER, "review-2", "这次多看心理");
    const stored = opened.sqlite.prepare("SELECT teacher_guidance AS teacherGuidance FROM analysis_jobs WHERE review_id = 'review-2'")
      .get() as { teacherGuidance: string };
    expect(stored.teacherGuidance).toContain("这次多看心理");
    expect(stored.teacherGuidance).toContain(STANDING_GUIDANCE_HEADER);
    expect(stored.teacherGuidance).toContain("严格五段");
    expect(stored.teacherGuidance).not.toContain("写具体心理");

    insertReview("review-other-title");
    opened.sqlite.prepare("UPDATE reviews SET config = ? WHERE id = 'review-other-title'").run(JSON.stringify({
      ...config,
      title: "另一篇题目",
    }));
    jobs.createOrGet(OWNER, "review-other-title");
    expect(opened.sqlite.prepare("SELECT teacher_guidance AS teacherGuidance FROM analysis_jobs WHERE review_id = 'review-other-title'").get())
      .toEqual({ teacherGuidance: null });

    insertReview("review-other", OTHER);
    jobs.createOrGet(OTHER, "review-other");
    expect(opened.sqlite.prepare("SELECT teacher_guidance AS teacherGuidance FROM analysis_jobs WHERE review_id = 'review-other'").get())
      .toEqual({ teacherGuidance: null });
  });

  it("相同意见只注入一次，编辑和删除会改变之后的批改要求", () => {
    setup();
    insertReview("review-1");
    opinions.insert({
      ownerId: OWNER,
      text: "扣住题目",
      scope: "standing",
      sourceReviewId: "review-1",
      sourceStudentName: "小明",
      sourceClassName: "六1班",
      sourceTitle: "我终于明白了",
      createdAt: new Date(NOW.valueOf() - 1_000),
    });
    opinions.insert({
      ownerId: OWNER,
      text: "扣住题目",
      scope: "standing",
      sourceReviewId: "review-1",
      sourceStudentName: "小明",
      sourceClassName: "六1班",
      sourceTitle: "我终于明白了",
      createdAt: NOW,
    });
    opinions.insert({
      ownerId: OWNER,
      text: "只改这篇的心理",
      scope: "essay",
      sourceReviewId: "review-1",
      sourceStudentName: "小明",
      sourceClassName: "六1班",
      sourceTitle: "我终于明白了",
      createdAt: NOW,
    });
    insertReview("review-2");
    const queued = () => opened.sqlite.prepare(
      "SELECT teacher_guidance AS teacherGuidance FROM analysis_jobs WHERE review_id = 'review-2' AND status = 'queued'",
    ).get() as { teacherGuidance: string | null };
    jobs.createOrGet(OWNER, "review-2");
    expect(queued().teacherGuidance.match(/扣住题目/gu)).toHaveLength(1);
    expect(queued().teacherGuidance).not.toContain("只改这篇的心理");

    opened.sqlite.prepare("UPDATE analysis_jobs SET status = 'succeeded' WHERE review_id = 'review-2'").run();
    for (const opinion of opinions.list(OWNER)) opinions.delete(OWNER, opinion.id);
    expect(opinions.list(OWNER).some((opinion) => opinion.scope === "essay")).toBe(true);
    const kept = opinions.insert({
      ownerId: OWNER,
      text: "开头保留原句，只润色",
      scope: "standing",
      sourceReviewId: "review-1",
      sourceStudentName: "小明",
      sourceClassName: "六1班",
      sourceTitle: "我终于明白了",
      createdAt: NOW,
    });
    jobs.createOrGet(OWNER, "review-2");
    expect(queued().teacherGuidance).toContain("开头保留原句，只润色");
    expect(queued().teacherGuidance).not.toContain("扣住题目");

    expect(opinions.delete(OTHER, kept.id)).toBe(false);
    expect(opinions.delete(OWNER, kept.id)).toBe(true);
    opened.sqlite.prepare("UPDATE analysis_jobs SET status = 'succeeded' WHERE review_id = 'review-2'").run();
    jobs.createOrGet(OWNER, "review-2");
    expect(queued().teacherGuidance).toBeNull();
  });

  it("按最新框架重新分析也会带上存档里的全部意见", () => {
    setup();
    insertReview("review-1");
    opinions.insert({
      ownerId: OWNER,
      text: "先抑后扬",
      scope: "standing",
      sourceReviewId: "review-1",
      sourceStudentName: "小明",
      sourceClassName: "六1班",
      sourceTitle: "我终于明白了",
      createdAt: NOW,
    });
    opinions.insert({
      ownerId: OWNER,
      text: "这篇补一个动作",
      scope: "essay",
      sourceReviewId: "review-1",
      sourceStudentName: "小明",
      sourceClassName: "六1班",
      sourceTitle: "我终于明白了",
      createdAt: NOW,
    });
    opened.sqlite.prepare(`
      INSERT INTO saved_assignments (id, owner_id, title, config, created_at, updated_at)
      VALUES ('assignment-1', ?, '我终于明白了', ?, ?, ?)
    `).run(OWNER, JSON.stringify(config), NOW.valueOf(), NOW.valueOf());
    const [matched] = reanalysis.preview(OWNER, ["review-1"]).matched;

    reanalysis.commitBatch(OWNER, [{
      reviewId: matched.reviewId,
      expectedRevision: matched.expectedRevision,
      assignmentId: matched.assignmentId,
      expectedAssignmentUpdatedAt: matched.assignmentUpdatedAt,
    }]);

    const job = opened.sqlite.prepare(
      "SELECT teacher_guidance AS teacherGuidance FROM analysis_jobs WHERE review_id = 'review-1'",
    ).get() as { teacherGuidance: string };
    expect(job.teacherGuidance).toContain(STANDING_GUIDANCE_HEADER);
    expect(job.teacherGuidance).toContain("先抑后扬");
    expect(job.teacherGuidance).not.toContain("这篇补一个动作");
    expect(opinions.list(OWNER)).toHaveLength(2);
  });

  it("另一位老师不能改或删除这条存档", async () => {
    const sqlite = new Database(":memory:");
    initializeSchema(sqlite);
    sqlite.prepare(`
      INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at)
      VALUES ('teacher-a', 'teacher-a', '!test', 'teacher', 0, 1, 1),
             ('teacher-b', 'teacher-b', '!test', 'teacher', 0, 1, 1)
    `).run();
    sqlite.prepare(`
      INSERT INTO grading_opinions (
        id, owner_id, body, reason, change_request, category, scope, source_review_id,
        source_student_name, source_class_name, source_title, created_at, updated_at
      ) VALUES ('opinion-1', 'teacher-a', '用名言开头', '', '用名言开头', '结构', 'standing', 'review-1', '小明', '六1班', '我终于明白了', 10, 10)
    `).run();
    const archive = new D1GradingOpinions(d1From(sqlite));

    await expect(archive.list("teacher-b")).resolves.toEqual([]);
    await expect(archive.update("teacher-b", "opinion-1", { text: "重写" })).resolves.toBeNull();
    await expect(archive.delete("teacher-b", "opinion-1")).resolves.toBe(false);
    await expect(archive.list("teacher-a")).resolves.toMatchObject([{
      id: "opinion-1",
      text: "用名言开头",
      scope: "standing",
      sourceStudentName: "小明",
      sourceClassName: "六1班",
      sourceTitle: "我终于明白了",
    }]);
    await expect(archive.update("teacher-a", "opinion-1", { text: "改为五段", category: "结构" })).resolves.toMatchObject({
      text: "改为五段",
      scope: "standing",
      category: "结构",
    });
    await expect(listD1StandingOpinions(d1From(sqlite), "teacher-a", "我终于明白了")).resolves.toMatchObject([{ text: "改为五段" }]);
    await expect(listD1StandingOpinions(d1From(sqlite), "teacher-a", "另一篇题目")).resolves.toEqual([]);
    await expect(archive.delete("teacher-a", "opinion-1")).resolves.toBe(true);
    sqlite.close();
  });
});
