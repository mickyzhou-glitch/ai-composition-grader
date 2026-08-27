import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import type { DeliveryDocument } from "@/src/delivery/contracts";

import { createReviewDocx } from "./docx-download";
import { paginateDeliveryDocument } from "./delivery-pagination";

const PNG_BYTES = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="),
  (character) => character.charCodeAt(0),
);

function crop(pageIndex: number, marker: number) {
  return {
    pageIndex,
    bytes: new Uint8Array([...PNG_BYTES, marker]),
    width: 600,
    height: 900,
  };
}

function fixture(): DeliveryDocument {
  return {
    title: "那一次，我读懂了勇气",
    studentName: "张小明",
    paragraphs: [
      {
        paragraphNumber: 1,
        crops: [crop(0, 1), crop(1, 2), crop(1, 3)],
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
        revisionRuns: [
          { kind: "unchanged", text: "我" },
          { kind: "deleted", text: "慢慢走" },
          { kind: "inserted", text: "攥紧稿纸走" },
          { kind: "punctuation", text: "，" },
          { kind: "unchanged", text: "登上舞台。" },
        ],
      },
      {
        paragraphNumber: 2,
        crops: [crop(2, 4)],
        suggestions: [{
          problem: "结尾与题目呼应不足。",
          advice: "把感受落到对勇气的新理解。",
          example: "原来勇气不是不害怕，而是害怕时仍愿意向前。",
        }],
        revisionRuns: [
          { kind: "unchanged", text: "我明白了" },
          { kind: "deleted", text: "成功" },
          { kind: "inserted", text: "勇气" },
          { kind: "punctuation", text: "。" },
        ],
      },
    ],
  };
}

async function unpack(document: DeliveryDocument) {
  const pages = paginateDeliveryDocument(document);
  const blob = await createReviewDocx(document, pages);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const read = async (path: string) => {
    const file = zip.file(path);
    if (!file) throw new Error(`DOCX 中缺少 ${path}`);
    return file.async("string");
  };
  return {
    blob,
    pages,
    zip,
    documentXml: await read("word/document.xml"),
    numberingXml: await read("word/numbering.xml"),
    relsXml: await read("word/_rels/document.xml.rels"),
    coreXml: await read("docProps/core.xml"),
  };
}

describe("Word 逐段批改文档", () => {
  it("生成 A4 纵向、可编辑且使用真实编号的逐段内容", async () => {
    const delivery = fixture();
    const { blob, pages, documentXml, numberingXml } = await unpack(delivery);

    expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(pages.length).toBeGreaterThan(1);
    expect(documentXml).toMatch(/<w:pgSz[^>]*w:w="11905"[^>]*w:h="16837"/u);
    expect(documentXml).toMatch(/<w:pgMar[^>]*w:top="907"[^>]*w:right="1020"[^>]*w:bottom="907"[^>]*w:left="1020"/u);
    expect(documentXml).not.toContain('<w:pStyle w:val="Title"');
    expect(documentXml).toContain("那一次，我读懂了勇气");
    expect(documentXml).toContain("【第 1 段（续）】");
    expect(documentXml.match(/<w:br w:type="page"\/>/gu)).toHaveLength(pages.length - 1);
    expect(documentXml).toContain("<w:keepNext/>");
    expect(documentXml).toContain("<w:numPr>");
    expect(numberingXml).toContain('w:numFmt w:val="decimal"');
    expect(documentXml).toContain('w:fill="FFF0BD"');
    expect(documentXml).toContain("问题：开头略显概括。");
    expect(documentXml).toContain("动作：补充登台前的具体动作。");
    expect(documentXml).toContain("示例：手心的汗把稿纸浸出了一道浅痕。");
    expect(documentXml).toContain('w:color w:val="C91F32"');
    expect(documentXml).toContain("<w:strike");
    expect(documentXml).toMatch(/w:eastAsia="(?:楷体|KaiTi)"/u);
  });

  it("嵌入全部裁图、写入替代文字且不泄露外部关系或内部信息", async () => {
    const delivery = fixture();
    const { zip, documentXml, relsXml, coreXml } = await unpack(delivery);
    const totalCropCount = delivery.paragraphs.reduce((sum, paragraph) => (
      sum + paragraph.crops.length
    ), 0);
    const media = Object.values(zip.files).filter(({ name, dir }) => (
      name.startsWith("word/media/") && !dir
    ));

    expect(media).toHaveLength(totalCropCount);
    expect(documentXml).toContain('descr="第 1 段原文裁图，第 1 页"');
    expect(documentXml).toContain('descr="第 1 段原文裁图，第 2 页"');
    expect(documentXml).toContain('descr="第 2 段原文裁图，第 3 页"');
    expect(relsXml).not.toContain('TargetMode="External"');
    expect(coreXml).toContain("AI 作业批改助手");
    expect(coreXml).toContain("那一次，我读懂了勇气");
    expect(coreXml).toContain("作文逐段批改");
    expect(coreXml).not.toContain("张小明");
    expect(coreXml).not.toMatch(/openai|deepseek|api[_ -]?key|\/Users\//iu);
  });
});
