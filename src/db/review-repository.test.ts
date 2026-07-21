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

const OWNER_ID = "local-admin";

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
  sampleParagraphs: Array.from({ length: 5 }, (_, index) => ({
    title: `第 ${index + 1} 段`,
    text: "我".repeat(110),
    suggestion: "补充细节。",
  })),
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
  sampleParagraphs: [{ title: "自定义示例", text: "自定义范文。", suggestion: "补充细节。" }],
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
    repository.create(OWNER_ID, {
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

    const saved = repository.getById(OWNER_ID, "review-1");

    expect(saved).toMatchObject({
      id: "review-1",
      status: "draft",
      revision: 0,
      analysisRunId: null,
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
    repository.create(OWNER_ID, { id: "review-1", config });
    const database = drizzle(sqlite, { schema });
    const transaction = vi.spyOn(database, "transaction");
    repository = new ReviewRepository(database);

    expect(repository.getById(OWNER_ID, "review-1")?.id).toBe("review-1");
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("SQLite 查询错误保持原错误而不伪装成损坏数据", () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    sqlite.exec("ALTER TABLE reviews RENAME COLUMN config TO broken_config");

    try {
      repository.getById(OWNER_ID, "review-1");
      throw new Error("expected getById to fail");
    } catch (error) {
      expect(error).not.toBeInstanceOf(CorruptReviewDataError);
      expect(error).toMatchObject({ code: "SQLITE_ERROR" });
    }
  });

  it("按更新时间倒序列出历史记录", () => {
    repository.create(OWNER_ID, { id: "older", config });
    repository.create(OWNER_ID, { id: "newer", config });

    expect(repository.list(OWNER_ID).map((review) => review.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("更新配置即使仍兼容旧报告也清理分析结果并回到 draft", () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    repository.updateReport(OWNER_ID, "review-1", report);
    repository.replaceAnnotations(OWNER_ID, "review-1", [annotation]);
    repository.updateStatus(OWNER_ID, "review-1", "ready_for_review");
    repository.updateConfig(OWNER_ID, "review-1", {
      ...config,
      title: "我为自己喝彩",
    });

    const updated = repository.getById(OWNER_ID, "review-1");
    expect(updated?.report).toBeNull();
    expect(updated?.annotations).toEqual([]);
    expect(updated?.status).toBe("draft");
    expect(updated?.revision).toBe(3);
    expect(updated?.config.title).toBe("我为自己喝彩");
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(
      updated?.createdAt.getTime() ?? Number.POSITIVE_INFINITY,
    );
  });

  it("写入报告时传递 incompleteEvent 评分约束", () => {
    repository.create(OWNER_ID, { id: "review-1", config });

    expect(() =>
      repository.updateReport(OWNER_ID, "review-1", report, { incompleteEvent: true }),
    ).toThrow(/29/);
  });

  it("从 custom 改为 preset 时清理不合规报告与批注并降级为 draft", () => {
    repository.create(OWNER_ID, { id: "review-1", config: customConfig });
    repository.updateReport(OWNER_ID, "review-1", customReport);
    repository.replaceAnnotations(OWNER_ID, "review-1", [annotation]);
    repository.updateStatus(OWNER_ID, "review-1", "ready_for_review");

    const updated = repository.updateConfig(OWNER_ID, "review-1", config);

    expect(updated.config.templateType).toBe("preset_self_applause");
    expect(updated.report).toBeNull();
    expect(updated.annotations).toEqual([]);
    expect(updated.status).toBe("draft");
  });

  it("配置切换清理失败时回滚整个事务", () => {
    repository.create(OWNER_ID, { id: "review-1", config: customConfig });
    repository.updateReport(OWNER_ID, "review-1", customReport);
    repository.replaceAnnotations(OWNER_ID, "review-1", [annotation]);
    repository.updateStatus(OWNER_ID, "review-1", "ready_for_review");
    sqlite.exec(`
      CREATE TRIGGER reject_annotation_delete
      BEFORE DELETE ON annotations
      BEGIN
        SELECT RAISE(ABORT, 'forced annotation delete failure');
      END;
    `);

    expect(() => repository.updateConfig(OWNER_ID, "review-1", config)).toThrow(
      /forced annotation delete failure/,
    );
    sqlite.exec("DROP TRIGGER reject_annotation_delete");

    const unchanged = repository.getById(OWNER_ID, "review-1");
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
    repository.create(OWNER_ID, { id: "review-1", config });
    sqlite.prepare(`update reviews set ${field} = ? where id = ?`).run(
      value,
      "review-1",
    );

    expect(() => repository.getById(OWNER_ID, "review-1")).toThrow(
      new RegExp(`corrupt.*${field}`, "i"),
    );
  });

  it.each(["config", "report"])(
    "读取语法损坏的 %s JSON 时指明字段",
    (field) => {
      repository.create(OWNER_ID, { id: "review-1", config });
      sqlite.prepare(`update reviews set ${field} = ? where id = ?`).run(
        "{not-json",
        "review-1",
      );

      expect(() => repository.getById(OWNER_ID, "review-1")).toThrow(
        new RegExp(`corrupt.*${field}`, "i"),
      );
    },
  );

  it("配置更新在事务内清理 falsy 损坏报告", () => {
    repository.create(OWNER_ID, { id: "review-1", config: customConfig });
    sqlite.prepare("update reviews set report = 'false' where id = ?").run(
      "review-1",
    );

    const updated = repository.updateConfig(OWNER_ID, "review-1", config);

    expect(updated.report).toBeNull();
    expect(updated.status).toBe("draft");
  });

  it("原子替换一篇作文的全部批注", () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    repository.replaceAnnotations(OWNER_ID, "review-1", [annotation, { ...annotation, x: 0.8 }]);
    repository.replaceAnnotations(OWNER_ID, "review-1", [
      { ...annotation, category: "highlight", isHighlight: true },
    ]);

    expect(repository.getById(OWNER_ID, "review-1")?.annotations).toEqual([
      { ...annotation, category: "highlight", isHighlight: true },
    ]);
  });

  it("替换图片会清理旧分析并回到 draft", () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    repository.updateReport(OWNER_ID, "review-1", report);
    repository.replaceAnnotations(OWNER_ID, "review-1", [annotation]);
    repository.updateStatus(OWNER_ID, "review-1", "ready_for_review");

    const updated = repository.replaceImages(
      OWNER_ID,
      "review-1",
      repository.getById(OWNER_ID, "review-1")!.revision,
      [],
    );

    expect(updated).toMatchObject({ status: "draft", report: null, annotations: [] });
  });

  it("原子保存可辨认或不可辨认的 AI 分析结果", () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    const firstRun = repository.beginAnalysis(OWNER_ID, "review-1", "run-1", 0);
    const ready = repository.saveAnalysis(OWNER_ID, "review-1", firstRun, {
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

    const secondRun = repository.beginAnalysis(
      OWNER_ID,
      "review-1",
      "run-2",
      ready.revision,
    );
    const unreadable = repository.saveAnalysis(OWNER_ID, "review-1", secondRun, {
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

  it("导出 PDF 原子绑定内容 revision 并将状态置为 exported", () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    const ready = repository.updateReport(OWNER_ID, "review-1", report);

    const exported = repository.markExported(OWNER_ID, "review-1", ready.revision, {
      pdfFilename: "作文批改-为自己喝彩-20260721-1405.pdf",
      pdfPath: "pdf/作文批改-为自己喝彩-20260721-1405.pdf",
      exportedAt: new Date("2026-07-21T06:05:00.000Z"),
    });

    expect(exported).toMatchObject({
      status: "exported",
      revision: ready.revision + 1,
      pdfRevision: ready.revision + 1,
      pdfFilename: "作文批改-为自己喝彩-20260721-1405.pdf",
      pdfPath: "pdf/作文批改-为自己喝彩-20260721-1405.pdf",
      exportedAt: new Date("2026-07-21T06:05:00.000Z"),
    });
  });

  it("报告或批注改动会递增 revision、清理 PDF 元数据并回到待复核", () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    const ready = repository.updateReport(OWNER_ID, "review-1", report);
    const exported = repository.markExported(OWNER_ID, "review-1", ready.revision, {
      pdfFilename: "old.pdf",
      pdfPath: "pdf/old.pdf",
      exportedAt: new Date("2026-07-21T06:05:00.000Z"),
    });

    const annotationChanged = repository.replaceAnnotations(OWNER_ID, "review-1", [annotation]);
    expect(annotationChanged).toEqual([annotation]);
    const afterAnnotations = repository.getById(OWNER_ID, "review-1");
    expect(afterAnnotations).toMatchObject({
      status: "ready_for_review",
      revision: exported.revision + 1,
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
    });

    const reExported = repository.markExported(OWNER_ID, "review-1", afterAnnotations!.revision, {
      pdfFilename: "second.pdf",
      pdfPath: "pdf/second.pdf",
      exportedAt: new Date("2026-07-21T06:06:00.000Z"),
    });
    const reportChanged = repository.updateReport(OWNER_ID, "review-1", {
      ...report,
      personalizedComment: "新总评",
    });
    expect(reportChanged).toMatchObject({
      status: "ready_for_review",
      revision: reExported.revision + 1,
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
    });
  });

  it("配置或图片改动清理 PDF 元数据并回到 draft", () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    const ready = repository.updateReport(OWNER_ID, "review-1", report);
    const exported = repository.markExported(OWNER_ID, "review-1", ready.revision, {
      pdfFilename: "old.pdf",
      pdfPath: "pdf/old.pdf",
      exportedAt: new Date("2026-07-21T06:05:00.000Z"),
    });

    const configChanged = repository.updateConfig(OWNER_ID, "review-1", {
      ...config,
      title: "新题目",
    });
    expect(configChanged).toMatchObject({
      status: "draft",
      revision: exported.revision + 1,
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
    });

    repository.updateReport(OWNER_ID, "review-1", report);
    const secondExport = repository.markExported(
      OWNER_ID,
      "review-1",
      repository.getById(OWNER_ID, "review-1")!.revision,
      {
        pdfFilename: "second.pdf",
        pdfPath: "pdf/second.pdf",
        exportedAt: new Date("2026-07-21T06:06:00.000Z"),
      },
    );
    const imagesChanged = repository.replaceImages(
      OWNER_ID,
      "review-1",
      secondExport.revision,
      [],
    );
    expect(imagesChanged).toMatchObject({
      status: "draft",
      revision: secondExport.revision + 1,
      pdfFilename: null,
      pdfPath: null,
      pdfRevision: null,
      exportedAt: null,
    });
  });

  it("第二次分析用新 runId 使第一次结果失效", () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    const first = repository.beginAnalysis(OWNER_ID, "review-1", "run-first", 0);
    const second = repository.beginAnalysis(OWNER_ID, "review-1", "run-second", 0);

    expect(() =>
      repository.saveAnalysis(OWNER_ID, "review-1", first, {
        readable: true,
        pageWarnings: [],
        report,
        annotations: [],
      }),
    ).toThrow(expect.objectContaining({ code: "ANALYSIS_CONFLICT", status: 409 }));
    expect(repository.getById(OWNER_ID, "review-1")).toMatchObject({
      status: "analyzing",
      analysisRunId: "run-second",
    });
    expect(
      repository.saveAnalysis(OWNER_ID, "review-1", second, {
        readable: true,
        pageWarnings: [],
        report,
        annotations: [],
      }),
    ).toMatchObject({ status: "ready_for_review", analysisRunId: null });
  });

  it("配置变化递增 revision 并使在途分析无法保存或标记失败", () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    const run = repository.beginAnalysis(OWNER_ID, "review-1", "run-old", 0);

    const changed = repository.updateTeacherEdits(OWNER_ID, "review-1", {
      expectedRevision: 0,
      config: { ...config, title: "新题目" },
    });

    expect(changed).toMatchObject({
      revision: 1,
      analysisRunId: null,
      status: "draft",
    });
    expect(repository.failAnalysis(OWNER_ID, "review-1", run)).toBe(false);
    expect(() =>
      repository.saveAnalysis(OWNER_ID, "review-1", run, {
        readable: true,
        pageWarnings: [],
        report,
        annotations: [],
      }),
    ).toThrow(expect.objectContaining({ code: "ANALYSIS_CONFLICT" }));
    expect(repository.getById(OWNER_ID, "review-1")?.status).toBe("draft");
  });

  it("图片变化递增 revision、清理 runId 并回到 draft", () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    repository.beginAnalysis(OWNER_ID, "review-1", "run-old", 0);

    const changed = repository.replaceImages(OWNER_ID, "review-1", 0, []);

    expect(changed).toMatchObject({
      revision: 1,
      analysisRunId: null,
      status: "draft",
    });
  });

  it("旧 revision 替换图片返回 409 且保留当前图片", () => {
    repository.create(OWNER_ID, {
      id: "review-1",
      config,
      images: [{
        position: 0,
        originalName: "current.jpg",
        mimeType: "image/jpeg",
        originalPath: "images/current-original.jpg",
        annotationPath: "images/current-annotation.jpg",
        aiPath: "images/current-ai.jpg",
        width: 100,
        height: 100,
        rotation: 0,
        crop: null,
      }],
    });
    repository.updateTeacherEdits(OWNER_ID, "review-1", {
      expectedRevision: 0,
      config: { ...config, title: "另一标签页已更新" },
    });

    expect(() => repository.replaceImages(OWNER_ID, "review-1", 0, [])).toThrow(
      expect.objectContaining({ code: "REVISION_CONFLICT", status: 409 }),
    );
    expect(repository.getById(OWNER_ID, "review-1")).toMatchObject({
      revision: 1,
      images: [{ originalName: "current.jpg" }],
    });
  });

  it("教师编辑 report/annotations 原子提交并由仓储置为 ready", () => {
    repository.create(OWNER_ID, { id: "review-1", config });
    sqlite.exec(`
      CREATE TRIGGER reject_teacher_annotation
      BEFORE INSERT ON annotations
      BEGIN
        SELECT RAISE(ABORT, 'forced teacher edit failure');
      END;
    `);

    expect(() =>
      repository.updateTeacherEdits(OWNER_ID, "review-1", {
        expectedRevision: 0,
        config: { ...config, title: "不应半保存" },
        report,
        annotations: [annotation],
      }),
    ).toThrow(/forced teacher edit failure/);
    expect(repository.getById(OWNER_ID, "review-1")).toMatchObject({
      status: "draft",
      report: null,
      config,
      annotations: [],
    });

    sqlite.exec("DROP TRIGGER reject_teacher_annotation");
    expect(
      repository.updateTeacherEdits(OWNER_ID, "review-1", {
        expectedRevision: 0,
        report,
        annotations: [annotation],
      }),
    ).toMatchObject({ status: "ready_for_review", report });
  });

  it("删除 review 并级联删除图片和批注记录", () => {
    repository.create(OWNER_ID, {
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
    repository.replaceAnnotations(OWNER_ID, "review-1", [annotation]);

    expect(repository.delete(OWNER_ID, "review-1")).toBe(true);
    expect(repository.getById(OWNER_ID, "review-1")).toBeNull();
    expect(
      sqlite.prepare("select count(*) as count from review_images").get(),
    ).toEqual({ count: 0 });
    expect(
      sqlite.prepare("select count(*) as count from annotations").get(),
    ).toEqual({ count: 0 });
    expect(() => repository.delete(OWNER_ID, "missing")).toThrow(
      /Review not found/,
    );
  });
});
