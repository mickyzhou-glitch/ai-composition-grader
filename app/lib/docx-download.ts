import {
  AlignmentType,
  convertMillimetersToTwip,
  Document,
  ImageRun,
  PageBreak,
  PageOrientation,
  Packer,
  Paragraph,
  ShadingType,
  TextRun,
  UnderlineType,
} from "docx";

import { DELIVERY_STYLE } from "@/src/delivery/contracts";

import {
  buildExportReportContent,
  EXPORT_KAITI_FACE,
  EXPORT_KAITI_FONT,
  exportFontSample,
  exportOriginalImageUrl,
  exportParagraphRuns,
  layoutRewrittenEssay,
  type ExportImage,
  type ExportParagraph,
  type ExportReportContent,
  type ExportReviewSource,
  type ExportRunStyle,
  type RewrittenEssayPage,
} from "./export-report-content";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const KAITI_FONT = {
  ascii: "KaiTi",
  hAnsi: "KaiTi",
  eastAsia: "楷体",
};

function points(value: number): number {
  return value * 2;
}

function pageBreakParagraph() {
  return new Paragraph({ children: [new PageBreak()] });
}

function imageKind(bytes: Uint8Array, mimeType?: string): "png" | "jpg" | "gif" | "bmp" {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return "gif";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  if (mimeType?.includes("jpeg") || mimeType?.includes("jpg")) return "jpg";
  if (mimeType?.includes("gif")) return "gif";
  if (mimeType?.includes("bmp")) return "bmp";
  return "png";
}

function fittedImageSize(image: ExportImage) {
  if (!Number.isFinite(image.width) || image.width <= 0
    || !Number.isFinite(image.height) || image.height <= 0) {
    throw new Error("作文照片尺寸无效，无法生成 Word");
  }
  const maxWidth = (DELIVERY_STYLE.page.widthMm - DELIVERY_STYLE.page.marginXmm * 2) * 96 / 25.4;
  const maxHeight = 120 * 96 / 25.4;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
  return {
    width: Math.max(1, Math.round(image.width * scale)),
    height: Math.max(1, Math.round(image.height * scale)),
  };
}

async function loadOriginalImage(reviewId: string, image: ExportImage) {
  const response = await fetch(exportOriginalImageUrl(reviewId, image.id));
  if (!response.ok) throw new Error(`作文照片读取失败（${response.status}）`);
  return new Uint8Array(await response.arrayBuffer());
}

function runOptions(style: ExportRunStyle): {
  bold: boolean;
  color: string;
  underline?: { type: (typeof UnderlineType)["SINGLE"]; color: string };
} {
  if (style === "suggestion") return { bold: true, color: "C00000" };
  if (style === "demonstration") return { bold: true, color: "000000" };
  if (style === "changed") {
    return {
      bold: false,
      color: "1F4E78",
      underline: { type: UnderlineType.SINGLE, color: "1F4E78" },
    };
  }
  return { bold: false, color: "000000" };
}

function textRuns(text: string, style: ExportRunStyle) {
  const options = runOptions(style);
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  return normalized.split("\n").map((line, index) => new TextRun({
    text: line,
    break: index === 0 ? undefined : 1,
    bold: options.bold,
    color: options.color,
    underline: options.underline,
    font: KAITI_FONT,
    size: points(DELIVERY_STYLE.fontPt.suggestion),
  }));
}

function paragraphBlocks(paragraph: ExportParagraph) {
  const runs = exportParagraphRuns(paragraph);
  const [suggestion, ...remainder] = runs;
  if (!suggestion) return [];
  return [
    new Paragraph({
      spacing: { before: 160, after: 40, line: 276 },
      shading: { type: ShadingType.CLEAR, fill: "E7D4A8" },
      children: textRuns(suggestion.text, suggestion.style),
    }),
    new Paragraph({
      spacing: { before: 40, after: 160, line: 320 },
      children: remainder.flatMap((run) => textRuns(run.text, run.style)),
    }),
  ];
}

function imageParagraph(bytes: Uint8Array, image: ExportImage) {
  const alt = `第 ${image.position + 1} 页作文原图`;
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 120 },
    children: [new ImageRun({
      type: imageKind(bytes, image.mimeType),
      data: bytes,
      transformation: fittedImageSize(image),
      altText: { name: alt, title: alt, description: alt },
    })],
  });
}

function essayBlocks(pages: RewrittenEssayPage[]) {
  return pages.flatMap((page, index) => [
    ...(index === 0 ? [] : [pageBreakParagraph()]),
    new Paragraph({
      spacing: { before: 200, after: 160 },
      children: [new TextRun({
        text: page.title,
        bold: true,
        color: "000000",
        font: KAITI_FONT,
        size: points(18),
      })],
    }),
    ...page.lines.filter((line) => line.length > 0).map((line) => new Paragraph({
      spacing: { before: 0, after: 80, line: 360 },
      children: [new TextRun({
        text: line,
        color: "000000",
        font: KAITI_FONT,
        size: points(14),
      })],
    })),
  ]);
}

async function essayMeasurer(sample: string) {
  await Promise.all([
    document.fonts.load(`400 16px ${EXPORT_KAITI_FACE}`, sample),
    document.fonts.load(`700 16px ${EXPORT_KAITI_FACE}`, sample),
  ]);
  const context = document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("当前浏览器不支持生成 Word");
  return (text: string) => {
    context.font = `400 14px ${EXPORT_KAITI_FONT}`;
    return context.measureText(text).width;
  };
}

async function documentChildren(review: ExportReviewSource, content: ExportReportContent) {
  const images = await Promise.all(content.pages.map((page) => loadOriginalImage(review.id, page.image)));
  const children = content.pages.flatMap((page, index) => [
    ...(index === 0 ? [] : [pageBreakParagraph()]),
    imageParagraph(images[index], page.image),
    ...page.paragraphs.flatMap(paragraphBlocks),
  ]);
  if (content.rewrittenEssay.length === 0) return children;
  const essayPages = layoutRewrittenEssay(
    content.rewrittenEssay,
    await essayMeasurer(exportFontSample(content)),
  );
  return [
    ...children,
    ...(children.length > 0 ? [pageBreakParagraph()] : []),
    ...essayBlocks(essayPages),
  ];
}

export async function createReviewDocx(review: ExportReviewSource): Promise<Blob> {
  const content = buildExportReportContent(review);
  const document = new Document({
    creator: "AI 作业批改助手",
    title: content.documentTitle,
    subject: "作文逐段批改",
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
      children: await documentChildren(review, content),
    }],
  });
  const blob = await Packer.toBlob(document);
  return blob.type === DOCX_MIME ? blob : new Blob([blob], { type: DOCX_MIME });
}
