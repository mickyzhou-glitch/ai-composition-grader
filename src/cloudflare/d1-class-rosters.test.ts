// @vitest-environment node
import { describe, expect, it } from "vitest";
import { d1Shim, migratedDatabase } from "../../test/d1-sqlite-shim";
import { D1ClassRosters } from "./d1-class-rosters";
import { D1ReviewReader } from "./d1-review-reader";
import { D1ReviewWriter } from "./d1-review-writer";
import { D1ImageWriter } from "./d1-image-writer";
import { D1OcrCheckpointRepository } from "./d1-ocr-checkpoint";
import { savePipelineResult } from "../../worker/index";

const baseConfig = {
  title: "为自己鼓掌",
  grade: "六年级",
  writingRequirements: "叙事具体",
  targetCharacters: 600,
  structureRequirements: "五段完整",
  scoringFocus: "细节描写",
  templateType: "custom" as const,
};

const sampleReport = {
  version: 2 as const,
  themeFit: "fits" as const,
  themeReason: "切题。",
  personalizedComment: "真实。",
  painPoints: [],
  commonIssues: [],
  revisionSuggestions: [],
  grade: "A" as const,
  diagnostics: {
    authenticityAndRelevance: { finding: "真实。", action: "保留。" },
    materialAndDetails: { finding: "具体。", action: "保留。" },
    structure: { finding: "完整。", action: "保留。" },
    language: { finding: "通顺。", action: "保留。" },
  },
  paragraphReviews: [{
    paragraphId: "paragraph-1",
    suggestions: [{ advice: "保留原文" }],
    revisedText: "我攥紧稿纸。",
  }],
  rewrittenEssay: ["我攥紧稿纸。"],
  parentFeedbacks: [],
};

