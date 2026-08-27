import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

import type { ParagraphEvaluationReport } from "@/src/domain/contracts";
import type { ReviewView } from "./types";

const exportMocks = vi.hoisted(() => ({
  events: [] as string[],
  createPdf: vi.fn(),
  createDocx: vi.fn(),
  buildDelivery: vi.fn(),
  paginate: vi.fn(),
  triggerDownload: vi.fn(),
  markExported: vi.fn(),
}));

vi.mock("./pdf-download", () => ({
  createReviewPdf: exportMocks.createPdf,
  triggerFileDownload: exportMocks.triggerDownload,
  markReviewExported: exportMocks.markExported,
}));

vi.mock("./docx-download", () => ({
  createReviewDocx: exportMocks.createDocx,
}));

vi.mock("./delivery-document", () => ({
  buildDeliveryDocument: exportMocks.buildDelivery,
}));

vi.mock("./delivery-pagination", () => ({
  paginateDeliveryDocument: exportMocks.paginate,
}));

import {
  archiveFilename,
  downloadLegacyCachedPdf,
  downloadReview,
  downloadReviewArchive,
  reviewFilename,
} from "./review-export";

const paragraphReport: ParagraphEvaluationReport = {
  version: 2 as const,
  themeFit: "fits" as const,
  themeReason: "切题",
  personalizedComment: "细节真实",
  painPoints: [],
  commonIssues: [],
  revisionSuggestions: [],
  grade: "A-" as const,
  diagnostics: {
    authenticityAndRelevance: { finding: "真实", action: "保留" },
    materialAndDetails: { finding: "具体", action: "保留" },
    structure: { finding: "完整", action: "保留" },
    language: { finding: "通顺", action: "保留" },
  },
  paragraphReviews: [{
    paragraphId: "paragraph-1",
    suggestions: [{ problem: "保留", advice: "保留动作", example: "我攥紧了稿纸。" }],
    revisedText: "我攥紧了稿纸。",
  }],
  parentFeedbacks: [],
};

function review(id: string, revision: number, title = "我终于明白了", studentName = "唐敦林"): ReviewView {
  return {
    id,
    status: "ready_for_review",
    studentName,
    config: {
      title,
      grade: "六年级",
      writingRequirements: "叙事",
      targetCharacters: 600,
      structureRequirements: "结构完整",
      scoringFocus: "细节",
      templateType: "custom",
    },
    report: paragraphReport,
    revision,
    createdAt: "2026-08-22T01:00:00.000Z",
    updatedAt: "2026-08-22T02:00:00.000Z",
    teacherReviewedAt: "2026-08-22T03:00:00.000Z",
    images: [{
      id: revision,
      position: 0,
      originalName: "作文.jpg",
      mimeType: "image/jpeg",
      width: 1200,
      height: 1600,
      rotation: 0,
      crop: null,
    }],
    annotations: [],
    ocr: {
      version: 2,
      ocrRevision: 1,
      editedAt: null,
      pages: [{ pageIndex: 0, text: "我攥紧了稿纸。", readable: true, warnings: [] }],
      paragraphs: [{
        id: "paragraph-1",
        paragraphIndex: 0,
        text: "我攥紧了稿纸。",
        segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.6, height: 0.12 }],
      }],
    },
    reportStale: false,
    hasPdf: false,
    pdfFilename: null,
  };
}

function legacyReview(overrides: Partial<ReviewView> = {}): ReviewView {
  return {
    ...review("legacy-1", 2),
    report: {
      themeFit: "fits",
      themeReason: "切题",
      personalizedComment: "真实",
      painPoints: [],
      commonIssues: [],
      revisionSuggestions: [],
      scores: {
        themeIntent: 8,
        contentSelection: 8,
        structure: 8,
        languageExpression: 8,
        writingConventions: 4,
        total: 36,
        level: "优秀作文",
      },
      sampleParagraphs: [{ title: "示范段", text: "示范正文", suggestion: "修改建议" }],
      parentFeedbacks: [],
    },
    hasPdf: true,
    pdfFilename: "旧版批改.pdf",
    ...overrides,
  };
}

function apiResponse(data: unknown) {
  return new Response(JSON.stringify({ ok: true, data }), {
    headers: { "content-type": "application/json" },
  });
}

