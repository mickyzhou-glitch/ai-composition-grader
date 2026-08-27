import { chromium } from "playwright";

import { deliveryReadiness } from "../delivery/readiness";
import { isLegacyEvaluationReport } from "../domain/contracts";
import type {
  ExportedPdfInput,
  ReviewRecord,
} from "../db/review-repository";
import type { ReviewStorageKind } from "../storage/review-file-store";
import { InMemoryReviewLock, type ReviewLock } from "../services/review-lock";
import { createPrintToken, PRINT_TOKEN_HEADER } from "./print-token";

const PDF_TIMEOUT_MS = 60_000;
const PDF_CLOSE_TIMEOUT_MS = 5_000;
// Bump this whenever the printable document structure changes so an otherwise
// current review cannot return a PDF rendered with an older layout.
const PDF_LAYOUT_RELEASED_AT = new Date("2026-08-25T04:00:00.000Z");

interface PdfRoute {
  request(): { url(): string };
  abort(errorCode?: "blockedbyclient"): Promise<void>;
  continue(): Promise<void>;
}

interface PdfPage {
  route(url: "**/*", handler: (route: PdfRoute) => Promise<void>): Promise<unknown>;
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
    displayHeaderFooter: boolean;
    headerTemplate: string;
    footerTemplate: string;
  }): Promise<Buffer>;
  close(): Promise<void>;
}

interface PdfBrowser {
  newPage(options?: { extraHTTPHeaders?: Record<string, string> }): Promise<PdfPage>;
  close(): Promise<void>;
}

export interface BrowserFactory {
  launch(options: { headless: true }): Promise<PdfBrowser>;
}

interface PdfRepository {
  getById(ownerId: string, id: string): ReviewRecord | null;
  markExported(
    ownerId: string,
    id: string,
    expectedRevision: number,
    input: ExportedPdfInput,
  ): ReviewRecord;
}

