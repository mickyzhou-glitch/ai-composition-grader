import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACCENT3_BASE_HEX,
  ACCENT3_LIGHTER_60_TINT,
  BOX_FILL_HEX,
  chooseBoxHalfPoints,
  createReviewDocx,
} from "./docx-download";
import type { ExportParagraph } from "./export-report-content";
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
      expect(documentXml).toContain(text);
    });
  });

  it("完整范文每段只有一个 w:p，段内没有 w:br，首行缩进两字", async () => {
    installBrowserExport();
    const review = fixture();
    const long = "“学而时习之，不亦说乎？”这句话出自我国古代著名的思想家、教育家、儒学家、文学家——孔子。这句话我从小就会背，却从未真正理解过它的含义。".repeat(3);
    const essay = [long, `${long}第二段。`, "短段。"];
    review.report = { ...(review.report as object), rewrittenEssay: essay } as ExportReviewSource["report"];
    const { documentXml } = await unpack(review);

    const body = documentXml.slice(documentXml.lastIndexOf("按要求重写的完整范文"));
    const paragraphs = [...body.matchAll(/<w:p>[\s\S]*?<\/w:p>|<w:p [\s\S]*?<\/w:p>/gu)].map((match) => match[0]);
    const essayParagraphs = paragraphs.filter((xml) => xml.includes("<w:t"));
    expect(essayParagraphs).toHaveLength(essay.length);
    essayParagraphs.forEach((xml) => {
      expect(xml).not.toContain("<w:br");
      expect(xml).toMatch(/<w:ind [^>]*w:firstLineChars="200"/u);
      expect(xml).not.toContain("　　");
    });
    expect(essayParagraphs[0]).toContain(long);
    expect(essayParagraphs[1]).toContain(`${long}第二段。`);
  });

  it("右侧文本框的改后全段正文里没有 w:br", async () => {
    installBrowserExport();
    const review = fixture();
    const report = review.report as { paragraphReviews: Array<{ revisedText: string }> };
    report.paragraphReviews[0]!.revisedText = `${report.paragraphReviews[0]!.revisedText}\n夹带换行的一句。`;
    const { documentXml } = await unpack(review);
    const cell = documentXml.slice(documentXml.indexOf("改后全段："));
    const revisedParagraph = cell.slice(0, cell.indexOf("</w:p>"));
    expect(revisedParagraph).toContain("夹带换行的一句。");
    expect(revisedParagraph).not.toContain("<w:br");
  });

  it("生成与 PDF 相同的修改动作、改后全段和原图顺序", async () => {
    installBrowserExport();
    const { blob, documentXml } = await unpack(fixture());

    expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(documentXml).toMatch(/<w:pgSz[^>]*w:w="16837"[^>]*w:h="11905"[^>]*w:orient="landscape"/u);
    expect(documentXml).toMatch(/<w:pgMar[^>]*w:top="680"[^>]*w:right="680"[^>]*w:bottom="680"[^>]*w:left="680"/u);
    expect(documentXml).not.toContain("【第 ");
    expect(documentXml).not.toContain("【修改建议");
    expect(documentXml).not.toContain("【修改后段落");
    expect(documentXml).not.toContain("问题：");
    expect(documentXml).not.toContain("问题描述");
    expect(documentXml).not.toContain("修改示例");
    expect(documentXml).not.toContain("示例：");
    expect(documentXml).not.toContain("<w:numPr>");
    expect(documentXml).toContain("修改动作：1. 补充登台前的具体动作。");
    expect(documentXml).toContain("保留。");
    expect(documentXml).not.toContain("开头略显概括。");
    expect(documentXml).not.toContain("手心的汗把稿纸浸出了一道浅痕。");
    expect(documentXml).not.toContain("我终于迈出了第一步。");
    expect(documentXml).toContain("改后全段：");
    expect(documentXml).not.toContain("示范文本：");
    expect(documentXml).not.toContain("修改建议：");
    expect(documentXml).toContain("我攥紧稿纸走，登上舞台。");
    expect(documentXml).toContain("把感受落到对勇气的新理解。");
    expect(documentXml).not.toContain("结尾与题目呼应不足。");
    expect(documentXml).not.toContain("原来勇气不是不害怕，而是害怕时仍愿意向前。");
    expect(documentXml).toContain("我明白了勇气。");
    expect(documentXml.indexOf("我攥紧稿纸走，登上舞台。")).toBeLessThan(documentXml.indexOf("我明白了勇气。"));
    expect(documentXml).toContain('w:fill="E7D4A8"');
    expect(documentXml).toContain('w:themeColor="accent3"');
    expect(documentXml).toContain('w:themeTint="66"');
    expect(documentXml).toContain('w:themeFill="accent3"');
    expect(documentXml).toContain('w:themeFillTint="66"');
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

  it("改后全段只给修改或新增的句子加下划线", async () => {
    installBrowserExport();
    const review = fixture();
    const ocr = review.ocr;
    if (!ocr || ocr.version !== 2) throw new Error("fixture ocr");
    ocr.pages[0].text = "我慢慢走上台。灯光很亮。";
    ocr.paragraphs[0].text = "我慢慢走上台。灯光很亮。";
    const report = review.report as {
      paragraphReviews: Array<{
        revisedText: string;
        suggestions: Array<{ problem?: string; advice: string; example?: string }>;
      }>;
    };
    report.paragraphReviews[0].suggestions = [{
      problem: "动作略快",
      advice: "写清迈步的感觉",
      example: "我听见自己的呼吸。",
    }];
    report.paragraphReviews[0].revisedText = "我终于走上台。灯光很亮。我听见自己的呼吸。";
    const { documentXml } = await unpack(review);
    const runXml = (text: string) => {
      const token = `<w:t xml:space="preserve">${text}</w:t>`;
      const at = documentXml.indexOf(token);
      const start = documentXml.lastIndexOf("<w:r>", at);
      return documentXml.slice(start, documentXml.indexOf("</w:r>", at));
    };

    expect(documentXml).toContain("修改动作：写清迈步的感觉");
    expect(documentXml).toContain("改后全段：");
    expect(documentXml).not.toContain("动作略快");
    expect(documentXml).not.toContain("问题描述");
    expect(documentXml).not.toContain("修改示例");
    expect(documentXml).not.toContain("示范文本");
    expect(runXml("灯光很亮。")).not.toContain("<w:u ");
    expect(runXml("我终于走上台。")).toContain('<w:u w:val="single"');
    expect(runXml("我听见自己的呼吸。")).toContain('<w:u w:val="single"');
  });

  it("横向页上每段一个浅黄文本框，框数等于段数", async () => {
    installBrowserExport();
    const review = fixture();
    const paragraphs = ["开篇引入。", "先写犹豫。", "再写登台。", "点明勇气。", "收束全文。"];
    review.images = [{ id: 11, position: 0, width: 1200, height: 1600, mimeType: "image/png" }];
    review.ocr = {
      version: 2,
      ocrRevision: 1,
      editedAt: null,
      pages: [{ pageIndex: 0, text: paragraphs.join(""), readable: true, warnings: [] }],
      paragraphs: paragraphs.map((text, index) => ({
        id: `paragraph-${index + 1}`,
        paragraphIndex: index,
        text,
        segments: [{ pageIndex: 0, x: 0.1, y: 0.1 + index * 0.12, width: 0.6, height: 0.1 }],
      })),
    };
    review.report = {
      ...(review.report as object),
      paragraphReviews: paragraphs.map((text, index) => ({
        paragraphId: `paragraph-${index + 1}`,
        suggestions: [{ advice: `改好第 ${index + 1} 段。` }],
        revisedText: text,
      })),
    };
    const { zip, documentXml } = await unpack(review);
    const theme = await zip.file("word/theme/theme1.xml")?.async("string");
    const cells = documentXml.split(/<w:tc[\s>]/u).slice(1);
    const boxes = cells.filter((cell) => cell.includes("修改动作："));
    const photoTables = [...documentXml.matchAll(/<w:tblGrid>[\s\S]*?<\/w:tblGrid>/gu)]
      .filter((grid) => (grid[0].match(/<w:gridCol\b/gu) ?? []).length === 2);

    expect(documentXml).toMatch(/w:orient="landscape"/u);
    expect(photoTables).toHaveLength(1);
    expect(boxes).toHaveLength(paragraphs.length);
    expect(documentXml.match(/<w:drawing\b/gu)).toHaveLength(1);
    expect(cells[0]).toContain("第 1 页作文原图");
    expect(cells[0]).not.toContain("修改动作：");
    for (const [index, box] of boxes.entries()) {
      expect(box).toContain(`改好第 ${index + 1} 段。`);
      expect(box).toContain("改后全段：");
      expect(box).toContain(`w:fill="${BOX_FILL_HEX}"`);
      expect(box).toContain('w:themeColor="accent3"');
      expect(box).toContain(`w:themeTint="${ACCENT3_LIGHTER_60_TINT}"`);
      expect(box).toContain('w:themeFill="accent3"');
      expect(box).toContain(`w:themeFillTint="${ACCENT3_LIGHTER_60_TINT}"`);
      expect(box).not.toContain("问题描述");
      expect(box).not.toContain("修改示例");
    }
    expect(theme).toContain(`<a:accent3><a:srgbClr val="${ACCENT3_BASE_HEX}"/></a:accent3>`);
    expect(await zip.file("[Content_Types].xml")?.async("string")).toContain("/word/theme/theme1.xml");
  });

  it("结构归组后横向文本框数量等于组数而不是原文段数", async () => {
    installBrowserExport();
    const review = fixture();
    const originals = ["开篇。", "还在开篇。", "经过一。", "经过二。", "经过三。", "感悟。", "收束。"];
    review.images = [{ id: 11, position: 0, width: 1200, height: 1600, mimeType: "image/png" }];
    review.ocr = {
      version: 2,
      ocrRevision: 1,
      editedAt: null,
      pages: [{ pageIndex: 0, text: originals.join(""), readable: true, warnings: [] }],
      paragraphs: originals.map((text, index) => ({
        id: `paragraph-${index + 1}`,
        paragraphIndex: index,
        text,
        segments: [{ pageIndex: 0, x: 0.1, y: 0.05 + index * 0.1, width: 0.6, height: 0.08 }],
      })),
    };
    const ranges = [
      [1, 2],
      [3, 3],
      [4, 5],
      [6, 6],
      [7, 7],
    ];
    review.report = {
      ...(review.report as object),
      rewrittenEssay: ranges.map((_, index) => `范文第${index + 1}段。`),
      paragraphReviews: ranges.map(([start, end], index) => ({
        paragraphId: `paragraph-${start}`,
        sourceParagraphStart: start,
        sourceParagraphEnd: end,
        suggestions: [{ advice: `改好第 ${index + 1} 组。` }],
        revisedText: `范文第${index + 1}段。`,
      })),
    };
    const { documentXml } = await unpack(review);
    const cells = documentXml.split(/<w:tc[\s>]/u).slice(1);
    const boxes = cells.filter((cell) => cell.includes("修改动作："));

    expect(documentXml).toMatch(/w:orient="landscape"/u);
    expect(boxes).toHaveLength(ranges.length);
    expect(boxes[0]).toContain("对应原文第 1–2 段");
    expect(boxes[2]).toContain("对应原文第 4–5 段");
    expect(boxes[4]).toContain("对应原文第 7 段");
    expect(documentXml).not.toContain("改好第 6 组");
  });

  it("同段多条建议时横向文本框数量仍等于段数", async () => {
    installBrowserExport();
    const review = fixture();
    const paragraphs = ["开篇。", "经过。", "转折。", "感悟。", "收束。"];
    review.images = [{ id: 11, position: 0, width: 1200, height: 1600, mimeType: "image/png" }];
    review.ocr = {
      version: 2,
      ocrRevision: 1,
      editedAt: null,
      pages: [{ pageIndex: 0, text: paragraphs.join(""), readable: true, warnings: [] }],
      paragraphs: paragraphs.map((text, index) => ({
        id: `paragraph-${index + 1}`,
        paragraphIndex: index,
        text,
        segments: [{ pageIndex: 0, x: 0.1, y: 0.05 + index * 0.1, width: 0.6, height: 0.08 }],
      })),
    };
    review.report = {
      ...(review.report as object),
      paragraphReviews: paragraphs.map((text, index) => ({
        paragraphId: `paragraph-${index + 1}`,
        suggestions: index === 0
          ? [
            { advice: "补听觉" },
            { advice: "补动作" },
            { advice: "收束主题" },
          ]
          : [{ advice: "本段无需修改" }],
        revisedText: index === 0 ? "开篇改后。经过保留。" : text,
      })),
    };
    const { documentXml } = await unpack(review);
    const cells = documentXml.split(/<w:tc[\s>]/u).slice(1);
    const boxes = cells.filter((cell) => cell.includes("修改动作："));

    expect(boxes).toHaveLength(paragraphs.length);
    expect(boxes[0]).toContain("1. 补听觉");
    expect(boxes[0]).toContain("2. 补动作");
    expect(boxes[0]).toContain("3. 收束主题");
    expect(boxes[0].match(/改后全段：/gu)).toHaveLength(1);
    expect(boxes[0]).toContain("开篇改后。");
    expect(boxes[1]).toContain("修改动作：本段无需修改");
    expect(boxes[1]).toContain("改后全段：");
    expect(boxes[1]).toContain("经过。");
  });

  it("框内容过长时缩小字号并保留全文", async () => {
    installBrowserExport();
    const review = fixture();
    const revised = `我终于走上台。${"灯光一直很亮，我还是迈了出去。".repeat(80)}`;
    review.images = [review.images[0]];
    review.ocr = {
      version: 2,
      ocrRevision: 1,
      editedAt: null,
      pages: [{ pageIndex: 0, text: "我慢慢走，登上舞台。", readable: true, warnings: [] }],
      paragraphs: [{
        id: "paragraph-1",
        paragraphIndex: 0,
        text: "我慢慢走，登上舞台。",
        segments: [{ pageIndex: 0, x: 0.1, y: 0.2, width: 0.6, height: 0.2 }],
      }],
    };
    review.report = {
      ...(review.report as object),
      paragraphReviews: [{
        paragraphId: "paragraph-1",
        suggestions: [{ advice: "写清迈步。" }],
        revisedText: revised,
      }],
    };
    const paragraph: ExportParagraph = {
      suggestions: [{ advice: "写清迈步。" }],
      revisionRuns: [{ text: revised, changed: true }],
    };
    const halfPoints = chooseBoxHalfPoints([paragraph]);
    const { documentXml } = await unpack(review);

    expect(halfPoints).toBeLessThan(21);
    expect(documentXml).toContain(revised);
    expect(documentXml).toContain(`<w:sz w:val="${halfPoints}"`);
    expect(documentXml).not.toContain('<w:sz w:val="21"');
  });
});
