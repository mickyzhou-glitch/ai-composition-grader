// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { PdfServiceError } from "../pdf/pdf-service";
import { createReviewPdfRouteHandlers } from "./handlers";

const context = { params: Promise.resolve({ id: "review-1" }) };

describe("GET /api/reviews/[id]/pdf", () => {
  it("返回 PDF 与 ASCII fallback + RFC5987 中文文件名", async () => {
    const getOrCreate = vi.fn().mockResolvedValue({
      data: Buffer.from("%PDF-test"),
      filename: "作文批改-为自己喝彩-20260721-1405.pdf",
      cached: false,
    });
    const handler = createReviewPdfRouteHandlers({
      pdfService: { getOrCreate } as never,
    });

    const response = await handler.GET(
      new Request("https://grader.example/api/reviews/review-1/pdf"),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="composition-review.pdf"; filename*=UTF-8''${encodeURIComponent("作文批改-为自己喝彩-20260721-1405.pdf")}`,
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from("%PDF-test"));
    expect(getOrCreate).toHaveBeenCalledWith("review-1", "https://grader.example");
  });

  it("无报告或图片时返回 422", async () => {
    const handler = createReviewPdfRouteHandlers({
      pdfService: {
        getOrCreate: vi.fn().mockRejectedValue(
          new PdfServiceError(
            "PDF_CONTENT_INCOMPLETE",
            "请先完成 AI 分析并保留至少一张作文图片",
            422,
          ),
        ),
      } as never,
    });

    const response = await handler.GET(
      new Request("http://localhost:3000/api/reviews/review-1/pdf"),
      context,
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "PDF_CONTENT_INCOMPLETE",
        message: "请先完成 AI 分析并保留至少一张作文图片",
      },
    });
  });

  it("缺少 Chromium 时返回 503 和可操作提示，不泄露本机路径", async () => {
    const handler = createReviewPdfRouteHandlers({
      pdfService: {
        getOrCreate: vi.fn().mockRejectedValue(
          new PdfServiceError(
            "PDF_ENGINE_MISSING",
            "PDF 引擎未安装，请运行 npx playwright install chromium 后重试",
            503,
            { hint: "npx playwright install chromium" },
          ),
        ),
      } as never,
    });

    const response = await handler.GET(
      new Request("http://localhost:3000/api/reviews/review-1/pdf"),
      context,
    );
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(serialized).toContain("PDF_ENGINE_MISSING");
    expect(serialized).toContain("npx playwright install chromium");
    expect(serialized).not.toContain("/Users/");
  });
});
