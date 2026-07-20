// @vitest-environment node

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  Annotation,
  AssignmentConfig,
  EvaluationReport,
} from "../domain/contracts";
import { initializeSchema } from "./init";
import { ReviewRepository } from "./review-repository";
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
        { pageIndex: 0, path: "images/page-1.jpg" },
        { pageIndex: 1, path: "images/page-2.jpg" },
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
    expect(saved?.images.map(({ pageIndex, path }) => ({ pageIndex, path }))).toEqual(
      [
        { pageIndex: 0, path: "images/page-1.jpg" },
        { pageIndex: 1, path: "images/page-2.jpg" },
      ],
    );
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

  it("删除 review 并级联删除图片和批注记录", () => {
    repository.create({
      id: "review-1",
      config,
      images: [{ pageIndex: 0, path: "images/page-1.jpg" }],
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