interface PdfFileStore {
  readFile(ownerId: string, reviewId: string, kind: ReviewStorageKind, filename: string): Promise<Buffer>;
  writeFile(
    ownerId: string,
    reviewId: string,
    kind: ReviewStorageKind,
    filename: string,
    data: Uint8Array,
  ): Promise<string>;
  deleteFile(ownerId: string, reviewId: string, kind: ReviewStorageKind, filename: string): Promise<void>;
  queuePdfCleanup(ownerId: string, reviewId: string, filenames: string[]): Promise<void>;
  migrateLegacyReview?(ownerId: string, reviewId: string): Promise<void>;
  withReviewLock?<T>(
    ownerId: string,
    reviewId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
}

interface PdfServiceOptions {
  now?: () => Date;
  timeoutMs?: number;
  lock?: ReviewLock;
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

function configurationError(message: string): Error {
  return new Error(`PDF_INTERNAL_ORIGIN 配置无效：${message}`);
}

export function resolveInternalPrintOrigin(): string {
  const configured = process.env.PDF_INTERNAL_ORIGIN;
  let rawOrigin: string;
  if (configured !== undefined) {
    rawOrigin = configured;
  } else {
    const port = process.env.PORT || "3001";
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
      throw configurationError("PORT 必须是 1 至 65535 的整数");
    }
    rawOrigin = `http://127.0.0.1:${port}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    throw configurationError("必须是合法 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw configurationError("仅支持 http 或 https 协议");
  }
  if (!LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
    throw configurationError("主机必须严格为 127.0.0.1、localhost 或 [::1]");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw configurationError("必须只包含 origin，不得包含凭据、路径、查询或片段");
  }
  return parsed.origin;
}

export class PdfServiceError extends Error {
  constructor(
    readonly code:
      | "REVIEW_NOT_FOUND"
      | "LEGACY_REPORT"
      | "PDF_CONTENT_INCOMPLETE"
      | "PDF_ANALYSIS_IN_PROGRESS"
      | "TEACHER_REVIEW_REQUIRED"
      | "PDF_ENGINE_MISSING"
      | "PDF_UNTRUSTED_NAVIGATION"
      | "PDF_TIMEOUT",
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

function browserTimedOut(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || /timeout.*exceeded|timed out/i.test(error.message))
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

function pdfFilenameFor(review: ReviewRecord): string {
  const studentName = review.studentName.trim() || "未填写";
  return `作文批改-${safeTitle(review.config.title)}-${safeTitle(studentName)}.pdf`;
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

function pdfTimeoutError(): PdfServiceError {
  return new PdfServiceError(
    "PDF_TIMEOUT",
    "PDF 生成超时，请稍后重试",
    504,
  );
}

function legacyReportError(): PdfServiceError {
  return new PdfServiceError(
    "LEGACY_REPORT",
    "旧版示范段落报告需要完整重新分析后才能生成新格式",
    409,
  );
}

function remainingTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw pdfTimeoutError();
  return remaining;
}

async function closeWithin(
  close: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!close) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(close).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, PDF_CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class PdfService {
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly lock: ReviewLock;
  private readonly internalOrigin: string;

  constructor(
    private readonly repository: PdfRepository,
    private readonly fileStore: PdfFileStore,
    private readonly browserFactory: BrowserFactory = defaultBrowserFactory,
    options: PdfServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? PDF_TIMEOUT_MS;
    this.lock = options.lock ?? new InMemoryReviewLock();
    this.internalOrigin = resolveInternalPrintOrigin();
  }

  async getOrCreate(
    ownerId: string,
    reviewId: string,
  ): Promise<{ data: Buffer; filename: string; cached: boolean }> {
    return this.lock.runExclusive(reviewId, async () => {
      if (!this.fileStore.withReviewLock) {
        return this.getOrCreateExclusive(ownerId, reviewId);
      }
      return this.fileStore.withReviewLock(
        ownerId,
        reviewId,
        () => this.getOrCreateExclusive(ownerId, reviewId),
      );
    });
  }

  private async getOrCreateExclusive(
    ownerId: string,
    reviewId: string,
  ): Promise<{ data: Buffer; filename: string; cached: boolean }> {
    const review = this.repository.getById(ownerId, reviewId);
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
    if (review.teacherReviewedAt === null) {
      throw new PdfServiceError(
        "TEACHER_REVIEW_REQUIRED",
        "作文必须经过老师审核后才能导出",
        422,
      );
    }
    if (review.report && isLegacyEvaluationReport(review.report)) {
      const hasCurrentCache = Boolean(
        review.pdfFilename
        && review.pdfPath === `pdf/${review.pdfFilename}`
        && review.pdfRevision === review.revision,
      );
      if (hasCurrentCache && review.pdfFilename) {
        try {
          return {
            data: await this.fileStore.readFile(
              ownerId,
              reviewId,
              "pdf",
              review.pdfFilename,
            ),
            filename: review.pdfFilename,
            cached: true,
          };
        } catch (error) {
          if (!missingFile(error)) throw error;
        }
      }
      throw legacyReportError();
    }
    if (!review.report || review.images.length === 0) {
      throw new PdfServiceError(
        "PDF_CONTENT_INCOMPLETE",
        "请先完成 AI 分析并保留至少一张作文图片",
        422,
      );
    }
    const readiness = deliveryReadiness({
      report: review.report,
      teacherReviewedAt: review.teacherReviewedAt,
      reportOcrRevision: review.reportOcrRevision,
      ocr: review.ocr,
      images: review.images,
    });
    if (!readiness.ready) {
      throw new PdfServiceError(
        "PDF_CONTENT_INCOMPLETE",
        readiness.message,
        422,
        { reason: readiness.code },
      );
    }
    await this.fileStore.migrateLegacyReview?.(ownerId, reviewId);
    const filename = pdfFilenameFor(review);

    if (
      review.pdfFilename === filename &&
      review.pdfPath === `pdf/${filename}` &&
      review.pdfRevision === review.revision &&
      review.exportedAt !== null &&
      review.exportedAt >= PDF_LAYOUT_RELEASED_AT
    ) {
      try {
        return {
          data: await this.fileStore.readFile(ownerId, reviewId, "pdf", review.pdfFilename),
          filename: review.pdfFilename,
          cached: true,
        };
      } catch (error) {
        if (!missingFile(error)) throw error;
      }
    }

    const generatedAt = this.now();
    const data = await this.render(ownerId, reviewId, review.config.title);
    await this.fileStore.writeFile(ownerId, reviewId, "pdf", filename, data);
    try {
      this.repository.markExported(ownerId, reviewId, review.revision, {
        pdfFilename: filename,
        pdfPath: `pdf/${filename}`,
        exportedAt: generatedAt,
      });
    } catch (error) {
      await this.fileStore.deleteFile(ownerId, reviewId, "pdf", filename).catch(() => undefined);
      throw error;
    }
    if (review.pdfFilename && review.pdfFilename !== filename) {
      await this.fileStore.queuePdfCleanup(ownerId, reviewId, [review.pdfFilename]);
    }
    return { data, filename, cached: false };
  }

  private async render(
    ownerId: string,
    reviewId: string,
    title: string,
  ): Promise<Buffer> {
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
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = Date.now() + this.timeoutMs;
      const renderPage = (async () => {
        const printToken = createPrintToken({ ownerId, reviewId });
        page = await browser.newPage({
          extraHTTPHeaders: { [PRINT_TOKEN_HEADER]: printToken },
        });
        let untrustedUrl: string | undefined;
        await page.route("**/*", async (route) => {
          const requested = route.request().url();
          if (requested.startsWith("data:")) {
            await route.continue();
            return;
          }
          let requestedOrigin: string | undefined;
          try {
            requestedOrigin = new URL(requested).origin;
          } catch {
            // An unparsable browser request is never trusted.
          }
          if (requestedOrigin === this.internalOrigin) {
            await route.continue();
            return;
          }
          untrustedUrl ??= requested;
          await route.abort("blockedbyclient");
        });
        const assertTrustedNavigation = () => {
          if (untrustedUrl) {
            throw new PdfServiceError(
              "PDF_UNTRUSTED_NAVIGATION",
              "打印页尝试访问非内部资源，已终止 PDF 生成",
              502,
            );
          }
        };
        const printUrl = new URL(
          `/print/reviews/${encodeURIComponent(reviewId)}`,
          this.internalOrigin,
        ).toString();
        try {
          await page.goto(printUrl, {
            waitUntil: "networkidle",
            timeout: remainingTime(deadline),
          });
          assertTrustedNavigation();
          await page.waitForSelector('[data-print-ready="true"]', {
            timeout: remainingTime(deadline),
          });
          assertTrustedNavigation();
          await page.waitForFunction(
            () =>
              Array.from(document.images).every(
                (image) => image.complete && image.naturalWidth > 0,
              ),
            undefined,
            { timeout: remainingTime(deadline) },
          );
          assertTrustedNavigation();
          await page.emulateMedia({ media: "print" });
          const data = await page.pdf({
            format: "A4",
            printBackground: true,
            preferCSSPageSize: true,
            tagged: true,
            displayHeaderFooter: false,
            headerTemplate: "<div></div>",
            footerTemplate: footerTemplate(title),
          });
          assertTrustedNavigation();
          return data;
        } catch (error) {
          assertTrustedNavigation();
          throw error;
        }
      })();
      const timedOut = new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimeout(() => {
          void closeWithin(() => browser.close());
          reject(pdfTimeoutError());
        }, this.timeoutMs);
      });
      try {
        return await Promise.race([renderPage, timedOut]);
      } catch (error) {
        if (browserTimedOut(error)) throw pdfTimeoutError();
        throw error;
      }
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      await closeWithin(page ? () => page!.close() : undefined);
      await closeWithin(() => browser.close());
    }
  }
}
