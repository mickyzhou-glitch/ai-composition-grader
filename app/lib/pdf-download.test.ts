import { migrateEssayDraft } from "@/src/domain/essay-paragraph-sync";
import type { ParagraphEvaluationReport } from "@/src/domain/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

const pdfMock = vi.hoisted(() => ({
  constructorOptions: null as unknown,
  addPage: vi.fn(),
  addImage: vi.fn(),
  output: vi.fn<(type: "blob") => Blob>(() => new Blob(["pdf"], { type: "application/pdf" })),
  setProperties: vi.fn(),
}));

vi.mock("jspdf", () => ({
  jsPDF: class {
    constructor(options: unknown) { pdfMock.constructorOptions = options; }
    addPage(...args: unknown[]) { pdfMock.addPage(...args); }
    addImage(...args: unknown[]) { pdfMock.addImage(...args); }
    output(type: "blob") { return pdfMock.output(type); }
    setProperties(...args: unknown[]) { pdfMock.setProperties(...args); }
  },
}));

import {
  createReviewPdf,
  downloadReviewPdf,
  downloadReviewPdfArchive,
  drawUnderline,
  markReviewExported,
  triggerFileDownload,
} from "./pdf-download";

describe("PDF 文件下载", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    pdfMock.constructorOptions = null;
    pdfMock.addPage.mockReset();
    pdfMock.addImage.mockReset();
    pdfMock.output.mockClear();
    pdfMock.setProperties.mockReset();
    delete (document as unknown as { fonts?: unknown }).fonts;
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  it("直接下载生成的 PDF 文件，不创建打印窗口", () => {
    const createObjectURL = vi.fn(() => "blob:review-pdf");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const open = vi.spyOn(window, "open");

    triggerFileDownload(new Blob(["pdf"], { type: "application/pdf" }), "为自己鼓掌-张小明.pdf");

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:review-pdf");
  });

  it("云端导出使用完整原图生成 A4 横向 PDF，并以蓝色划线标注整句修改", async () => {
    const renderEvents: string[] = [];
    const fontLoad = vi.fn(async () => {
      renderEvents.push("font");
      return [{} as FontFace];
    });
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: fontLoad },
    });
    const paintedText: Array<{ text: string; color: string; font: string }> = [];
    const paintedRects: Array<{ color: string }> = [];
    const strokedLines: Array<{ color: string }> = [];
    const context = {
      fillStyle: "", strokeStyle: "", font: "", textAlign: "left", textBaseline: "top", lineWidth: 1,
      arcTo: vi.fn(), beginPath: vi.fn(), clip: vi.fn(), closePath: vi.fn(), drawImage: vi.fn(),
      fill: vi.fn(), lineTo: vi.fn(), moveTo: vi.fn(), restore: vi.fn(), save: vi.fn(),
      scale: vi.fn(),
      fillRect() { paintedRects.push({ color: this.fillStyle }); },
      stroke() { strokedLines.push({ color: this.strokeStyle }); },
      measureText: (text: string) => ({ width: text.length * 8 }),
      fillText(text: string) { paintedText.push({ text, color: this.fillStyle, font: this.font }); },
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      renderEvents.push("canvas");
      return context as never;
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,page");
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:image"), revokeObjectURL: vi.fn() });
    vi.stubGlobal("Image", class {
      src = "";
      naturalWidth = 1200;
      naturalHeight = 1600;
      async decode() { return undefined; }
    });
    const review = {
      id: "review-1",
      revision: 3,
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
      studentName: "小明",
      config: { title: "珍贵的礼物" },
      images: [{ id: 11, position: 0, width: 1200, height: 1600 }],
      ocr: {
        version: 2, ocrRevision: 1, editedAt: null,
        pages: [{ pageIndex: 0, text: "我慢慢走上台。", readable: true, warnings: [] }],
        paragraphs: [{
          id: "paragraph-1", paragraphIndex: 0, text: "我慢慢走上台。",
          segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
        }],
      },
      report: {
        version: 2,
        themeFit: "fits", themeReason: "切题", personalizedComment: "真实",
        painPoints: [], commonIssues: [], revisionSuggestions: [], grade: "A",
        diagnostics: {
          authenticityAndRelevance: { finding: "真实", action: "保留" },
          materialAndDetails: { finding: "细节少", action: "补动作" },
          structure: { finding: "完整", action: "保留" },
          language: { finding: "通顺", action: "保留" },
        },
        paragraphReviews: [{
          paragraphId: "paragraph-1",
          suggestions: [{ problem: "动作略快", advice: "补充听觉", example: "我听见急促的呼吸声。" }],
          revisedText: "我终于，走上台。",
        }],
        parentFeedbacks: [],
      },
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/reviews/review-1") {
        return new Response(JSON.stringify({ ok: true, data: review }), { headers: { "content-type": "application/json" } });
      }
      if (url === "/api/reviews/export-check") {
        return new Response(JSON.stringify({ ok: true, data: { exportable: true } }), { headers: { "content-type": "application/json" } });
      }
      if (url === "/api/reviews/review-1/exported") {
        return new Response(JSON.stringify({ ok: true, data: { status: "exported" } }), { headers: { "content-type": "application/json" } });
      }
      if (url === "/api/reviews/review-1/files?imageId=11&variant=original") {
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await downloadReviewPdf("review-1");

    const modelText = "补充听觉\n改后全段：我终于，走上台。";
    expect(fontLoad).toHaveBeenCalledWith('400 16px "LXGW WenKai"', modelText);
    expect(fontLoad).toHaveBeenCalledWith('700 16px "LXGW WenKai"', modelText);
    expect(renderEvents.slice(0, 3)).toEqual(["font", "font", "canvas"]);
    expect(pdfMock.constructorOptions).toMatchObject({
      orientation: "landscape",
      unit: "pt",
      format: "a4",
    });
    expect(pdfMock.setProperties).toHaveBeenCalledWith({
      title: "小明珍贵的礼物",
    });
    expect(pdfMock.addImage).toHaveBeenCalledOnce();
    expect(pdfMock.addPage).not.toHaveBeenCalled();
    expect(context.drawImage).toHaveBeenCalled();
    expect(paintedRects).toContainEqual({ color: "#e7d4a8" });
    expect(paintedText.find(({ text }) => text.includes("补充听觉"))).toMatchObject({ color: "#c00000" });
    expect(paintedText.some(({ text }) => text.includes("动作略快") || text.includes("我听见急促的呼吸声"))).toBe(false);
    expect(paintedText.find(({ text }) => text.includes("终于"))).toMatchObject({ color: "#1f4e78", font: expect.stringContaining("LXGW WenKai") });
    expect(strokedLines).toContainEqual({ color: "#1f4e78" });
    expect(paintedText.some(({ text }) => text.includes("慢慢"))).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith("/api/reviews/review-1/files?imageId=11&variant=original");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:image");

    paintedText.length = 0;
    const rewrittenEssay = ["清晨的街角。", "起初的误解。", "扫地时弯腰的身影。", "我终于明白她的辛劳。", "这件事一直打动着我。"];
    await createReviewPdf({ ...review, report: migrateEssayDraft({ ...(review.report as unknown as ParagraphEvaluationReport), rewrittenEssay }, "essay", ["paragraph-1"]) } as never);
    const essayText = paintedText.map(({ text }) => text).join("");
    expect(essayText).toContain("按要求重写的完整范文");
    rewrittenEssay.forEach((text) => expect(essayText).toContain(text));
    expect(pdfMock.addPage).toHaveBeenCalledWith("a4", "landscape");

  });

  it.each([
    { label: "竖长", width: 800, height: 3200 },
    { label: "更竖长", width: 600, height: 4800 },
    { label: "横长", width: 3200, height: 600 },
  ])("$label作文照（$width×$height）长宽比极端时仍生成 PDF，原图按原比例完整显示", async ({ width, height }) => {
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load: vi.fn(async () => []) },
    });
    const paintedText: string[] = [];
    const context = {
      fillStyle: "", strokeStyle: "", font: "", textAlign: "left", textBaseline: "top", lineWidth: 1,
      beginPath: vi.fn(), drawImage: vi.fn(), lineTo: vi.fn(), moveTo: vi.fn(), scale: vi.fn(),
      fillRect: vi.fn(), stroke: vi.fn(),
      measureText: (text: string) => ({ width: text.length * 8 }),
      fillText(text: string) { paintedText.push(text); },
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,page");
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:image"), revokeObjectURL: vi.fn() });
    vi.stubGlobal("Image", class {
      src = "";
      naturalWidth = width;
      naturalHeight = height;
      async decode() { return undefined; }
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })
    ));
    const review = {
      id: "review-tall",
      revision: 1,
      teacherReviewedAt: "2026-08-22T06:00:00.000Z",
      studentName: "小明",
      config: { title: "长图作文" },
      images: [{ id: 21, position: 0, width, height }],
      ocr: {
        version: 2, ocrRevision: 1, editedAt: null,
        pages: [{ pageIndex: 0, text: "我慢慢走上台。", readable: true, warnings: [] }],
        paragraphs: [{
          id: "paragraph-1", paragraphIndex: 0, text: "我慢慢走上台。",
          segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.1 }],
        }],
      },
      report: {
        version: 2,
        themeFit: "fits", themeReason: "切题", personalizedComment: "真实",
        painPoints: [], commonIssues: [], revisionSuggestions: [], grade: "A",
        diagnostics: {
          authenticityAndRelevance: { finding: "真实", action: "保留" },
          materialAndDetails: { finding: "细节少", action: "补动作" },
          structure: { finding: "完整", action: "保留" },
          language: { finding: "通顺", action: "保留" },
        },
        paragraphReviews: [{
          paragraphId: "paragraph-1",
          suggestions: [{ problem: "动作略快", advice: "补充听觉", example: "我听见急促的呼吸声。" }],
          revisedText: "我终于，走上台。",
        }],
        parentFeedbacks: [],
      },
    };

    // 以前这里会抛「作文照片长宽比过于极端……」。
    await expect(createReviewPdf(review as never)).resolves.toBeInstanceOf(Blob);

    expect(pdfMock.addImage).toHaveBeenCalledOnce();
    expect(context.drawImage).toHaveBeenCalledOnce();
    const [, x, y, drawnWidth, drawnHeight] = context.drawImage.mock.calls[0] as [unknown, number, number, number, number];
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
    expect(x + drawnWidth).toBeLessThanOrEqual(841.89 + 0.01);
    expect(y + drawnHeight).toBeLessThanOrEqual(595.28 + 0.01);
    expect(drawnWidth / drawnHeight).toBeCloseTo(width / height, 6);
    // 无法占满半页时，以完整显示为准：至少有一条边贴满页面。
    expect(Math.max(drawnWidth / 841.89, drawnHeight / 595.28)).toBeCloseTo(1, 6);
    expect(paintedText.join("")).toContain("补充听觉");
    expect(paintedText.join("")).not.toContain("对应原文第");
    expect(paintedText.join("")).not.toContain("修改动作");
    expect(paintedText.join("")).not.toMatch(/第 \d+ 段/u);
  });

  it("旧报告在创建 PDF 对象前返回 LEGACY_REPORT", async () => {
    await expect(createReviewPdf({
      id: "review-legacy",
      studentName: "小明",
      config: { title: "旧报告" },
      images: [{ id: 1 }],
      report: { sampleParagraphs: [{ title: "示范", text: "正文", suggestion: "建议" }] },
    } as never)).rejects.toMatchObject({ code: "LEGACY_REPORT" });

    expect(pdfMock.constructorOptions).toBeNull();
  });

  it("批量导出在创建任一 PDF 前校验全部审核状态和 revision", async () => {
    const calls: string[] = [];
    const reviews = new Map([
      ["review-1", { id: "review-1", revision: 3, teacherReviewedAt: "2026-08-22T06:00:00.000Z", studentName: "小明", config: { title: "作文一" }, images: [{ id: 11 }], report: { sampleParagraphs: [] } }],
      ["review-2", { id: "review-2", revision: 5, teacherReviewedAt: "2026-08-22T06:01:00.000Z", studentName: "小红", config: { title: "作文二" }, images: [{ id: 12 }], report: { sampleParagraphs: [] } }],
    ]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push(url);
      const review = /^\/api\/reviews\/(review-[12])$/u.exec(url)?.[1];
      if (review) return new Response(JSON.stringify({ ok: true, data: reviews.get(review) }), { headers: { "content-type": "application/json" } });
      if (url === "/api/reviews/export-check") {
        expect(JSON.parse(String(init?.body))).toEqual({ reviews: [
          { id: "review-1", revision: 3 },
          { id: "review-2", revision: 5 },
        ] });
        return new Response(JSON.stringify({ ok: false, error: { code: "EXPORT_NOT_AVAILABLE", message: "不可导出" } }), { status: 422, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(downloadReviewPdfArchive(["review-1", "review-2"])).rejects.toThrow("不可导出");
    expect(calls).toEqual([
      "/api/reviews/review-1",
      "/api/reviews/review-2",
      "/api/reviews/export-check",
    ]);
    expect(pdfMock.output).not.toHaveBeenCalled();
  });

  it("PDF 下载完成后把记录标记为已导出", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      data: { status: "exported" },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    await markReviewExported("review-1");

    expect(fetchMock).toHaveBeenCalledWith("/api/reviews/review-1/exported", { method: "POST" });
  });
});

describe("drawUnderline", () => {
  function recorder() {
    const calls: Array<[string, ...number[]]> = [];
    let strokes = 0;
    const context = {
      strokeStyle: "",
      lineWidth: 1,
      beginPath: () => calls.push(["beginPath"]),
      moveTo: (x: number, y: number) => calls.push(["moveTo", x, y]),
      lineTo: (x: number, y: number) => calls.push(["lineTo", x, y]),
      quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => calls.push(["quad", cx, cy, x, y]),
      stroke: () => { strokes += 1; },
    };
    return { context, calls, strokes: () => strokes };
  }

  it("单线画一条直线", () => {
    const { context, calls, strokes } = recorder();
    drawUnderline(context, "single", 10, 50, 100, 12, "#1f4e78");
    expect(strokes()).toBe(1);
    expect(calls.filter(([name]) => name === "lineTo")).toEqual([["lineTo", 110, 50]]);
    expect(context.strokeStyle).toBe("#1f4e78");
  });

  it("点划线按长划、点、点循环，落在同一基线且不超出文字宽度", () => {
    const { context, calls, strokes } = recorder();
    drawUnderline(context, "dotDotDash", 10, 50, 100, 12, "#1f4e78");
    expect(strokes()).toBe(1);
    const moves = calls.filter(([name]) => name === "moveTo");
    const lines = calls.filter(([name]) => name === "lineTo");
    expect(lines.length).toBeGreaterThan(6);
    expect(moves).toHaveLength(lines.length);
    expect([...moves, ...lines].every(([, x, y]) => y === 50 && x! >= 10 && x! <= 110 + 1e-9)).toBe(true);
    const lengths = lines.map(([, x], index) => x! - moves[index]![1]!);
    // 一个长划后跟两个短点
    expect(lengths[0]).toBeGreaterThan(lengths[1]! * 3);
    expect(lengths[1]).toBeCloseTo(lengths[2]!);
  });

  it("波浪线由上下交替的曲线连到终点，不超出文字宽度", () => {
    const { context, calls, strokes } = recorder();
    drawUnderline(context, "wave", 10, 50, 100, 12, "#1f4e78");
    expect(strokes()).toBe(1);
    const curves = calls.filter(([name]) => name === "quad");
    expect(curves.length).toBeGreaterThan(10);
    expect(curves.at(-1)?.[3]).toBeCloseTo(110);
    expect(curves.every(([, , , x]) => x! <= 110 + 1e-9)).toBe(true);
    expect(curves[0]![2]).toBeLessThan(50);
    expect(curves[1]![2]).toBeGreaterThan(50);
  });
});
