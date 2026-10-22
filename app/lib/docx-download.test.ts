import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createReviewDocx } from "./docx-download";
import type { ExportReviewSource } from "./export-report-content";

const PNG_BYTES = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (character) => character.charCodeAt(0),
);

const diagnostics = {
  authenticityAndRelevance: { finding: "真实", action: "保留" },
  materialAndDetails: { finding: "具体", action: "保留" },
  structure: { finding: "完整", action: "保留" },
  language: { finding: "通顺", action: "保留" },
};

function fixture(): ExportReviewSource {
  return {
    id: "review-1",
    studentName: "张小明",
    config: { title: "那一次，我读懂了勇气" },
    teacherReviewedAt: "2026-08-28T08:00:00.000Z",
    reportStale: false,
    images: [
      { id: 11, position: 0, width: 1200, height: 1600, mimeType: "image/png" },
      { id: 12, position: 1, width: 1200, height: 1600, mimeType: "image/png" },
    ],
    ocr: {
      version: 2,
      ocrRevision: 1,
      editedAt: null,
      pages: [
        { pageIndex: 0, text: "我慢慢走，登上舞台。", readable: true, warnings: [] },
        { pageIndex: 1, text: "我明白了成功。", readable: true, warnings: [] },
      ],
      paragraphs: [
        {
          id: "paragraph-1",
          paragraphIndex: 0,
          text: "我慢慢走，登上舞台。",
          segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.6, height: 0.2 }],
        },
        {
          id: "paragraph-2",
          paragraphIndex: 1,
          text: "我明白了成功。",
          segments: [{ pageIndex: 1, x: 0.1, y: 0.4, width: 0.6, height: 0.2 }],
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
            {
              problem: "开头略显概括。",
              advice: "补充登台前的具体动作。",
              example: "手心的汗把稿纸浸出了一道浅痕。",
            },
            {
              problem: "关键句表达准确。",
              advice: "保留。",
              example: "我终于迈出了第一步。",
            },
          ],
          revisedText: "我攥紧稿纸走，登上舞台。",
        },
        {
          paragraphId: "paragraph-2",
          suggestions: [{
            problem: "结尾与题目呼应不足。",
            advice: "把感受落到对勇气的新理解。",
            example: "原来勇气不是不害怕，而是害怕时仍愿意向前。",
          }],
          revisedText: "我明白了勇气。",
        },
      ],
      parentFeedbacks: [],
    },
  };
}

function installBrowserExport() {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: vi.fn(async () => []) },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ({
    font: "",
    measureText: (text: string) => ({ width: text.length * 8 }),
  }) as never);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(PNG_BYTES.slice()));
}

async function unpack(review: ExportReviewSource) {
  const blob = await createReviewDocx(review);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const read = async (path: string) => {
    const file = zip.file(path);
    if (!file) throw new Error(`DOCX 中缺少 ${path}`);
    return file.async("string");
  };
  return {
    blob,
    zip,
    documentXml: await read("word/document.xml"),
    relsXml: await read("word/_rels/document.xml.rels"),
    coreXml: await read("docProps/core.xml"),
  };
}

describe("Word 逐段批改文档", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (document as unknown as { fonts?: unknown }).fonts;
  });

  it("Word 按 PDF 的完整范文标题输出五段正文", async () => {
    installBrowserExport();
    const review = fixture();
    const essay = ["开篇引入。", "抑的铺垫。", "扬的具体事件。", "真相。", "回扣感悟。"];
    review.report = {
      ...(review.report as object),
      rewrittenEssay: essay,
    };
    const { documentXml } = await unpack(review);

    expect(documentXml).toContain("按要求重写的完整范文");
    expect(documentXml).not.toContain("【完整范文");
    essay.forEach((text) => {
      expect(documentXml).toContain(`　　${text}`);
    });
  });

  it("生成与 PDF 相同的建议、示范文本和原图顺序", async () => {
    installBrowserExport();
    const { blob, documentXml } = await unpack(fixture());

    expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(documentXml).toMatch(/<w:pgSz[^>]*w:w="11905"[^>]*w:h="16837"/u);
    expect(documentXml).toMatch(/<w:pgMar[^>]*w:top="907"[^>]*w:right="1020"[^>]*w:bottom="907"[^>]*w:left="1020"/u);
    expect(documentXml).not.toContain("【第 ");
    expect(documentXml).not.toContain("【修改建议");
    expect(documentXml).not.toContain("【修改后段落");
    expect(documentXml).not.toContain("问题：");
    expect(documentXml).not.toContain("动作：");
    expect(documentXml).not.toContain("示例：");
    expect(documentXml).not.toContain("<w:numPr>");
    expect(documentXml).toContain("修改建议：补充登台前的具体动作。");
    expect(documentXml).toContain("保留。");
    expect(documentXml).not.toContain("开头略显概括。");
    expect(documentXml).not.toContain("手心的汗把稿纸浸出了一道浅痕。");
    expect(documentXml).not.toContain("我终于迈出了第一步。");
    expect(documentXml).toContain("示范文本：");
    expect(documentXml).toContain("我攥紧稿纸走，登上舞台。");
    expect(documentXml).toContain("把感受落到对勇气的新理解。");
    expect(documentXml).not.toContain("结尾与题目呼应不足。");
    expect(documentXml).not.toContain("原来勇气不是不害怕，而是害怕时仍愿意向前。");
    expect(documentXml).toContain("我明白了勇气。");
    expect(documentXml.indexOf("我攥紧稿纸走，登上舞台。")).toBeLessThan(documentXml.indexOf("我明白了勇气。"));
    expect(documentXml).toContain('w:fill="E7D4A8"');
    expect(documentXml).toContain('w:color w:val="C00000"');
    expect(documentXml).toContain('w:color w:val="1F4E78"');
    expect(documentXml).toContain('<w:u w:val="single"');
    expect(documentXml).not.toContain("<w:strike");
    expect(documentXml).not.toContain("慢慢走");
    expect(documentXml).not.toContain("成功");
    expect(documentXml).toMatch(/w:eastAsia="(?:楷体|KaiTi)"/u);
    expect(documentXml.match(/<w:br w:type="page"\/>/gu)).toHaveLength(1);
  });

  it("嵌入每一页原图，文档标题与 PDF 一致且不写入内部信息", async () => {
    installBrowserExport();
    const { zip, documentXml, relsXml, coreXml } = await unpack(fixture());
    const media = Object.values(zip.files).filter(({ name, dir }) => (
      name.startsWith("word/media/") && !dir
    ));

    expect(media.length).toBeGreaterThan(0);
    expect(documentXml.match(/descr="第 \d 页作文原图"/gu)).toEqual([
      'descr="第 1 页作文原图"',
      'descr="第 2 页作文原图"',
    ]);
    expect(documentXml).not.toContain("那一次，我读懂了勇气");
    expect(relsXml).not.toContain('TargetMode="External"');
    expect(coreXml).toContain("AI 作业批改助手");
    expect(coreXml).toContain("张小明那一次，我读懂了勇气");
    expect(coreXml).toContain("作文逐段批改");
    expect(coreXml).not.toMatch(/openai|deepseek|api[_ -]?key|\/Users\//iu);
  });
});
