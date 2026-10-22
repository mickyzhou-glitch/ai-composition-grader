import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createReviewDocx } from "./docx-download";
import {
  buildExportReportContent,
  visibleExportText,
  type ExportReviewSource,
} from "./export-report-content";
import { createReviewPdf } from "./pdf-download";

const pdfMock = vi.hoisted(() => ({
  addPage: vi.fn(),
  addImage: vi.fn(),
  output: vi.fn<(type: "blob") => Blob>(() => new Blob(["pdf"], { type: "application/pdf" })),
  setProperties: vi.fn(),
}));

vi.mock("jspdf", () => ({
  jsPDF: class {
    constructor() {}
    addPage(...args: unknown[]) { pdfMock.addPage(...args); }
    addImage(...args: unknown[]) { pdfMock.addImage(...args); }
    output(type: "blob") { return pdfMock.output(type); }
    setProperties(...args: unknown[]) { pdfMock.setProperties(...args); }
  },
}));

const PNG_BYTES = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (character) => character.charCodeAt(0),
);

const diagnostics = {
  authenticityAndRelevance: { finding: "真实", action: "保留" },
  materialAndDetails: { finding: "细节少", action: "补动作" },
  structure: { finding: "完整", action: "保留" },
  language: { finding: "通顺", action: "保留" },
};

function review(rewrittenEssay?: string[]): ExportReviewSource {
  return {
    id: "review-parity",
    studentName: "小明",
    config: { title: "珍贵的礼物" },
    teacherReviewedAt: "2026-08-22T06:00:00.000Z",
    reportStale: false,
    images: [
      { id: 21, position: 1, width: 1200, height: 1600, mimeType: "image/png" },
      { id: 11, position: 0, width: 1200, height: 1600, mimeType: "image/png" },
    ],
    ocr: {
      version: 2,
      ocrRevision: 1,
      editedAt: null,
      pages: [
        { pageIndex: 0, text: "我慢慢走上台。", readable: true, warnings: [] },
        { pageIndex: 1, text: "礼物其实一直都在。", readable: true, warnings: [] },
      ],
      paragraphs: [
        {
          id: "paragraph-1",
          paragraphIndex: 0,
          text: "我慢慢走上台。",
          segments: [
            { pageIndex: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.1 },
            { pageIndex: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.1 },
          ],
        },
        {
          id: "paragraph-2",
          paragraphIndex: 1,
          text: "礼物其实一直都在。",
          segments: [{ pageIndex: 1, x: 0.1, y: 0.4, width: 0.6, height: 0.12 }],
        },
      ],
    },
    report: {
      version: 2,
      themeFit: "fits",
      themeReason: "切题",
      personalizedComment: "真实",
      painPoints: [],
      commonIssues: [],
      revisionSuggestions: [],
      grade: "A",
      diagnostics,
      paragraphReviews: [
        {
          paragraphId: "paragraph-1",
          suggestions: [
            { problem: "动作略快", advice: "补充听觉", example: "我听见急促的呼吸声。" },
            { problem: "开头概括", advice: "补一个停顿", example: "我的脚停在门槛上。" },
          ],
          revisedText: "我终于，走上台。",
        },
        {
          paragraphId: "paragraph-2",
          suggestions: [{ problem: "收束偏快", advice: "回扣题目", example: "这份礼物是陪伴。" }],
          revisedText: "礼物其实是妈妈每天的陪伴。",
        },
      ],
      parentFeedbacks: [],
      ...(rewrittenEssay ? { rewrittenEssay } : {}),
    },
  };
}

function installBrowser() {
  const paintedText: string[] = [];
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: vi.fn(async () => []) },
  });
  const context = {
    fillStyle: "",
    strokeStyle: "",
    font: "",
    textAlign: "left",
    textBaseline: "top",
    lineWidth: 1,
    arcTo: vi.fn(),
    beginPath: vi.fn(),
    clip: vi.fn(),
    closePath: vi.fn(),
    drawImage: vi.fn(),
    fill: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    scale: vi.fn(),
    fillRect: vi.fn(),
    stroke: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 8 }),
    fillText(text: string) { paintedText.push(text); },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,page");
  vi.stubGlobal("Image", class {
    src = "";
    naturalWidth = 1200;
    naturalHeight = 1600;
    async decode() { return undefined; }
  });
  Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:image"),
    revokeObjectURL: vi.fn(),
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(PNG_BYTES.slice()));
  return paintedText;
}

function decodeXml(value: string) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

async function docxVisibleText(review: ExportReviewSource) {
  const blob = await createReviewDocx(review);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) throw new Error("DOCX 中缺少 word/document.xml");
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/gu)]
    .map((match) => decodeXml(match[1]))
    .join("");
}

describe("Word 与 PDF 导出文本", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    pdfMock.addPage.mockReset();
    pdfMock.addImage.mockReset();
    pdfMock.output.mockClear();
    pdfMock.setProperties.mockReset();
    delete (document as unknown as { fonts?: unknown }).fonts;
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  it.each([
    { name: "无完整范文", essay: undefined },
    {
      name: "短完整范文",
      essay: ["清晨的街角。", "起初的误解。", "扫地时弯腰的身影。", "我终于明白她的辛劳。", "这件事一直打动着我。"],
    },
    {
      name: "跨页完整范文",
      essay: Array.from({ length: 8 }, (_, index) => (
        `${"夜色里的路灯一盏盏亮起来，我跟着妈妈的影子走过长长的街。".repeat(6)}第${index + 1}段。`
      )),
    },
  ])("同一份报告的 $name 在 docx 与 PDF 中文本一致", async ({ essay }) => {
    const paintedText = installBrowser();
    const source = review(essay);
    const measure = (text: string) => text.length * 8;

    await createReviewPdf(source as never);
    const pdfText = paintedText.join("");
    const docxText = await docxVisibleText(source);

    expect(docxText).toBe(pdfText);
    expect(docxText).toBe(visibleExportText(buildExportReportContent(source), measure));
    expect(pdfMock.setProperties).toHaveBeenCalledWith({ title: "小明珍贵的礼物" });
    expect(docxText).toContain("修改建议：动作略快；补充听觉；我听见急促的呼吸声。");
    expect(docxText).toContain("开头概括；补一个停顿；我的脚停在门槛上。");
    expect(docxText).toContain("示范文本：");
    expect(docxText).toContain("我终于，走上台。");
    expect(docxText).toContain("礼物其实是妈妈每天的陪伴。");
    expect(docxText.indexOf("我终于，走上台。")).toBeLessThan(docxText.indexOf("礼物其实是妈妈每天的陪伴。"));
    expect(docxText).not.toContain("慢慢");
    expect(docxText).not.toContain("【第 ");
    expect(docxText).not.toContain("问题：");
    if (essay) {
      expect(docxText).toContain("按要求重写的完整范文");
      essay.forEach((text) => expect(docxText).toContain(text));
    }
  });
});
