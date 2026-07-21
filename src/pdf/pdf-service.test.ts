// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { ReviewRecord } from "../db/review-repository";
import {
  PdfService,
  PdfServiceError,
  type BrowserFactory,
} from "./pdf-service";

function review(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    id: "review-1",
    status: "ready_for_review",
    revision: 7,
    analysisRunId: null,
    pdfFilename: null,
    pdfPath: null,
    pdfRevision: null,
    exportedAt: null,
    config: {
      title: "为/自己:\u0000鼓掌?",
      grade: "六年级",
      writingRequirements: "叙事",
      targetCharacters: 600,
      structureRequirements: "完整",
      scoringFocus: "细节",
      templateType: "custom",
    },
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
        structure: 7,
        languageExpression: 7,
        writingConventions: 3,
        total: 33,
        level: "二类作文",
      },
      sampleParagraphs: [{ title: "示范", text: "正文", suggestion: "建议" }],
    },
    createdAt: new Date("2026-07-20T00:00:00.000Z"),
    updatedAt: new Date("2026-07-20T01:00:00.000Z"),
    images: [
      {
        id: 1,
        reviewId: "review-1",
        position: 0,
        originalName: "page.jpg",
        mimeType: "image/jpeg",
        originalPath: "images/original.jpg",
        annotationPath: "images/annotation.jpg",
        aiPath: "images/ai.jpg",
        width: 1200,
        height: 1600,
        rotation: 0,
        crop: null,
        createdAt: new Date("2026-07-20T00:00:00.000Z"),
      },
    ],
    annotations: [],
    ...overrides,
  };
}

