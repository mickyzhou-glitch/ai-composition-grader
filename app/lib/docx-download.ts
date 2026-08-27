import {
  AlignmentType,
  convertMillimetersToTwip,
  Document,
  ImageRun,
  LevelFormat,
  PageBreak,
  PageOrientation,
  Packer,
  Paragraph,
  ShadingType,
  TextRun,
} from "docx";

import {
  DELIVERY_STYLE,
  type DeliveryDocument,
  type DeliveryParagraph,
} from "@/src/delivery/contracts";
import type { RevisionRun } from "@/src/revisions/revision-diff";

import type { DeliveryPage, DeliveryPageBlock } from "./delivery-pagination";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const SANS_FONT = {
  ascii: "Microsoft YaHei",
  hAnsi: "Microsoft YaHei",
  eastAsia: "微软雅黑",
};
const KAITI_FONT = {
  ascii: "KaiTi",
  hAnsi: "KaiTi",
  eastAsia: "楷体",
};

function points(value: number): number {
  return value * 2;
}

function pixelsFromMillimeters(value: number): number {
  return value * 96 / 25.4;
}

function paragraphForNumber(document: DeliveryDocument, paragraphNumber: number) {
  const paragraph = document.paragraphs.find((candidate) => (
    candidate.paragraphNumber === paragraphNumber
  ));
  if (!paragraph) throw new Error("逐段交付内容不完整");
  return paragraph;
}

function titleParagraph(title: string) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    keepNext: true,
    spacing: { after: convertMillimetersToTwip(7) },
    children: [new TextRun({
      text: title,
      bold: true,
      color: DELIVERY_STYLE.colors.text,
      font: KAITI_FONT,
      size: points(DELIVERY_STYLE.fontPt.title),
    })],
  });
}

function headingParagraph(text: string) {
  return new Paragraph({
    keepNext: true,
    spacing: {
      before: convertMillimetersToTwip(2),
      after: convertMillimetersToTwip(2),
    },
    children: [new TextRun({
      text,
      color: DELIVERY_STYLE.colors.text,
      font: SANS_FONT,
      size: points(DELIVERY_STYLE.fontPt.section),
    })],
  });
}

function cropParagraph(
  paragraph: DeliveryParagraph,
  block: Extract<DeliveryPageBlock, { kind: "crop" }>,
) {
  const crop = paragraph.crops[block.cropIndex];
  if (!crop) throw new Error("原文裁图内容不完整");
  const alt = `第 ${paragraph.paragraphNumber} 段原文裁图，第 ${crop.pageIndex + 1} 页`;
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 0 },
    children: [new ImageRun({
      type: "png",
      data: crop.bytes.slice(),
      transformation: {
        width: pixelsFromMillimeters(block.widthMm),
        height: pixelsFromMillimeters(block.heightMm),
      },
      altText: { name: alt, title: alt, description: alt },
    })],
  });
}

function suggestionParagraph(
  paragraph: DeliveryParagraph,
  block: Extract<DeliveryPageBlock, { kind: "suggestion" }>,
) {
  const suggestion = paragraph.suggestions[block.suggestionIndex];
  if (!suggestion) throw new Error("修改建议内容不完整");
  const runOptions = {
    color: DELIVERY_STYLE.colors.text,
    font: SANS_FONT,
    size: points(DELIVERY_STYLE.fontPt.suggestion),
  } as const;
  return new Paragraph({
    numbering: {
      reference: "paragraph-suggestions",
      level: 0,
      instance: paragraph.paragraphNumber,
    },
    shading: { fill: DELIVERY_STYLE.colors.suggestion, type: ShadingType.CLEAR },
    spacing: { before: 0, after: 0, line: 300 },
    keepLines: true,
    children: [
      new TextRun({ text: `问题：${suggestion.problem}`, ...runOptions }),
      new TextRun({ text: `动作：${suggestion.advice}`, break: 1, ...runOptions }),
      new TextRun({ text: `示例：${suggestion.example}`, break: 1, ...runOptions }),
    ],
  });
}

