import { chromium } from "playwright";

import type {
  ExportedPdfInput,
  ReviewRecord,
} from "../db/review-repository";
import type { ReviewStorageKind } from "../storage/review-file-store";
import { InMemoryReviewLock, type ReviewLock } from "../services/review-lock";

const PDF_TIMEOUT_MS = 60_000;

interface PdfPage {
  goto(
    url: string,
    options: { waitUntil: "networkidle"; timeout: number },
  ): Promise<unknown>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  waitForFunction(
    pageFunction: () => boolean,
    argument: undefined,
    options: { timeout: number },
  ): Promise<unknown>;
  emulateMedia(options: { media: "print" }): Promise<void>;
  pdf(options: {
    format: "A4";
    printBackground: true;
    preferCSSPageSize: true;
    tagged: true;
    displayHeaderFooter: true;
    headerTemplate: string;
    footerTemplate: string;
  }): Promise<Buffer>;
  close(): Promise<void>;
}

interface PdfBrowser {
  newPage(): Promise<PdfPage>;
  close(): Promise<void>;
}

export interface BrowserFactory {
  launch(options: { headless: true }): Promise<PdfBrowser>;
}

interface PdfRepository {
  getById(id: string): ReviewRecord | null;
  markExported(
    id: string,
    expectedRevision: number,
    input: ExportedPdfInput,
  ): ReviewRecord;
}

interface PdfFileStore {
  readFile(reviewId: string, kind: ReviewStorageKind, filename: string): Promise<Buffer>;
  writeFile(
    reviewId: string,
    kind: ReviewStorageKind,
    filename: string,
    data: Uint8Array,
  ): Promise<string>;
  deleteFile(reviewId: string, kind: ReviewStorageKind, filename: string): Promise<void>;
  queuePdfCleanup(reviewId: string, filenames: string[]): Promise<void>;
}

interface PdfServiceOptions {
  now?: () => Date;
  timeZone?: string;
  timeoutMs?: number;
  lock?: ReviewLock;
}

export class PdfServiceError extends Error {
  constructor(
    readonly code:
      | "REVIEW_NOT_FOUND"
      | "PDF_CONTENT_INCOMPLETE"
      | "PDF_ANALYSIS_IN_PROGRESS"
      | "PDF_ENGINE_MISSING",
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PdfServiceError";
  }
}

const defaultBrowserFactory: BrowserFactory = {
  launch: (options) => chromium.launch(options) as Promise<PdfBrowser>,
};

function missingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function missingBrowserEngine(error: unknown): boolean {
  return (
    error instanceof Error &&
    /executable.*(?:doesn't exist|does not exist|not found)|playwright install|browser.*not found/i.test(
      error.message,
    )
  );
}

function safeTitle(title: string): string {
  const sanitized = title
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\s-]+|[.\s-]+$/g, "");
  return Array.from(sanitized || "作文").slice(0, 48).join("");
}

