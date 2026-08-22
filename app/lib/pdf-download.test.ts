import { afterEach, describe, expect, it, vi } from "vitest";

const pdfMock = vi.hoisted(() => ({
  constructorOptions: null as unknown,
  addPage: vi.fn(),
  addImage: vi.fn(),
  output: vi.fn(() => new Blob(["pdf"], { type: "application/pdf" })),
  setProperties: vi.fn(),
}));

vi.mock("jspdf", () => ({
  jsPDF: class {
    constructor(options: unknown) { pdfMock.constructorOptions = options; }
    addPage(...args: unknown[]) { pdfMock.addPage(...args); }
    addImage(...args: unknown[]) { pdfMock.addImage(...args); }
    output(...args: unknown[]) { return pdfMock.output(...args); }
    setProperties(...args: unknown[]) { pdfMock.setProperties(...args); }
  },
}));

import { downloadReviewPdf, downloadReviewPdfArchive, markReviewExported, triggerFileDownload } from "./pdf-download";

describe("PDF 文件下载", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    pdfMock.constructorOptions = null;
    pdfMock.addPage.mockReset();
    pdfMock.addImage.mockReset();
    pdfMock.output.mockClear();
    pdfMock.setProperties.mockReset();
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

  it("云端导出按作文原图生成 A4 横版三栏页并使用指定字体颜色", async () => {
    const paintedText: Array<{ text: string; color: string; font: string }> = [];
    const context = {
      fillStyle: "", strokeStyle: "", font: "", textAlign: "left", textBaseline: "top", lineWidth: 1,
      arcTo: vi.fn(), beginPath: vi.fn(), clip: vi.fn(), closePath: vi.fn(), drawImage: vi.fn(),
      fill: vi.fn(), fillRect: vi.fn(), lineTo: vi.fn(), moveTo: vi.fn(), restore: vi.fn(), save: vi.fn(),
      scale: vi.fn(), stroke: vi.fn(),
      measureText: (text: string) => ({ width: text.length * 8 }),
      fillText(text: string) { paintedText.push({ text, color: this.fillStyle, font: this.font }); },
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
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
      images: [{ id: 11 }, { id: 12 }],
      report: {
        personalizedComment: "优点",
        painPoints: ["需要修改"],
        sampleParagraphs: [
          { title: "第一段", suggestion: "修改建议一", text: "范文一" },
          { title: "第二段", suggestion: "修改建议二", text: "范文二" },
        ],
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
      if (url.includes("/files?")) return new Response(new Blob(["image"], { type: "image/jpeg" }));
      if (url === "/api/reviews/review-1/exported") {
        return new Response(JSON.stringify({ ok: true, data: { status: "exported" } }), { headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await downloadReviewPdf("review-1");

    expect(pdfMock.constructorOptions).toMatchObject({ orientation: "landscape", format: "a4" });
    expect(pdfMock.addImage).toHaveBeenCalledTimes(2);
    expect(pdfMock.addPage).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/reviews/review-1/files?imageId=11&variant=original");
    expect(fetchMock).toHaveBeenCalledWith("/api/reviews/review-1/files?imageId=12&variant=original");
    expect(paintedText.find(({ text }) => text === "修改建议一")).toMatchObject({ color: "#1557b0", font: expect.stringContaining("SimHei") });
    expect(paintedText.find(({ text }) => text === "范文一")).toMatchObject({ color: "#c62828", font: expect.stringContaining("KaiTi") });
    expect(paintedText.some(({ text }) => text === "优点" || text === "需要修改")).toBe(false);
    expect(paintedText.some(({ text }) => text.includes("青藤未来") || text.startsWith("学生：") || /第 \d+ 页批注/u.test(text))).toBe(false);
    expect(context.fillRect).toHaveBeenCalledTimes(2);
    expect(context.stroke).not.toHaveBeenCalled();
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