function revisionTextRun(run: RevisionRun) {
  const changed = run.kind === "inserted" || run.kind === "deleted";
  return new TextRun({
    text: run.text,
    font: KAITI_FONT,
    size: points(DELIVERY_STYLE.fontPt.revision),
    color: changed ? DELIVERY_STYLE.colors.change : DELIVERY_STYLE.colors.text,
    strike: run.kind === "deleted",
  });
}

function revisionParagraph(block: Extract<DeliveryPageBlock, { kind: "revision-lines" }>) {
  return new Paragraph({
    spacing: { before: 0, after: 0, line: 320 },
    keepLines: true,
    children: block.runs.map(revisionTextRun),
  });
}

function headingText(block: Extract<
  DeliveryPageBlock,
  { kind: "paragraph-heading" | "suggestion-heading" | "revision-heading" }
>) {
  if (block.kind === "paragraph-heading") {
    return `【第 ${block.paragraphNumber} 段${block.continued ? "（续）" : ""}】`;
  }
  if (block.kind === "suggestion-heading") {
    return `【修改建议${block.continued ? "（续）" : ""}】`;
  }
  return `【修改后段落${block.continued ? "（续）" : ""}】`;
}

function pageParagraphs(document: DeliveryDocument, page: DeliveryPage): Paragraph[] {
  const children: Paragraph[] = [];
  if (page.hasDocumentTitle) children.push(titleParagraph(document.title));
  let paragraphNumber = 0;

  for (const block of page.blocks) {
    if (block.kind === "paragraph-heading") {
      paragraphNumber = block.paragraphNumber;
      children.push(headingParagraph(headingText(block)));
      continue;
    }
    const paragraph = paragraphForNumber(document, paragraphNumber);
    if (block.kind === "crop") {
      children.push(cropParagraph(paragraph, block));
    } else if (block.kind === "suggestion-heading" || block.kind === "revision-heading") {
      children.push(headingParagraph(headingText(block)));
    } else if (block.kind === "suggestion") {
      children.push(suggestionParagraph(paragraph, block));
    } else {
      children.push(revisionParagraph(block));
    }
  }
  return children;
}

export async function createReviewDocx(
  delivery: DeliveryDocument,
  pages: DeliveryPage[],
): Promise<Blob> {
  const children = pages.flatMap((page, index) => [
    ...(index === 0 ? [] : [new Paragraph({ children: [new PageBreak()] })]),
    ...pageParagraphs(delivery, page),
  ]);
  const document = new Document({
    creator: "AI 作业批改助手",
    title: delivery.title,
    subject: "作文逐段批改",
    numbering: {
      config: [{
        reference: "paragraph-suggestions",
        levels: [{
          level: 0,
          format: LevelFormat.DECIMAL,
          text: "%1.",
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: {
              indent: {
                left: convertMillimetersToTwip(8),
                hanging: convertMillimetersToTwip(4),
              },
            },
          },
        }],
      }],
    },
    sections: [{
      properties: {
        page: {
          size: {
            width: convertMillimetersToTwip(DELIVERY_STYLE.page.widthMm),
            height: convertMillimetersToTwip(DELIVERY_STYLE.page.heightMm),
            orientation: PageOrientation.PORTRAIT,
          },
          margin: {
            top: convertMillimetersToTwip(DELIVERY_STYLE.page.marginYmm),
            right: convertMillimetersToTwip(DELIVERY_STYLE.page.marginXmm),
            bottom: convertMillimetersToTwip(DELIVERY_STYLE.page.marginYmm),
            left: convertMillimetersToTwip(DELIVERY_STYLE.page.marginXmm),
          },
        },
      },
      children,
    }],
  });
  const blob = await Packer.toBlob(document);
  return blob.type === DOCX_MIME ? blob : new Blob([blob], { type: DOCX_MIME });
}
