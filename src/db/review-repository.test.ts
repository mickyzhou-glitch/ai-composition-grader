// @vitest-environment node

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  Annotation,
  AssignmentConfig,
  EvaluationReport,
} from "../domain/contracts";
import { initializeSchema } from "./init";
import {
  CorruptReviewDataError,
  ReviewRepository,
} from "./review-repository";
import * as schema from "./schema";

const config: AssignmentConfig = {
  title: "为自己喝彩",
  grade: "上海五四学制六年级",
  writingRequirements: "写一件亲身经历的事。",
  targetCharacters: 600,
  structureRequirements: "开头点题，结尾升华。",
  scoringFocus: "细节描写。",
  templateType: "preset_self_applause",
};

const report: EvaluationReport = {
  themeFit: "fits",
  themeReason: "紧扣主题。",
  personalizedComment: "细节真实。",
  painPoints: ["结尾略快"],
  commonIssues: ["长句较多"],
  revisionSuggestions: ["补充感受"],
  scores: {
    themeIntent: 9,
    contentSelection: 9,
    structure: 7,
    languageExpression: 7,
    writingConventions: 4,
    total: 36,
    level: "优秀作文",
  },
  sampleParagraphs: Array.from({ length: 5 }, () => "我".repeat(110)),
};

const annotation: Annotation = {
  pageIndex: 0,
  x: 0.2,
  y: 0.3,
  category: "sentence",
  anchorText: "我跑得很快",
  comment: "可以增加动作细节。",
  isHighlight: false,
};

const customConfig: AssignmentConfig = {
  ...config,
  templateType: "custom",
};

const customReport: EvaluationReport = {
  ...report,
  sampleParagraphs: ["自定义范文。"],
};

