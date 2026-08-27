import { describe, expect, it, vi } from "vitest";

import type { ParagraphEvaluationReport } from "../domain/contracts";
import type { OcrCheckpoint, OcrCheckpointV2, OcrPage } from "../ocr/contracts";
import {
  CloudAnalysisConflictError,
  CloudAnalysisPipeline,
  type CloudAnalysisPipelineDependencies,
  type CloudAnalysisPipelineJob,
} from "./cloud-analysis-pipeline";

const pages: OcrPage[] = [{
  pageIndex: 0,
  text: "我终于明白了。",
  readable: true,
  warnings: [],
  blocks: [{ text: "我终于明白了。", x: 0.2, y: 0.3, width: 0.4, height: 0.1 }],
}];

const paragraphs = [{
  paragraphIndex: 0,
  text: "我终于明白了。",
  segments: [{
    pageIndex: 0,
    text: "我终于明白了。",
    x: 0.2,
    y: 0.3,
    width: 0.4,
    height: 0.1,
  }],
}];

const v1Checkpoint: OcrCheckpoint = {
  version: 1,
  sourceRevision: 3,
  ocrRevision: 0,
  editedAt: null,
  pages,
};

const recognizedCheckpoint: OcrCheckpointV2 = {
  version: 2 as const,
  sourceRevision: 3,
  ocrRevision: 0,
  editedAt: null,
  pages,
  paragraphs: paragraphs.map((paragraph, index) => ({
    ...paragraph,
    id: `paragraph-${index + 1}`,
  })),
};

const report: ParagraphEvaluationReport = {
  version: 2,
  themeFit: "fits",
  themeReason: "中心明确",
  personalizedComment: "细节真实。",
  painPoints: ["结尾略快。"],
  commonIssues: [],
  revisionSuggestions: [],
  grade: "A-",
  diagnostics: {
    authenticityAndRelevance: { finding: "紧扣主题。", action: "保留事件。" },
    materialAndDetails: { finding: "细节真实。", action: "补写心理。" },
    structure: { finding: "结构完整。", action: "强化结尾。" },
    language: { finding: "表达自然。", action: "精简长句。" },
  },
  paragraphReviews: [{
    paragraphId: "paragraph-1",
    suggestions: [{ problem: "保留", advice: "保留点题。", example: "我终于明白了。" }],
    revisedText: "我终于明白了。",
  }],
  parentFeedbacks: [],
};

const job: CloudAnalysisPipelineJob = {
  id: "job-1",
  reviewId: "review-1",
  ownerId: "owner-1",
  mode: "full",
  imageRevision: 3,
  config: {
    title: "我终于明白了",
    grade: "六年级",
    writingRequirements: "写一件事",
    targetCharacters: 600,
    structureRequirements: "结构完整",
    scoringFocus: "细节",
    templateType: "custom",
  },
  teacherGuidance: "关注结尾",
  studentName: "小明",
};

function dependencies(overrides: Partial<CloudAnalysisPipelineDependencies> = {}) {
  const calls: string[] = [];
  const result: CloudAnalysisPipelineDependencies & { calls: string[] } = {
    readCheckpoint: vi.fn(async () => null),
    loadImageUrls: vi.fn(async () => {
      calls.push("load_images");
      return ["data:image/jpeg;base64,QQ=="];
    }),
    recognize: vi.fn(async () => {
      calls.push("recognize");
      return { pages, paragraphs };
    }),
    saveRecognized: vi.fn(async () => {
      calls.push("save_ocr");
      return recognizedCheckpoint;
    }),
    analyzeText: vi.fn(async () => {
      calls.push("analyze_text");
      return {
        report,
        annotationAnchors: [{
          paragraphId: "paragraph-1",
          category: "structure" as const,
          anchorText: "我终于明白了",
          comment: "结尾有回扣",
          isHighlight: false,
        }],
      };
    }),
    updateStage: vi.fn(async (_jobId, stage) => {
      calls.push(stage);
    }),
    saveResult: vi.fn(async (_job, input) => {
      calls.push("save_result");
      expect(input.annotations).toMatchObject([{ x: 0.2, y: 0.3 }]);
    }),
    saveUnreadable: vi.fn(async () => {
      calls.push("save_unreadable");
    }),
    ...overrides,
    calls,
  };
  return result;
}

