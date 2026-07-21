// @vitest-environment node

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  annotationSchema,
  type AssignmentConfig,
  type EvaluationReport,
} from "../domain/contracts";
import { initializeSchema } from "../db/init";
import {
  ReviewNotFoundError,
  ReviewRepository,
} from "../db/review-repository";
import * as schema from "../db/schema";

const ownerA = "teacher-01";
const ownerB = "teacher-02";
const admin = "local-admin";

const config: AssignmentConfig = {
  title: "为自己鼓掌",
  grade: "上海五四学制六年级",
  writingRequirements: "写一件亲身经历的事。",
  targetCharacters: 600,
  structureRequirements: "五段展开。",
  scoringFocus: "细节描写。",
  templateType: "custom",
};

const report: EvaluationReport = {
  themeFit: "fits",
  themeReason: "紧扣主题。",
  personalizedComment: "细节真实。",
  painPoints: [],
  commonIssues: [],
  revisionSuggestions: [],
  scores: {
    themeIntent: 9,
    contentSelection: 9,
    structure: 7,
    languageExpression: 7,
    writingConventions: 4,
    total: 36,
    level: "优秀作文",
  },
  sampleParagraphs: [{ title: "示范段", text: "我为自己鼓掌。", suggestion: "补充细节。" }],
};

function addTeacher(sqlite: Database.Database, id: string): void {
  sqlite
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, 'teacher', 0, 1, 1)`,
    )
    .run(id, id, "!test");
}

describe("作文租户隔离", () => {
  let sqlite: Database.Database;
  let repository: ReviewRepository;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    initializeSchema(sqlite);
    addTeacher(sqlite, ownerA);
    addTeacher(sqlite, ownerB);
    repository = new ReviewRepository(drizzle(sqlite, { schema }));
    repository.create(ownerA, { id: "review-owned-by-a", config });
  });

  afterEach(() => sqlite.close());

  it("列表和读取均只返回当前 owner 的作文", () => {
    expect(repository.list(ownerA).map((review) => review.id)).toEqual([
      "review-owned-by-a",
    ]);
    expect(repository.list(ownerB)).toEqual([]);
    expect(repository.getById(ownerB, "review-owned-by-a")).toBeNull();
    expect(repository.getById(admin, "review-owned-by-a")).toBeNull();
    expect(repository.getById(ownerA, "review-owned-by-a")?.ownerId).toBe(ownerA);
  });

  it("跨教师更新、删除、保存报告统一返回 NOT_FOUND", () => {
    expect(() =>
      repository.updateTeacherEdits(ownerB, "review-owned-by-a", {
        expectedRevision: 0,
        config: { ...config, title: "越权修改" },
      }),
    ).toThrow(ReviewNotFoundError);
    expect(() => repository.updateReport(ownerB, "review-owned-by-a", report)).toThrow(
      ReviewNotFoundError,
    );
    expect(() => repository.delete(ownerB, "review-owned-by-a")).toThrow(
      ReviewNotFoundError,
    );
    expect(repository.getById(ownerA, "review-owned-by-a")?.config.title).toBe(
      "为自己鼓掌",
    );
  });

  it("猜测图片 id、分析 token 和管理员身份不会绕过 owner 条件", () => {
    const image = {
      position: 0,
      originalName: "作文.jpg",
      mimeType: "image/jpeg",
      originalPath: "images/original.jpg",
      annotationPath: "images/annotation.jpg",
      aiPath: "images/ai.jpg",
      width: 100,
      height: 100,
      rotation: 0 as const,
      crop: null,
    };
    const withImage = repository.create(ownerA, {
      id: "review-with-image",
      config,
      images: [image],
    });
    expect(repository.getById(ownerB, withImage.id)).toBeNull();

    const run = repository.beginAnalysis(ownerA, withImage.id, "run-a", 0);
    expect(() => repository.saveAnalysis(ownerB, withImage.id, run, {
      readable: false,
      pageWarnings: ["看不清"],
      annotations: [],
    })).toThrow(ReviewNotFoundError);
    expect(() => repository.failAnalysis(ownerB, withImage.id, run)).not.toThrow();
    expect(repository.failAnalysis(ownerB, withImage.id, run)).toBe(false);
    expect(repository.getById(admin, withImage.id)).toBeNull();
    expect(annotationSchema.parse({
      pageIndex: 0,
      x: 0.1,
      y: 0.1,
      category: "highlight",
      anchorText: "",
      comment: "亮点",
      isHighlight: true,
    }).isHighlight).toBe(true);
  });

  it("删除中的作文对 owner 也不可见", () => {
    sqlite
      .prepare("UPDATE reviews SET deleting_at = ? WHERE id = ?")
      .run(Date.now(), "review-owned-by-a");
    expect(repository.list(ownerA)).toEqual([]);
    expect(repository.getById(ownerA, "review-owned-by-a")).toBeNull();
    expect(() => repository.delete(ownerA, "review-owned-by-a")).toThrow(
      ReviewNotFoundError,
    );
  });
});