describe("ReviewRepository", () => {
  let sqlite: Database.Database;
  let repository: ReviewRepository;
  let tick: number;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    initializeSchema(sqlite);
    // Schema initialization must be safe at every application startup.
    initializeSchema(sqlite);
    tick = 0;
    repository = new ReviewRepository(drizzle(sqlite, { schema }), {
      now: () => new Date(Date.UTC(2026, 6, 20, 10, 0, tick++)),
    });
  });

  afterEach(() => sqlite.close());

  it("创建并按 id 读取强类型配置和图片", () => {
    repository.create({
      id: "review-1",
      config,
      images: [
        {
          position: 0,
          originalName: "第一页.jpg",
          mimeType: "image/jpeg",
          originalPath: "images/page-1-original.jpg",
          annotationPath: "images/page-1-annotation.jpg",
          aiPath: "images/page-1-ai.jpg",
          width: 1200,
          height: 1600,
          rotation: 0,
          crop: null,
        },
      ],
    });

    const saved = repository.getById("review-1");

    expect(saved).toMatchObject({
      id: "review-1",
      status: "draft",
      config,
      report: null,
    });
    expect(saved?.createdAt).toBeInstanceOf(Date);
    expect(saved?.images[0]).toMatchObject({
      position: 0,
      originalName: "第一页.jpg",
      originalPath: "images/page-1-original.jpg",
      annotationPath: "images/page-1-annotation.jpg",
      aiPath: "images/page-1-ai.jpg",
      width: 1200,
      height: 1600,
    });
  });

  it("在一个同步读事务内聚合 review 快照", () => {
    repository.create({ id: "review-1", config });
    const database = drizzle(sqlite, { schema });
    const transaction = vi.spyOn(database, "transaction");
    repository = new ReviewRepository(database);

    expect(repository.getById("review-1")?.id).toBe("review-1");
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("SQLite 查询错误保持原错误而不伪装成损坏数据", () => {
    repository.create({ id: "review-1", config });
    sqlite.exec("ALTER TABLE reviews RENAME COLUMN config TO broken_config");

    try {
      repository.getById("review-1");
      throw new Error("expected getById to fail");
    } catch (error) {
      expect(error).not.toBeInstanceOf(CorruptReviewDataError);
      expect(error).toMatchObject({ code: "SQLITE_ERROR" });
    }
  });

  it("按更新时间倒序列出历史记录", () => {
    repository.create({ id: "older", config });
    repository.create({ id: "newer", config });

    expect(repository.list().map((review) => review.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("更新报告、状态和配置", () => {
    repository.create({ id: "review-1", config });
    repository.updateReport("review-1", report);
    repository.updateStatus("review-1", "ready_for_review");
    repository.updateConfig("review-1", {
      ...config,
      title: "我为自己喝彩",
    });

    const updated = repository.getById("review-1");
    expect(updated?.report).toEqual(report);
    expect(updated?.status).toBe("ready_for_review");
    expect(updated?.config.title).toBe("我为自己喝彩");
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(
      updated?.createdAt.getTime() ?? Number.POSITIVE_INFINITY,
    );
  });

  it("写入报告时传递 incompleteEvent 评分约束", () => {
    repository.create({ id: "review-1", config });

    expect(() =>
      repository.updateReport("review-1", report, { incompleteEvent: true }),
    ).toThrow(/29/);
  });

  it("从 custom 改为 preset 时清理不合规报告与批注并降级为 draft", () => {
    repository.create({ id: "review-1", config: customConfig });
    repository.updateReport("review-1", customReport);
    repository.replaceAnnotations("review-1", [annotation]);
    repository.updateStatus("review-1", "ready_for_review");

    const updated = repository.updateConfig("review-1", config);

    expect(updated.config.templateType).toBe("preset_self_applause");
    expect(updated.report).toBeNull();
    expect(updated.annotations).toEqual([]);
    expect(updated.status).toBe("draft");
  });

  it("配置切换清理失败时回滚整个事务", () => {
    repository.create({ id: "review-1", config: customConfig });
    repository.updateReport("review-1", customReport);
    repository.replaceAnnotations("review-1", [annotation]);
    repository.updateStatus("review-1", "ready_for_review");
    sqlite.exec(`
      CREATE TRIGGER reject_annotation_delete
      BEFORE DELETE ON annotations
      BEGIN
        SELECT RAISE(ABORT, 'forced annotation delete failure');
      END;
    `);

    expect(() => repository.updateConfig("review-1", config)).toThrow(
      /forced annotation delete failure/,
    );
    sqlite.exec("DROP TRIGGER reject_annotation_delete");

    const unchanged = repository.getById("review-1");
    expect(unchanged?.config).toEqual(customConfig);
    expect(unchanged?.report).toEqual(customReport);
    expect(unchanged?.annotations).toEqual([annotation]);
    expect(unchanged?.status).toBe("ready_for_review");
  });

  it.each([
    ["config", JSON.stringify({ title: "broken" })],
    [
      "report",
      JSON.stringify({
        ...report,
        scores: { ...report.scores, total: 35 },
      }),
    ],
  ])("读取损坏的 %s JSON 时抛出明确错误", (field, value) => {
    repository.create({ id: "review-1", config });
    sqlite.prepare(`update reviews set ${field} = ? where id = ?`).run(
      value,
      "review-1",
    );

    expect(() => repository.getById("review-1")).toThrow(
      new RegExp(`corrupt.*${field}`, "i"),
    );
  });

  it.each(["config", "report"])(
    "读取语法损坏的 %s JSON 时指明字段",
    (field) => {
      repository.create({ id: "review-1", config });
      sqlite.prepare(`update reviews set ${field} = ? where id = ?`).run(
        "{not-json",
        "review-1",
      );

      expect(() => repository.getById("review-1")).toThrow(
        new RegExp(`corrupt.*${field}`, "i"),
      );
    },
  );

  it("配置更新在事务内清理 falsy 损坏报告", () => {
    repository.create({ id: "review-1", config: customConfig });
    sqlite.prepare("update reviews set report = 'false' where id = ?").run(
      "review-1",
    );

    const updated = repository.updateConfig("review-1", config);

    expect(updated.report).toBeNull();
    expect(updated.status).toBe("draft");
  });

  it("原子替换一篇作文的全部批注", () => {
    repository.create({ id: "review-1", config });
    repository.replaceAnnotations("review-1", [annotation, { ...annotation, x: 0.8 }]);
    repository.replaceAnnotations("review-1", [
      { ...annotation, category: "highlight", isHighlight: true },
    ]);

    expect(repository.getById("review-1")?.annotations).toEqual([
      { ...annotation, category: "highlight", isHighlight: true },
    ]);
  });

  it("替换图片会清理旧分析并回到 draft", () => {
    repository.create({ id: "review-1", config });
    repository.updateReport("review-1", report);
    repository.replaceAnnotations("review-1", [annotation]);
    repository.updateStatus("review-1", "ready_for_review");

    const updated = repository.replaceImages("review-1", []);

    expect(updated).toMatchObject({ status: "draft", report: null, annotations: [] });
  });

  it("原子保存可辨认或不可辨认的 AI 分析结果", () => {
    repository.create({ id: "review-1", config });
    const ready = repository.saveAnalysis("review-1", {
      readable: true,
      pageWarnings: [],
      report,
      annotations: [annotation],
    });
    expect(ready).toMatchObject({
      status: "ready_for_review",
      report,
      annotations: [annotation],
    });

    const unreadable = repository.saveAnalysis("review-1", {
      readable: false,
      pageWarnings: ["图片模糊"],
      annotations: [],
    });
    expect(unreadable).toMatchObject({
      status: "needs_better_images",
      report: null,
      annotations: [],
    });
  });

  it("教师编辑 report/annotations 原子提交并由仓储置为 ready", () => {
    repository.create({ id: "review-1", config });
    sqlite.exec(`
      CREATE TRIGGER reject_teacher_annotation
      BEFORE INSERT ON annotations
      BEGIN
        SELECT RAISE(ABORT, 'forced teacher edit failure');
      END;
    `);

    expect(() =>
      repository.updateTeacherEdits("review-1", {
        config: { ...config, title: "不应半保存" },
        report,
        annotations: [annotation],
      }),
    ).toThrow(/forced teacher edit failure/);
    expect(repository.getById("review-1")).toMatchObject({
      status: "draft",
      report: null,
      config,
      annotations: [],
    });

    sqlite.exec("DROP TRIGGER reject_teacher_annotation");
    expect(
      repository.updateTeacherEdits("review-1", {
        report,
        annotations: [annotation],
      }),
    ).toMatchObject({ status: "ready_for_review", report });
  });

  it("删除 review 并级联删除图片和批注记录", () => {
    repository.create({
      id: "review-1",
      config,
      images: [{
        position: 0,
        originalName: "page.jpg",
        mimeType: "image/jpeg",
        originalPath: "images/page-original.jpg",
        annotationPath: "images/page-annotation.jpg",
        aiPath: "images/page-ai.jpg",
        width: 100,
        height: 100,
        rotation: 0,
        crop: null,
      }],
    });
    repository.replaceAnnotations("review-1", [annotation]);

    expect(repository.delete("review-1")).toBe(true);
    expect(repository.getById("review-1")).toBeNull();
    expect(
      sqlite.prepare("select count(*) as count from review_images").get(),
    ).toEqual({ count: 0 });
    expect(
      sqlite.prepare("select count(*) as count from annotations").get(),
    ).toEqual({ count: 0 });
    expect(repository.delete("missing")).toBe(false);
  });
});