describe("CloudAnalysisPipeline", () => {
  it("完整分析先保存 OCR 检查点，再把纯文本交给内容模型", async () => {
    const deps = dependencies();

    await new CloudAnalysisPipeline(deps).run(job);

    expect(deps.calls).toEqual([
      "reading_images",
      "load_images",
      "recognize",
      "saving_ocr",
      "save_ocr",
      "generating_review",
      "analyze_text",
      "mapping_annotations",
      "validating_result",
      "saving_result",
      "save_result",
    ]);
    expect(deps.analyzeText).toHaveBeenCalledWith(expect.objectContaining({
      paragraphs: [{ id: "paragraph-1", text: "我终于明白了。" }],
    }));
    const contentInput = vi.mocked(deps.analyzeText).mock.calls[0]?.[0];
    expect(contentInput).not.toHaveProperty("pages");
    expect(JSON.stringify(contentInput)).not.toMatch(/blocks|segments|pageIndex|"x"|"y"/u);
    expect(deps.saveRecognized).toHaveBeenCalledWith(
      "owner-1",
      "review-1",
      3,
      { pages, paragraphs },
    );
    expect(JSON.stringify(vi.mocked(deps.analyzeText).mock.calls[0])).not.toContain("data:image");
  });

  it("当前 OCR v2 已存在时跳过视觉模型", async () => {
    const deps = dependencies({ readCheckpoint: vi.fn(async () => recognizedCheckpoint) });

    await new CloudAnalysisPipeline(deps).run(job);

    expect(deps.recognize).not.toHaveBeenCalled();
    expect(deps.saveRecognized).not.toHaveBeenCalled();
    expect(deps.calls[0]).toBe("generating_review");
  });

  it("已有 OCR v1 的 full 任务重新跑视觉模型升级为 v2", async () => {
    const deps = dependencies({ readCheckpoint: vi.fn(async () => v1Checkpoint) });

    await new CloudAnalysisPipeline(deps).run(job);

    expect(deps.recognize).toHaveBeenCalledOnce();
    expect(deps.saveRecognized).toHaveBeenCalledOnce();
  });

  it("内容模型失败时已保存的 OCR 不会被回滚", async () => {
    const deps = dependencies({
      analyzeText: vi.fn(async () => { throw new Error("content failed"); }),
    });

    await expect(new CloudAnalysisPipeline(deps).run(job)).rejects.toThrow("content failed");

    expect(deps.saveRecognized).toHaveBeenCalledOnce();
    expect(deps.saveResult).not.toHaveBeenCalled();
  });

  it("OCR 包含不可读页面时不调用内容模型并保存重拍状态", async () => {
    const unreadable = {
      ...recognizedCheckpoint,
      pages: [{ ...pages[0], readable: false, warnings: ["请重拍"] }],
    };
    const deps = dependencies({
      saveRecognized: vi.fn(async () => unreadable),
    });

    await new CloudAnalysisPipeline(deps).run(job);

    expect(deps.analyzeText).not.toHaveBeenCalled();
    expect(deps.saveUnreadable).toHaveBeenCalledWith(job, unreadable);
  });

  it("content_only 必须使用当前 OCR 且永不加载图片", async () => {
    const editedCheckpoint: OcrCheckpointV2 = {
      ...recognizedCheckpoint,
      ocrRevision: 2,
      editedAt: "2026-08-27T00:00:00.000Z",
      paragraphs: recognizedCheckpoint.paragraphs.map((paragraph) => ({
        ...paragraph,
        text: "老师修正后的自然段。",
      })),
    };
    const deps = dependencies({ readCheckpoint: vi.fn(async () => editedCheckpoint) });

    await new CloudAnalysisPipeline(deps).run({ ...job, mode: "content_only" });

    expect(deps.loadImageUrls).not.toHaveBeenCalled();
    expect(deps.recognize).not.toHaveBeenCalled();
    expect(deps.analyzeText).toHaveBeenCalledWith(expect.objectContaining({
      paragraphs: [{ id: "paragraph-1", text: "老师修正后的自然段。" }],
    }));
  });

  it.each([
    ["missing OCR", null],
    ["OCR v1", v1Checkpoint],
  ] satisfies Array<[string, OcrCheckpoint | null]>)
  ("content_only with %s returns OCR_V2_REQUIRED", async (_case, checkpoint) => {
    const deps = dependencies({ readCheckpoint: vi.fn(async () => checkpoint) });

    await expect(new CloudAnalysisPipeline(deps).run({ ...job, mode: "content_only" }))
      .rejects.toMatchObject({ code: "OCR_V2_REQUIRED" });
    expect(deps.loadImageUrls).not.toHaveBeenCalled();
  });

  it("图片或 OCR 版本变化时拒绝旧任务结果", async () => {
    const deps = dependencies({
      readCheckpoint: vi.fn(async () => recognizedCheckpoint),
      saveResult: vi.fn(async () => {
        throw new CloudAnalysisConflictError("ANALYSIS_CONFLICT");
      }),
    });

    await expect(new CloudAnalysisPipeline(deps).run(job))
      .rejects.toMatchObject({ code: "ANALYSIS_CONFLICT" });
  });
});
