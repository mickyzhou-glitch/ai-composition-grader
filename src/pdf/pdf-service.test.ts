// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewRecord } from "../db/review-repository";
import {
  PdfService,
  PdfServiceError,
  type BrowserFactory,
} from "./pdf-service";

const OWNER_ID = "local-admin";

const paragraphReport = {
  version: 2 as const,
  themeFit: "fits" as const,
  themeReason: "切题",
  personalizedComment: "真实",
  painPoints: [],
  commonIssues: [],
  revisionSuggestions: [],
  grade: "A-" as const,
  diagnostics: {
    authenticityAndRelevance: { finding: "真实", action: "保留" },
    materialAndDetails: { finding: "细节少", action: "补动作" },
    structure: { finding: "完整", action: "保留" },
    language: { finding: "普通", action: "改具体" },
  },
  paragraphReviews: [{
    paragraphId: "paragraph-1",
    suggestions: [{ problem: "描写普通", advice: "补充听觉", example: "我听见呼吸声。" }],
    revisedText: "我走上台。",
  }],
  parentFeedbacks: [] as [],
};

const legacyReport = {
  themeFit: "fits" as const,
  themeReason: "切题",
  personalizedComment: "真实",
  painPoints: [],
  commonIssues: [],
  revisionSuggestions: [],
  sampleParagraphs: [{ title: "示范", text: "正文", suggestion: "建议" }],
};

const ocrV2 = {
  version: 2 as const,
  ocrRevision: 3,
  editedAt: null,
  pages: [{ pageIndex: 0, text: "我走上台。", readable: true, warnings: [] }],
  paragraphs: [{
    id: "paragraph-1",
    paragraphIndex: 0,
    text: "我走上台。",
    segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
  }],
};

function review(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    id: "review-1",
    ownerId: OWNER_ID,
    status: "ready_for_review",
    studentName: "李羿辰",
    revision: 7,
    analysisRunId: null,
    pdfFilename: null,
    pdfPath: null,
    pdfRevision: null,
    exportedAt: null,
    teacherReviewedAt: new Date("2026-07-20T02:00:00.000Z"),
    config: {
      title: "为/自己:\u0000鼓掌?",
      grade: "六年级",
      writingRequirements: "叙事",
      targetCharacters: 600,
      structureRequirements: "完整",
      scoringFocus: "细节",
      templateType: "custom",
    },
    report: paragraphReport,
    reportOcrRevision: 3,
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
    ocr: ocrV2,
    ...overrides,
  };
}

function harness(options: {
  current?: ReviewRecord;
  pdfFailure?: Error;
  launchFailure?: Error;
  pdfNeverResolves?: boolean;
  timeoutMs?: number;
} = {}) {
  const current = options.current ?? review();
  const page = {
    goto: vi.fn().mockResolvedValue(null),
    waitForSelector: vi.fn().mockResolvedValue({}),
    waitForFunction: vi.fn().mockResolvedValue({}),
    emulateMedia: vi.fn().mockResolvedValue(undefined),
    route: vi.fn().mockResolvedValue(undefined),
    pdf: options.pdfNeverResolves
      ? vi.fn().mockImplementationOnce(() => new Promise<Buffer>(() => undefined))
        .mockResolvedValue(Buffer.from("generated-pdf"))
      : options.pdfFailure
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
    now: () => new Date("2026-08-25T04:05:00.000Z"),
    timeoutMs: options.timeoutMs,
  });
  return { service, repository, fileStore, browserFactory, browser, page };
}