function timestamp(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function footerTemplate(title: string): string {
  return (
    "<style>" +
    ".pdf-footer{box-sizing:border-box;width:100%;padding:0 12mm;" +
    "display:flex;align-items:center;justify-content:space-between;" +
    "color:#756a60;font:8px/1.4 -apple-system,BlinkMacSystemFont," +
    "'PingFang SC','Microsoft YaHei',sans-serif;}" +
    ".pdf-footer__pages{white-space:nowrap;}" +
    "</style>" +
    `<div class="pdf-footer"><span>作文批改报告 · ${escapeHtml(title)}</span>` +
    '<span class="pdf-footer__pages">第 <span class="pageNumber"></span>/<span class="totalPages"></span> 页</span></div>'
  );
}

export class PdfService {
  private readonly now: () => Date;
  private readonly timeZone: string;
  private readonly timeoutMs: number;
  private readonly lock: ReviewLock;

  constructor(
    private readonly repository: PdfRepository,
    private readonly fileStore: PdfFileStore,
    private readonly browserFactory: BrowserFactory = defaultBrowserFactory,
    options: PdfServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.timeZone = options.timeZone ?? "Asia/Shanghai";
    this.timeoutMs = options.timeoutMs ?? PDF_TIMEOUT_MS;
    this.lock = options.lock ?? new InMemoryReviewLock();
  }

  async getOrCreate(
    reviewId: string,
    origin: string,
  ): Promise<{ data: Buffer; filename: string; cached: boolean }> {
    return this.lock.runExclusive(reviewId, () =>
      this.getOrCreateExclusive(reviewId, origin),
    );
  }

  private async getOrCreateExclusive(
    reviewId: string,
    origin: string,
  ): Promise<{ data: Buffer; filename: string; cached: boolean }> {
    const review = this.repository.getById(reviewId);
    if (!review) {
      throw new PdfServiceError("REVIEW_NOT_FOUND", "批改记录不存在", 404);
    }
    if (review.status === "analyzing") {
      throw new PdfServiceError(
        "PDF_ANALYSIS_IN_PROGRESS",
        "AI 分析进行中，请等待分析完成后再导出",
        409,
      );
    }
    if (!review.report || review.images.length === 0) {
      throw new PdfServiceError(
        "PDF_CONTENT_INCOMPLETE",
        "请先完成 AI 分析并保留至少一张作文图片",
        422,
      );
    }

    if (
      review.pdfFilename &&
      review.pdfPath === `pdf/${review.pdfFilename}` &&
      review.pdfRevision === review.revision &&
      review.exportedAt !== null
    ) {
      try {
        return {
          data: await this.fileStore.readFile(reviewId, "pdf", review.pdfFilename),
          filename: review.pdfFilename,
          cached: true,
        };
      } catch (error) {
        if (!missingFile(error)) throw error;
      }
    }

    const generatedAt = this.now();
    const filename = `作文批改-${safeTitle(review.config.title)}-${timestamp(generatedAt, this.timeZone)}.pdf`;
    const data = await this.render(reviewId, review.config.title, origin);
    await this.fileStore.writeFile(reviewId, "pdf", filename, data);
    try {
      this.repository.markExported(reviewId, review.revision, {
        pdfFilename: filename,
        pdfPath: `pdf/${filename}`,
        exportedAt: generatedAt,
      });
    } catch (error) {
      await this.fileStore.deleteFile(reviewId, "pdf", filename).catch(() => undefined);
      throw error;
    }
    if (review.pdfFilename && review.pdfFilename !== filename) {
      await this.fileStore.queuePdfCleanup(reviewId, [review.pdfFilename]);
    }
    return { data, filename, cached: false };
  }

  private async render(
    reviewId: string,
    title: string,
    origin: string,
  ): Promise<Buffer> {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") {
      throw new TypeError("PDF origin must use HTTP or HTTPS");
    }

    let browser: PdfBrowser;
    try {
      browser = await this.browserFactory.launch({ headless: true });
    } catch (error) {
      if (missingBrowserEngine(error)) {
        throw new PdfServiceError(
          "PDF_ENGINE_MISSING",
          "PDF 引擎未安装，请运行 npx playwright install chromium 后重试",
          503,
          { hint: "npx playwright install chromium" },
        );
      }
      throw error;
    }

    let page: PdfPage | undefined;
    try {
      page = await browser.newPage();
      const printUrl = new URL(
        `/print/reviews/${encodeURIComponent(reviewId)}`,
        parsedOrigin.origin,
      ).toString();
      await page.goto(printUrl, {
        waitUntil: "networkidle",
        timeout: this.timeoutMs,
      });
      await page.waitForSelector('[data-print-ready="true"]', {
        timeout: this.timeoutMs,
      });
      await page.waitForFunction(
        () =>
          Array.from(document.images).every(
            (image) => image.complete && image.naturalWidth > 0,
          ),
        undefined,
        { timeout: this.timeoutMs },
      );
      await page.emulateMedia({ media: "print" });
      return await page.pdf({
        format: "A4",
        printBackground: true,
        preferCSSPageSize: true,
        tagged: true,
        displayHeaderFooter: true,
        headerTemplate: "<div></div>",
        footerTemplate: footerTemplate(title),
      });
    } finally {
      if (page) await page.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }
}