describe("D1ClassRosters & summaryPage title/roster integration", () => {
  it("supports upsert (replace/append), slash class names, owner isolation, delete, and classes() union", async () => {
    const sqlite = migratedDatabase();
    try {
      sqlite.prepare("INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at) VALUES ('u2', 'teacher2', 'x', 'teacher', 0, 1, 1)").run();
      const db = d1Shim(sqlite);
      const repo = new D1ClassRosters(db);
      const reader = new D1ReviewReader(db);

      const saved1 = await repo.upsert("u1", {
        className: "六（1）/A班",
        students: ["1. 张　三", "李四", "张三"],
      });
      expect(saved1).toEqual([
        expect.objectContaining({ className: "六（1）/A班", students: ["张三", "李四"] }),
      ]);

      // append 模式保留原顺序并追加新学生、自动去重
      const appended = await repo.upsert("u1", {
        rosters: [
          { className: "六（1）/A班", students: ["李四", "王五"] },
          { className: "六（2）班", students: ["赵六"] },
        ],
        mode: "append",
      });
      expect(appended.map((r) => ({ className: r.className, students: r.students }))).toEqual([
        { className: "六（1）/A班", students: ["张三", "李四", "王五"] },
        { className: "六（2）班", students: ["赵六"] },
      ]);

      // 租户隔离：u2 看不到 u1 的花名册，也删不掉 u1 的花名册
      expect(await repo.list("u2")).toEqual([]);
      expect(await repo.delete("u2", "六（1）/A班")).toBe(false);

      // reader.classes 合并花名册中的班级（即使该班尚无批改记录）
      expect(await reader.classes("u1")).toEqual(["六（1）/A班", "六（2）班"]);

      expect(await repo.delete("u1", "六（1）/A班")).toBe(true);
      expect((await repo.list("u1")).map((r) => r.className)).toEqual(["六（2）班"]);
    } finally {
      sqlite.close();
    }
  });

  it("filters summaryPage & exportableReviewedIds by titleFilter and returns full cross-page titleSubmissions without reading blobs", async () => {
    const sqlite = migratedDatabase();
    try {
      const baseDb = d1Shim(sqlite);
      const rosters = new D1ClassRosters(baseDb);
      const writer = new D1ReviewWriter(baseDb);
      const imageWriter = new D1ImageWriter(baseDb);
      const ocrRepo = new D1OcrCheckpointRepository(baseDb);

      // 全班 25 人（超过单页 20 条上限），其中 22 人交了《为自己鼓掌》，3 人未交；另有 1 篇另一题目《春游》已审核通过
      const allStudents = Array.from({ length: 25 }, (_, idx) => `学生${idx + 1}`);
      await rosters.upsert("u1", { className: "六（1）班", students: allStudents });

      async function createApprovedEssay(studentName: string, title: string) {
        const cfg = { ...baseConfig, title };
        const created = await writer.create("u1", { config: cfg, studentName, className: "六（1）班" });
        await imageWriter.replace("u1", created.id, created.revision, [{
          originalName: "p1.jpg",
          mimeType: "image/jpeg",
          width: 1200,
          height: 1600,
          path: "images/p1.jpg",
        }], true);
        const jobId = `job-${created.id}`;
        sqlite.prepare("UPDATE reviews SET status = 'analyzing', analysis_run_id = ? WHERE id = ?").run(jobId, created.id);
        sqlite.prepare(`
          INSERT INTO analysis_jobs (id, review_id, owner_id, mode, status, attempt, available_at, progress_stage, created_at)
          VALUES (?, ?, 'u1', 'full', 'running', 1, 1, 'generating_review', 1)
        `).run(jobId, created.id);
        const ocr = await ocrRepo.saveRecognized("u1", created.id, 1, {
          pages: [{
            pageIndex: 0,
            text: "我攥紧稿纸。",
            readable: true,
            warnings: [],
            blocks: [{ text: "我攥紧稿纸。", x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
          }],
          paragraphs: [{
            paragraphIndex: 0,
            text: "我攥紧稿纸。",
            segments: [{ pageIndex: 0, text: "我攥紧稿纸。", x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
          }],
        }, jobId);
        await savePipelineResult(
          baseDb,
          { id: jobId, reviewId: created.id, ownerId: "u1", mode: "full", imageRevision: 1, config: cfg },
          { report: sampleReport, annotations: [], ocrRevision: ocr.ocrRevision },
        );
        const ready = sqlite.prepare("SELECT revision FROM reviews WHERE id = ?").get(created.id) as { revision: number };
        await writer.completeTeacherReview("u1", created.id, {
          expectedRevision: ready.revision,
          studentName,
          report: sampleReport,
          annotations: [],
        });
        return created.id;
      }

      for (let i = 0; i < 22; i += 1) {
        await createApprovedEssay(allStudents[i]!, "为自己鼓掌");
      }
      const springTripId = await createApprovedEssay("学生23", "春游");
      sqlite.prepare("UPDATE reviews SET updated_at = updated_at + 1000 WHERE id = ?").run(springTripId);

      const executedSql: string[] = [];
      const trackedDb: D1Database = {
        prepare(sql: string) {
          executedSql.push(sql);
          return baseDb.prepare(sql);
        },
        batch: (stmts: D1PreparedStatement[]) => baseDb.batch(stmts),
      } as unknown as D1Database;

      const filteredPage = await new D1ReviewReader(trackedDb).summaryPage("u1", {
        page: 1,
        pageSize: 20,
        classFilter: "六（1）班",
        titleFilter: "为自己鼓掌",
      });

      expect(filteredPage.titles).toEqual(["春游", "为自己鼓掌"]);
      expect(filteredPage.totalFiltered).toBe(22);
      expect(filteredPage.items).toHaveLength(20);
      // 跨页全部 22 人均在 titleSubmissions 中，不会把第 2 页的 2 人误判成未交
      expect(filteredPage.titleSubmissions).toHaveLength(22);
      // 可导出集合严格限定在《为自己鼓掌》22 篇，绝不混入《春游》的记录
      expect(filteredPage.exportableReviewedIds).toHaveLength(22);
      expect(filteredPage.exportableReviewedIds).not.toContain(springTripId);

      // 全程零大字段（report / ocr_checkpoint / config / review_images）读取
      for (const sql of executedSql) {
        expect(sql).not.toMatch(/\breport\b/u);
        expect(sql).not.toMatch(/\bocr_checkpoint\b/u);
        expect(sql).not.toMatch(/\bconfig\b/u);
        expect(sql).not.toMatch(/\breview_images\b/u);
      }
    } finally {
      sqlite.close();
    }
  });
});