describe("PdfService", () => {
  beforeEach(() => {
    vi.stubEnv("PDF_INTERNAL_ORIGIN", "http://127.0.0.1:3000");
    vi.stubEnv("PDF_PRINT_TOKEN_SECRET", "test-print-token-secret-012345678901234567890123");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("只用内部 origin 打开打印页，等待内容和图片后按 A4 参数生成并持久化", async () => {
    const { service, repository, fileStore, browserFactory, page, browser } = harness();

    const result = await service.getOrCreate(OWNER_ID, "review-1");

    expect(browserFactory.launch).toHaveBeenCalledWith({ headless: true });
    expect(page.route).toHaveBeenCalledWith("**/*", expect.any(Function));
    expect(page.goto).toHaveBeenCalledWith(
      "http://127.0.0.1:3000/print/reviews/review-1",
      { waitUntil: "networkidle", timeout: expect.any(Number) },
    );
    expect(page.waitForSelector).toHaveBeenCalledWith(
      '[data-print-ready="true"]',
      { timeout: expect.any(Number) },
    );
    expect(page.waitForFunction).toHaveBeenCalledWith(
      expect.any(Function),
      undefined,
      { timeout: expect.any(Number) },
    );
    expect(page.emulateMedia).toHaveBeenCalledWith({ media: "print" });
    expect(page.pdf).toHaveBeenCalledWith({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      tagged: true,
      displayHeaderFooter: false,
      headerTemplate: "<div></div>",
      footerTemplate: expect.any(String),
    });
    const pdfOptions = page.pdf.mock.calls[0][0];
    expect(pdfOptions.footerTemplate).toContain("为/自己");
    expect(result.data).toEqual(Buffer.from("generated-pdf"));
    expect(result.filename).toBe("作文批改-为-自己-鼓掌-李羿辰.pdf");
    expect(fileStore.writeFile).toHaveBeenCalledWith(
      OWNER_ID,
      "review-1",
      "pdf",
      result.filename,
      Buffer.from("generated-pdf"),
    );
    expect(repository.markExported).toHaveBeenCalledWith(OWNER_ID, "review-1", 7, {
      pdfFilename: result.filename,
      pdfPath: `pdf/${result.filename}`,
      exportedAt: new Date("2026-08-25T04:05:00.000Z"),
    });
    expect(page.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("当 PDF revision 与 review revision 相同时直接读取缓存", async () => {
    const cached = review({
      status: "exported",
      revision: 8,
      pdfRevision: 8,
      pdfFilename: "作文批改-为-自己-鼓掌-李羿辰.pdf",
      pdfPath: "pdf/作文批改-为-自己-鼓掌-李羿辰.pdf",
      exportedAt: new Date("2026-08-25T04:00:00.000Z"),
    });
    const { service, fileStore, browserFactory, repository } = harness({ current: cached });
    fileStore.readFile.mockResolvedValue(Buffer.from("cached-pdf"));

    const result = await service.getOrCreate(OWNER_ID, "review-1");

    expect(result).toMatchObject({
      filename: "作文批改-为-自己-鼓掌-李羿辰.pdf",
      cached: true,
    });
    expect(result.data).toEqual(Buffer.from("cached-pdf"));
    expect(browserFactory.launch).not.toHaveBeenCalled();
    expect(repository.markExported).not.toHaveBeenCalled();
  });

  it("旧报告的同 revision 缓存即使早于新版式也原样返回", async () => {
    const cached = review({
      report: legacyReport,
      ocr: null,
      reportOcrRevision: null,
      status: "exported",
      revision: 8,
      pdfRevision: 8,
      pdfFilename: "旧版作文批改.pdf",
      pdfPath: "pdf/旧版作文批改.pdf",
      exportedAt: new Date("2026-08-24T03:00:00.000Z"),
    });
    const { service, fileStore, browserFactory, repository } = harness({ current: cached });
    fileStore.readFile.mockResolvedValue(Buffer.from("legacy-cached-pdf"));

    await expect(service.getOrCreate(OWNER_ID, "review-1")).resolves.toMatchObject({
      data: Buffer.from("legacy-cached-pdf"),
      filename: "旧版作文批改.pdf",
      cached: true,
    });
    expect(browserFactory.launch).not.toHaveBeenCalled();
    expect(fileStore.writeFile).not.toHaveBeenCalled();
    expect(repository.markExported).not.toHaveBeenCalled();
  });

  it.each([
    ["同 revision 缓存文件缺失", {
      pdfRevision: 8,
      pdfFilename: "旧版作文批改.pdf",
      pdfPath: "pdf/旧版作文批改.pdf",
      exportedAt: new Date("2026-08-24T03:00:00.000Z"),
    }, true],
    ["没有同 revision 缓存", {
      pdfRevision: null,
      pdfFilename: null,
      pdfPath: null,
      exportedAt: null,
    }, false],
  ])("旧报告%s时返回 LEGACY_REPORT 且不生成", async (_case, cache, missing) => {
    const current = review({
      report: legacyReport,
      ocr: null,
      reportOcrRevision: null,
      revision: 8,
      ...cache,
    });
    const { service, fileStore, browserFactory, repository } = harness({ current });
    if (missing) fileStore.readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));

    await expect(service.getOrCreate(OWNER_ID, "review-1")).rejects.toMatchObject({
      code: "LEGACY_REPORT",
      status: 409,
    });
    expect(browserFactory.launch).not.toHaveBeenCalled();
    expect(fileStore.writeFile).not.toHaveBeenCalled();
    expect(repository.markExported).not.toHaveBeenCalled();
  });

  it("作文未修改但 PDF 版式已经升级时不复用旧缓存", async () => {
    const oldLayout = review({
      status: "exported",
      revision: 8,
      pdfRevision: 8,
      pdfFilename: "作文批改-为-自己-鼓掌-李羿辰.pdf",
      pdfPath: "pdf/作文批改-为-自己-鼓掌-李羿辰.pdf",
      exportedAt: new Date("2026-08-25T03:00:00.000Z"),
    });
    const { service, browserFactory } = harness({ current: oldLayout });

    const result = await service.getOrCreate(OWNER_ID, "review-1");

    expect(result.cached).toBe(false);
    expect(browserFactory.launch).toHaveBeenCalledOnce();
  });

  it("命名规则升级后不复用 v3 PDF 缓存", async () => {
    const oldTemplate = review({
      status: "exported",
      revision: 8,
      pdfRevision: 8,
      pdfFilename: "作文批改-珍贵的礼物-20260721-1405-v3.pdf",
      pdfPath: "pdf/作文批改-珍贵的礼物-20260721-1405-v3.pdf",
      exportedAt: new Date("2026-07-21T06:00:00.000Z"),
    });
    const { service, fileStore, browserFactory } = harness({ current: oldTemplate });

    const result = await service.getOrCreate(OWNER_ID, "review-1");

    expect(result.cached).toBe(false);
    expect(result.filename).toBe("作文批改-为-自己-鼓掌-李羿辰.pdf");
    expect(browserFactory.launch).toHaveBeenCalledOnce();
    expect(fileStore.queuePdfCleanup).toHaveBeenCalledWith(OWNER_ID, "review-1", [
      "作文批改-珍贵的礼物-20260721-1405-v3.pdf",
    ]);
  });

  it("未填写学生姓名时使用“未填写”作为文件名占位", async () => {
    const { service } = harness({ current: review({ studentName: "" }) });

    const result = await service.getOrCreate(OWNER_ID, "review-1");

    expect(result.filename).toBe("作文批改-为-自己-鼓掌-未填写.pdf");
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

    const result = await service.getOrCreate(OWNER_ID, "review-1");

    expect(result.cached).toBe(false);
    expect(browserFactory.launch).toHaveBeenCalledOnce();
    expect(fileStore.queuePdfCleanup).toHaveBeenCalledWith(OWNER_ID, "review-1", ["stale.pdf"]);
  });

  it("无报告或无图片时返回 422 业务错误且不启动浏览器", async () => {
    for (const current of [review({ report: null }), review({ images: [] })]) {
      const { service, browserFactory } = harness({ current });

      await expect(
        service.getOrCreate(OWNER_ID, "review-1"),
      ).rejects.toMatchObject({
        code: "PDF_CONTENT_INCOMPLETE",
        status: 422,
      });
      expect(browserFactory.launch).not.toHaveBeenCalled();
    }
  });

  it("拒绝导出未经过教师审核的作文且不启动浏览器", async () => {
    const { service, browserFactory } = harness({
      current: review({ teacherReviewedAt: null }),
    });

    await expect(service.getOrCreate(OWNER_ID, "review-1")).rejects.toMatchObject({
      code: "TEACHER_REVIEW_REQUIRED",
      status: 422,
    });
    expect(browserFactory.launch).not.toHaveBeenCalled();
  });

  it("生成失败时 finally 关闭 page 和 browser 且不持久化", async () => {
    const { service, page, browser, repository, fileStore } = harness({
      pdfFailure: new Error("render failed"),
    });

    await expect(
      service.getOrCreate(OWNER_ID, "review-1"),
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
      await service.getOrCreate(OWNER_ID, "review-1");
      throw new Error("expected PDF engine failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfServiceError);
      expect(error).toMatchObject({ code: "PDF_ENGINE_MISSING", status: 503 });
      expect((error as Error).message).toContain("playwright install chromium");
      expect((error as Error).message).not.toContain("/Users/private");
    }
  });

  it("PDF_INTERNAL_ORIGIN 未配置时只使用 loopback PORT", async () => {
    delete process.env.PDF_INTERNAL_ORIGIN;
    vi.stubEnv("PORT", "4321");
    const { service, page } = harness();

    await service.getOrCreate(OWNER_ID, "review-1");

    expect(page.goto).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/print/reviews/review-1",
      expect.any(Object),
    );
  });

  it.each([
    "",
    "https://grader.example",
    "file:///tmp/print",
    "http://127.0.0.1.attacker.example:3000",
  ])("拒绝不可信的 PDF_INTERNAL_ORIGIN：%s", (origin) => {
    vi.stubEnv("PDF_INTERNAL_ORIGIN", origin);

    expect(() => harness()).toThrow(/PDF_INTERNAL_ORIGIN/);
  });

  it("跨源重定向请求会被中止并返回不可信导航错误", async () => {
    const { service, page, fileStore, repository } = harness();
    page.goto.mockImplementation(async () => {
      const routeHandler = page.route.mock.calls[0]?.[1];
      const abort = vi.fn().mockResolvedValue(undefined);
      await routeHandler({
        request: () => ({ url: () => "https://attacker.example/steal" }),
        abort,
        continue: vi.fn().mockResolvedValue(undefined),
      });
      expect(abort).toHaveBeenCalledOnce();
      return null;
    });

    await expect(service.getOrCreate(OWNER_ID, "review-1")).rejects.toMatchObject({
      code: "PDF_UNTRUSTED_NAVIGATION",
    });
    expect(fileStore.writeFile).not.toHaveBeenCalled();
    expect(repository.markExported).not.toHaveBeenCalled();
  });

  it("page.pdf 卡死时总 deadline 返回 504 且释放同一 review 的锁", async () => {
    const { service, page, browser } = harness({
      pdfNeverResolves: true,
      timeoutMs: 20,
    });
    const startedAt = Date.now();

    await expect(service.getOrCreate(OWNER_ID, "review-1")).rejects.toMatchObject({
      code: "PDF_TIMEOUT",
      status: 504,
    });
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(browser.close).toHaveBeenCalled();

    await expect(service.getOrCreate(OWNER_ID, "review-1")).resolves.toMatchObject({
      cached: false,
      data: Buffer.from("generated-pdf"),
    });
    expect(page.pdf).toHaveBeenCalledTimes(2);
  });

  it("浏览器阶段自己的超时也统一返回 PDF_TIMEOUT", async () => {
    const { service, page } = harness();
    const browserTimeout = Object.assign(
      new Error("page.goto: Timeout 60000ms exceeded"),
      { name: "TimeoutError" },
    );
    page.goto.mockRejectedValue(browserTimeout);

    await expect(service.getOrCreate(OWNER_ID, "review-1")).rejects.toMatchObject({
      code: "PDF_TIMEOUT",
      status: 504,
    });
  });
});