function mockNewExportApi(reviews: ReviewView[]) {
  const byId = new Map(reviews.map((item) => [item.id, item]));
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    exportMocks.events.push(`fetch:${url}`);
    const detailMatch = /^\/api\/reviews\/([^/]+)$/u.exec(url);
    if (detailMatch && (!init?.method || init.method === "GET")) {
      return apiResponse(byId.get(decodeURIComponent(detailMatch[1])));
    }
    if (url === "/api/reviews/export-check" && init?.method === "POST") {
      return apiResponse({ exportable: true });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

describe("双格式导出编排", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    exportMocks.events.length = 0;
    exportMocks.createPdf.mockResolvedValue(new Blob(["pdf"], { type: "application/pdf" }));
    exportMocks.createDocx.mockResolvedValue(new Blob(["docx"]));
    exportMocks.buildDelivery.mockImplementation(async (item: ReviewView) => ({
      title: item.config.title,
      studentName: item.studentName,
      paragraphs: [],
    }));
    exportMocks.paginate.mockReturnValue([]);
    exportMocks.triggerDownload.mockImplementation((_blob: Blob, filename: string) => {
      exportMocks.events.push(`download:${filename}`);
    });
    exportMocks.markExported.mockImplementation(async (id: string) => {
      exportMocks.events.push(`marked:${id}`);
    });
  });

  it("生成安全且稳定的单篇与批量文件名", () => {
    const item = review("review-1", 3);

    expect(reviewFilename(item, "docx")).toBe("作文批改-我终于明白了-唐敦林.docx");
    expect(reviewFilename({ ...item, studentName: "", config: { ...item.config, title: "A/B:*?" } }, "pdf"))
      .toBe("作文批改-A B-未填写学生姓名.pdf");
    expect(archiveFilename("pdf")).toBe("作文批改批量导出-PDF.zip");
    expect(archiveFilename("docx")).toBe("作文批改批量导出-Word.zip");
  });

  it.each(["pdf", "docx"] as const)("先校验再生成并下载 %s，最后标记已导出", async (format) => {
    const item = review("review-1", 3);
    mockNewExportApi([item]);
    exportMocks.createPdf.mockImplementation(async () => {
      exportMocks.events.push("render:pdf");
      return new Blob(["pdf"], { type: "application/pdf" });
    });
    exportMocks.buildDelivery.mockImplementation(async () => {
      exportMocks.events.push("build:delivery");
      return { title: item.config.title, studentName: item.studentName, paragraphs: [] };
    });
    exportMocks.createDocx.mockImplementation(async () => {
      exportMocks.events.push("render:docx");
      return new Blob(["docx"]);
    });

    const filename = await downloadReview(item.id, format);

    expect(filename).toBe(reviewFilename(item, format));
    expect(exportMocks.events).toEqual(format === "pdf" ? [
      "fetch:/api/reviews/review-1",
      "fetch:/api/reviews/export-check",
      "render:pdf",
      `download:${reviewFilename(item, format)}`,
      "marked:review-1",
    ] : [
      "fetch:/api/reviews/review-1",
      "fetch:/api/reviews/export-check",
      "build:delivery",
      "render:docx",
      `download:${reviewFilename(item, format)}`,
      "marked:review-1",
    ]);
    if (format === "docx") {
      expect(exportMocks.paginate).toHaveBeenCalledOnce();
      expect(exportMocks.createDocx).toHaveBeenCalledWith(
        expect.objectContaining({ title: item.config.title }),
        [],
      );
    }
  });

  it("批量按输入顺序构建所有文件后再下载和逐篇标记", async () => {
    const reviews = [
      review("review-2", 4, "第二篇", "乙同学"),
      review("review-1", 3, "第一篇", "甲同学"),
    ];
    mockNewExportApi(reviews);
    exportMocks.createPdf.mockImplementation(async (item: ReviewView) => {
      exportMocks.events.push(`render:${item.id}`);
      return new Blob([item.id], { type: "application/pdf" });
    });

    await downloadReviewArchive(["review-2", "review-1"], "pdf");

    expect(exportMocks.createPdf.mock.calls.map(([item]) => item.id)).toEqual(["review-2", "review-1"]);
    expect(exportMocks.events.indexOf("download:作文批改批量导出-PDF.zip"))
      .toBeGreaterThan(exportMocks.events.indexOf("render:review-1"));
    expect(exportMocks.events.slice(-3)).toEqual([
      "download:作文批改批量导出-PDF.zip",
      "marked:review-2",
      "marked:review-1",
    ]);
  });

  it("同题同名记录在 ZIP 中仍各自保留一个文件", async () => {
    const reviews = [review("review-1", 1), review("review-2", 2)];
    mockNewExportApi(reviews);

    await downloadReviewArchive(reviews.map(({ id }) => id), "pdf");

    const archiveBlob = exportMocks.triggerDownload.mock.calls[0][0] as Blob;
    const archive = await JSZip.loadAsync(await archiveBlob.arrayBuffer());
    expect(Object.keys(archive.files)).toEqual([
      "作文批改-我终于明白了-唐敦林.pdf",
      "作文批改-我终于明白了-唐敦林-2.pdf",
    ]);
  });

  it("批量第 2 篇生成失败时不下载且不标记任何记录", async () => {
    const reviews = [review("review-1", 1), review("review-2", 2), review("review-3", 3)];
    mockNewExportApi(reviews);
    exportMocks.createPdf.mockImplementation(async (item: ReviewView) => {
      if (item.id === "review-2") throw new Error("第 2 篇裁图失败");
      return new Blob([item.id]);
    });

    await expect(downloadReviewArchive(reviews.map(({ id }) => id), "pdf"))
      .rejects.toThrow("第 2 篇裁图失败");

    expect(exportMocks.createPdf.mock.calls.map(([item]) => item.id)).toEqual(["review-1", "review-2"]);
    expect(exportMocks.triggerDownload).not.toHaveBeenCalled();
    expect(exportMocks.markExported).not.toHaveBeenCalled();
  });

  it("ZIP 生成失败时不下载且不标记任何记录", async () => {
    const reviews = [review("review-1", 1), review("review-2", 2)];
    mockNewExportApi(reviews);
    vi.spyOn(JSZip.prototype, "generateAsync").mockRejectedValueOnce(new Error("ZIP 生成失败"));

    await expect(downloadReviewArchive(reviews.map(({ id }) => id), "pdf"))
      .rejects.toThrow("ZIP 生成失败");

    expect(exportMocks.createPdf).toHaveBeenCalledTimes(2);
    expect(exportMocks.triggerDownload).not.toHaveBeenCalled();
    expect(exportMocks.markExported).not.toHaveBeenCalled();
  });

  it("下载触发失败时不标记记录", async () => {
    const item = review("review-1", 1);
    mockNewExportApi([item]);
    exportMocks.triggerDownload.mockImplementation(() => {
      throw new Error("浏览器阻止下载");
    });

    await expect(downloadReview(item.id, "pdf")).rejects.toThrow("浏览器阻止下载");
    expect(exportMocks.markExported).not.toHaveBeenCalled();
  });

  it("把内存分配失败转换为可执行的批量提示", async () => {
    const item = review("review-1", 1);
    mockNewExportApi([item]);
    exportMocks.createPdf.mockRejectedValue(new RangeError("Array buffer allocation failed"));

    await expect(downloadReview(item.id, "pdf"))
      .rejects.toThrow("生成文件时内存不足，请减少单次批量数量后重试");
    expect(exportMocks.triggerDownload).not.toHaveBeenCalled();
    expect(exportMocks.markExported).not.toHaveBeenCalled();
  });

  it("识别浏览器的 typed array 内存错误", async () => {
    const item = review("review-1", 1);
    mockNewExportApi([item]);
    exportMocks.createPdf.mockRejectedValue(new RangeError("Invalid typed array length"));

    await expect(downloadReview(item.id, "pdf"))
      .rejects.toThrow("生成文件时内存不足，请减少单次批量数量后重试");
  });

  it("旧版缓存 PDF 只下载服务端字节与 RFC5987 文件名", async () => {
    const item = legacyReview();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("legacy-pdf", {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": "attachment; filename=\"composition-review.pdf\"; filename*=UTF-8''%E4%BD%9C%E6%96%87%E6%89%B9%E6%94%B9-%E6%97%A7%E7%89%88.pdf",
      },
    }));

    const filename = await downloadLegacyCachedPdf(item);

    expect(filename).toBe("作文批改-旧版.pdf");
    expect(fetchMock).toHaveBeenCalledWith("/api/reviews/legacy-1/pdf");
    expect(exportMocks.triggerDownload).toHaveBeenCalledWith(expect.any(Blob), "作文批改-旧版.pdf");
    expect(exportMocks.createPdf).not.toHaveBeenCalled();
    expect(exportMocks.createDocx).not.toHaveBeenCalled();
    expect(exportMocks.markExported).not.toHaveBeenCalled();
  });

  it.each([
    { report: paragraphReport, hasPdf: true, pdfFilename: "缓存.pdf" },
    { report: legacyReview().report, hasPdf: false, pdfFilename: "缓存.pdf" },
    { report: legacyReview().report, hasPdf: true, pdfFilename: "   " },
  ])("拒绝不满足旧版缓存条件的记录 %#", async (overrides) => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(downloadLegacyCachedPdf(legacyReview(overrides as Partial<ReviewView>)))
      .rejects.toThrow("没有可下载的旧版 PDF");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