function harness(options: {
  current?: ReviewRecord;
  pdfFailure?: Error;
  launchFailure?: Error;
} = {}) {
  const current = options.current ?? review();
  const page = {
    goto: vi.fn().mockResolvedValue(null),
    waitForSelector: vi.fn().mockResolvedValue({}),
    waitForFunction: vi.fn().mockResolvedValue({}),
    emulateMedia: vi.fn().mockResolvedValue(undefined),
    pdf: options.pdfFailure
      ? vi.fn().mockRejectedValue(options.pdfFailure)
      : vi.fn().mockResolvedValue(Buffer.from("generated-pdf")),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const browser = {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const browserFactory: BrowserFactory = {
    launch: options.launchFailure
      ? vi.fn().mockRejectedValue(options.launchFailure)
      : vi.fn().mockResolvedValue(browser),
  };
  const exported = review({
    status: "exported",
    revision: current.revision + 1,
    pdfRevision: current.revision + 1,
  });
  const repository = {
    getById: vi.fn().mockReturnValue(current),
    markExported: vi.fn().mockReturnValue(exported),
  };
  const fileStore = {
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue("/private/reviews/review-1/pdf/generated.pdf"),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    queuePdfCleanup: vi.fn().mockResolvedValue(undefined),
  };
  const service = new PdfService(repository, fileStore, browserFactory, {
    now: () => new Date("2026-07-21T06:05:00.000Z"),
    timeZone: "Asia/Shanghai",
  });
  return { service, repository, fileStore, browserFactory, browser, page };
}

describe("PdfService", () => {
  it("用当前 origin 打开打印页，等待内容和图片后按 A4 参数生成并持久化", async () => {
    const { service, repository, fileStore, browserFactory, page, browser } = harness();

    const result = await service.getOrCreate("review-1", "http://127.0.0.1:3000");

    expect(browserFactory.launch).toHaveBeenCalledWith({ headless: true });
    expect(page.goto).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/print/reviews/review-1",
      { waitUntil: "networkidle", timeout: 60_000 },
    );
    expect(page.waitForSelector).toHaveBeenCalledWith(
      '[data-print-ready="true"]',
      { timeout: 60_000 },
    );
    expect(page.waitForFunction).toHaveBeenCalledWith(
      expect.any(Function),
      undefined,
      { timeout: 60_000 },
    );
    expect(page.emulateMedia).toHaveBeenCalledWith({ media: "print" });
    expect(page.pdf).toHaveBeenCalledWith({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      tagged: true,
    });
    expect(result.data).toEqual(Buffer.from("generated-pdf"));
    expect(result.filename).toBe("作文批改-为-自己-鼓掌-20260721-1405.pdf");
    expect(fileStore.writeFile).toHaveBeenCalledWith(
      "review-1",
      "pdf",
      result.filename,
      Buffer.from("generated-pdf"),
    );
    expect(repository.markExported).toHaveBeenCalledWith("review-1", 7, {
      pdfFilename: result.filename,
      pdfPath: `pdf/${result.filename}`,
      exportedAt: new Date("2026-07-21T06:05:00.000Z"),
    });
    expect(page.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("当 PDF revision 与 review revision 相同时直接读取缓存", async () => {
    const cached = review({
      status: "exported",
      revision: 8,
      pdfRevision: 8,
      pdfFilename: "cached.pdf",
      pdfPath: "pdf/cached.pdf",
      exportedAt: new Date("2026-07-21T06:00:00.000Z"),
    });
    const { service, fileStore, browserFactory, repository } = harness({ current: cached });
    fileStore.readFile.mockResolvedValue(Buffer.from("cached-pdf"));

    const result = await service.getOrCreate("review-1", "http://localhost:3000");

    expect(result).toMatchObject({ filename: "cached.pdf", cached: true });
    expect(result.data).toEqual(Buffer.from("cached-pdf"));
    expect(browserFactory.launch).not.toHaveBeenCalled();
    expect(repository.markExported).not.toHaveBeenCalled();
  });

  it("旧 PDF revision 不同时重新生成并清理旧文件", async () => {
    const stale = review({
      revision: 9,
      pdfRevision: 8,
      pdfFilename: "stale.pdf",
      pdfPath: "pdf/stale.pdf",
      exportedAt: new Date("2026-07-21T06:00:00.000Z"),
    });
    const { service, browserFactory, fileStore } = harness({ current: stale });

    const result = await service.getOrCreate("review-1", "http://localhost:3000");

    expect(result.cached).toBe(false);
    expect(browserFactory.launch).toHaveBeenCalledOnce();
    expect(fileStore.queuePdfCleanup).toHaveBeenCalledWith("review-1", ["stale.pdf"]);
  });

  it("无报告或无图片时返回 422 业务错误且不启动浏览器", async () => {
    for (const current of [review({ report: null }), review({ images: [] })]) {
      const { service, browserFactory } = harness({ current });

      await expect(
        service.getOrCreate("review-1", "http://localhost:3000"),
      ).rejects.toMatchObject({
        code: "PDF_CONTENT_INCOMPLETE",
        status: 422,
      });
      expect(browserFactory.launch).not.toHaveBeenCalled();
    }
  });

  it("生成失败时 finally 关闭 page 和 browser 且不持久化", async () => {
    const { service, page, browser, repository, fileStore } = harness({
      pdfFailure: new Error("render failed"),
    });

    await expect(
      service.getOrCreate("review-1", "http://localhost:3000"),
    ).rejects.toThrow("render failed");
    expect(page.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(fileStore.writeFile).not.toHaveBeenCalled();
    expect(repository.markExported).not.toHaveBeenCalled();
  });

  it("浏览器内核未安装时转为不泄露路径的 503 错误", async () => {
    const { service } = harness({
      launchFailure: new Error(
        "browserType.launch: Executable doesn't exist at /Users/private/chromium",
      ),
    });

    try {
      await service.getOrCreate("review-1", "http://localhost:3000");
      throw new Error("expected PDF engine failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfServiceError);
      expect(error).toMatchObject({ code: "PDF_ENGINE_MISSING", status: 503 });
      expect((error as Error).message).toContain("playwright install chromium");
      expect((error as Error).message).not.toContain("/Users/private");
    }
  });
});
