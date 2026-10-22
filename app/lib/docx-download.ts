import {
  AlignmentType,
  BorderStyle,
  convertMillimetersToTwip,
  Document,
  ImageRun,
  PageBreak,
  PageOrientation,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  UnderlineType,
  VerticalAlignTable,
  WidthType,
  type IBorderOptions,
} from "docx";
import JSZip from "jszip";

import {
  buildExportReportContent,
  rewrittenEssayHeading,
  exportOriginalImageUrl,
  exportParagraphRuns,
  type ExportImage,
  type ExportParagraph,
  type ExportReportContent,
  type ExportReportPage,
  type ExportReviewSource,
  type ExportRunStyle,
} from "./export-report-content";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const KAITI_FONT = {
  ascii: "KaiTi",
  hAnsi: "KaiTi",
  eastAsia: "楷体",
};

/** 当前建议底色。主题色着色失败时，Word/WPS 仍用这个浅黄。 */
export const BOX_FILL_HEX = "E7D4A8";
/**
 * 着色 3 的巧克力黄底色。浅色 60% 的线性结果是
 * 底色 × 0.4 + 白 × 0.6 = E7D4A8。
 */
export const ACCENT3_BASE_HEX = "C39426";
/** Word「浅色 60%」写进 themeTint / themeFillTint 的值：(1 - 0.6) × 255 = 0x66。 */
export const ACCENT3_LIGHTER_60_TINT = "66";

const PAGE_SHORT_MM = 210;
const PAGE_LONG_MM = 297;
const MARGIN_MM = 12;
const MAX_BOX_HALF_POINTS = 21;
const MIN_BOX_HALF_POINTS = 16;
const graphemeSegmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

const pageWidthTwip = convertMillimetersToTwip(PAGE_LONG_MM);
const pageHeightTwip = convertMillimetersToTwip(PAGE_SHORT_MM);
const marginTwip = convertMillimetersToTwip(MARGIN_MM);
const contentWidthTwip = pageWidthTwip - marginTwip * 2;
const contentHeightTwip = pageHeightTwip - marginTwip * 2;
const leftColumnTwip = Math.round(contentWidthTwip * 0.46);
const rightColumnTwip = contentWidthTwip - leftColumnTwip;
const boxInnerWidthTwip = rightColumnTwip - 200;

const noBorder: IBorderOptions = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = {
  top: noBorder,
  bottom: noBorder,
  left: noBorder,
  right: noBorder,
  insideHorizontal: noBorder,
  insideVertical: noBorder,
};
const boxBorder: IBorderOptions = { style: BorderStyle.SINGLE, size: 8, color: ACCENT3_BASE_HEX };
const boxBorders = {
  top: boxBorder,
  bottom: boxBorder,
  left: boxBorder,
  right: boxBorder,
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

function twipToPx(twip: number) {
  return twip / 1440 * 96;
}

function fittedImageSize(image: ExportImage) {
  if (!Number.isFinite(image.width) || image.width <= 0
    || !Number.isFinite(image.height) || image.height <= 0) {
    throw new Error("作文照片尺寸无效，无法生成 Word");
  }
  const maxWidth = twipToPx(leftColumnTwip - 120);
  const maxHeight = twipToPx(contentHeightTwip - 80);
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

function textRuns(text: string, style: ExportRunStyle, halfPoints: number) {
  const options = runOptions(style);
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  return normalized.split("\n").map((line, index) => new TextRun({
    text: line,
    break: index === 0 ? undefined : 1,
    bold: options.bold,
    color: options.color,
    underline: options.underline,
    font: KAITI_FONT,
    size: halfPoints,
  }));
}

function graphemeCount(value: string) {
  return Array.from(graphemeSegmenter.segment(value), () => 1).length;
}

function estimateBoxesHeight(paragraphs: ExportParagraph[], halfPoints: number, columnWidthTwip: number) {
  const emTwip = halfPoints * 10;
  const charsPerLine = Math.max(1, Math.floor((columnWidthTwip - 200) / emTwip));
  const lineTwip = emTwip * 1.45;
  return paragraphs.reduce((height, paragraph) => {
    const text = exportParagraphRuns(paragraph).map((run) => run.text).join("");
    const lines = text.split("\n").reduce((count, line) => (
      count + Math.max(1, Math.ceil(graphemeCount(line) / charsPerLine))
    ), 0);
    return height + lines * lineTwip + 220;
  }, 0);
}

export function chooseBoxHalfPoints(
  paragraphs: ExportParagraph[],
  columnWidthTwip = boxInnerWidthTwip,
  availableHeightTwip = contentHeightTwip,
) {
  if (paragraphs.length === 0) return MAX_BOX_HALF_POINTS;
  for (let half = MAX_BOX_HALF_POINTS; half > MIN_BOX_HALF_POINTS; half -= 1) {
    if (estimateBoxesHeight(paragraphs, half, columnWidthTwip) <= availableHeightTwip) return half;
  }
  return MIN_BOX_HALF_POINTS;
}

function paragraphBox(paragraph: ExportParagraph, width: number, halfPoints: number) {
  const runs = exportParagraphRuns(paragraph);
  const [suggestion, ...remainder] = runs;
  const line = Math.round(halfPoints * 13.5);
  const children = suggestion
    ? [
      new Paragraph({
        spacing: { before: 40, after: 40, line },
        children: textRuns(suggestion.text, suggestion.style, halfPoints),
      }),
      new Paragraph({
        spacing: { before: 20, after: 40, line },
        // 「改后全段」是一个自然段：只保留标签行自带的换行，正文里的换行去掉。
        children: remainder.flatMap((run) => textRuns(
          run.style === "changed" || run.style === "plain" ? run.text.replace(/[\r\n\u2028\u2029]+/gu, "") : run.text,
          run.style,
          halfPoints,
        )),
      }),
    ]
    : [new Paragraph({})];
  return new Table({
    width: { size: width, type: WidthType.DXA },
    columnWidths: [width],
    layout: TableLayoutType.FIXED,
    borders: boxBorders,
    rows: [new TableRow({
      cantSplit: false,
      children: [new TableCell({
        width: { size: width, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: BOX_FILL_HEX },
        margins: { top: 60, bottom: 60, left: 80, right: 80 },
        borders: boxBorders,
        children,
      })],
    })],
  });
}

function imageParagraph(bytes: Uint8Array, image: ExportImage) {
  const alt = `第 ${image.position + 1} 页作文原图`;
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 0 },
    children: [new ImageRun({
      type: imageKind(bytes, image.mimeType),
      data: bytes,
      transformation: fittedImageSize(image),
      altText: { name: alt, title: alt, description: alt },
    })],
  });
}

function photoTable(bytes: Uint8Array, page: ExportReportPage) {
  const halfPoints = chooseBoxHalfPoints(page.paragraphs);
  const boxWidth = rightColumnTwip - 160;
  const boxes = page.paragraphs.flatMap((paragraph, index) => [
    ...(index === 0 ? [] : [new Paragraph({ spacing: { before: 80 } })]),
    paragraphBox(paragraph, boxWidth, halfPoints),
  ]);
  return new Table({
    width: { size: contentWidthTwip, type: WidthType.DXA },
    columnWidths: [leftColumnTwip, rightColumnTwip],
    layout: TableLayoutType.FIXED,
    borders: noBorders,
    rows: [new TableRow({
      cantSplit: false,
      children: [
        new TableCell({
          width: { size: leftColumnTwip, type: WidthType.DXA },
          verticalAlign: VerticalAlignTable.TOP,
          borders: noBorders,
          margins: { top: 0, bottom: 0, left: 0, right: 80 },
          children: [imageParagraph(bytes, page.image)],
        }),
        new TableCell({
          width: { size: rightColumnTwip, type: WidthType.DXA },
          verticalAlign: VerticalAlignTable.TOP,
          borders: noBorders,
          margins: { top: 0, bottom: 0, left: 80, right: 0 },
          children: boxes.length > 0 ? boxes : [new Paragraph({})],
        }),
      ],
    })],
  });
}

/** 段内文字去掉换行，避免 Word/WPS 里出现硬换行。 */
export function singleLineParagraphText(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/gu, "").replace(/^[\s\u3000]+/u, "").trimEnd();
}

/**
 * 完整范文：每个自然段一个 w:p，段内不插换行，首行缩进两字，由 Word/WPS 自动折行和分页。
 * 不复用 PDF 的按宽度折行结果（那会把每一行写成独立段落，行尾单字另起一行）。
 */
function essayBlocks(paragraphs: readonly string[]) {
  return [
    new Paragraph({
      spacing: { before: 200, after: 160 },
      children: [new TextRun({
        text: rewrittenEssayHeading(false),
        bold: true,
        color: "000000",
        font: KAITI_FONT,
        size: points(18),
      })],
    }),
    ...paragraphs.map(singleLineParagraphText).filter((text) => text.length > 0).map((text) => new Paragraph({
      spacing: { before: 0, after: 80, line: 360 },
      indent: { firstLineChars: 200 },
      children: [new TextRun({
        text,
        color: "000000",
        font: KAITI_FONT,
        size: points(14),
      })],
    })),
  ];
}

async function documentChildren(review: ExportReviewSource, content: ExportReportContent) {
  const images = await Promise.all(content.pages.map((page) => loadOriginalImage(review.id, page.image)));
  const children = content.pages.flatMap((page, index) => [
    ...(index === 0 ? [] : [pageBreakParagraph()]),
    photoTable(images[index], page),
  ]);
  if (content.rewrittenEssay.length === 0) return children;
  return [
    ...children,
    ...(children.length > 0 ? [pageBreakParagraph()] : []),
    ...essayBlocks(content.rewrittenEssay),
  ];
}

function chocolateBoxShading(tag: string) {
  if (!tag.includes(`w:fill="${BOX_FILL_HEX}"`)) return tag;
  return `<w:shd w:val="clear" w:color="auto" w:fill="${BOX_FILL_HEX}" w:themeColor="accent3" w:themeTint="${ACCENT3_LIGHTER_60_TINT}" w:themeFill="accent3" w:themeFillTint="${ACCENT3_LIGHTER_60_TINT}"/>`;
}

function themeXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="作文批改">
  <a:themeElements>
    <a:clrScheme name="作文批改">
      <a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
      <a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
      <a:dk2><a:srgbClr val="44546A"/></a:dk2>
      <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
      <a:accent1><a:srgbClr val="5B9BD5"/></a:accent1>
      <a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
      <a:accent3><a:srgbClr val="${ACCENT3_BASE_HEX}"/></a:accent3>
      <a:accent4><a:srgbClr val="FFC000"/></a:accent4>
      <a:accent5><a:srgbClr val="4472C4"/></a:accent5>
      <a:accent6><a:srgbClr val="70AD47"/></a:accent6>
      <a:hlink><a:srgbClr val="0563C1"/></a:hlink>
      <a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
    </a:clrScheme>
    <a:fontScheme name="Office">
      <a:majorFont>
        <a:latin typeface="Calibri Light"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="Calibri"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
      </a:minorFont>
    </a:fontScheme>
    <a:fmtScheme name="Office">
      <a:fillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:fillStyleLst>
      <a:lnStyleLst>
        <a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
        <a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>
      </a:lnStyleLst>
      <a:effectStyleLst>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
        <a:effectStyle><a:effectLst/></a:effectStyle>
      </a:effectStyleLst>
      <a:bgFillStyleLst>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
        <a:solidFill><a:schemeClr val="phClr"/></a:solidFill>
      </a:bgFillStyleLst>
    </a:fmtScheme>
  </a:themeElements>
  <a:objectDefaults/>
  <a:extraClrSchemeLst/>
</a:theme>`;
}

async function applyChocolateTheme(blob: Blob): Promise<Blob> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const documentFile = zip.file("word/document.xml");
  const relsFile = zip.file("word/_rels/document.xml.rels");
  const typesFile = zip.file("[Content_Types].xml");
  if (!documentFile || !relsFile || !typesFile) {
    throw new Error("当前浏览器不支持生成 Word");
  }
  const documentXml = (await documentFile.async("string")).replace(
    /<w:shd\b[^>]*\/>/g,
    chocolateBoxShading,
  );
  zip.file("word/document.xml", documentXml);
  zip.file("word/theme/theme1.xml", themeXml());

  const rels = await relsFile.async("string");
  if (!rels.includes("/theme")) {
    const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((match) => Number(match[1]));
    const relationshipId = `rId${Math.max(0, ...ids) + 1}`;
    zip.file("word/_rels/document.xml.rels", rels.replace(
      "</Relationships>",
      `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`,
    ));
  }
  const types = await typesFile.async("string");
  if (!types.includes("/word/theme/theme1.xml")) {
    zip.file("[Content_Types].xml", types.replace(
      "</Types>",
      `<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`,
    ));
  }
  const bytes = await zip.generateAsync({ type: "uint8array" });
  return new Blob([Uint8Array.from(bytes)], { type: DOCX_MIME });
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
            width: convertMillimetersToTwip(PAGE_SHORT_MM),
            height: convertMillimetersToTwip(PAGE_LONG_MM),
            orientation: PageOrientation.LANDSCAPE,
          },
          margin: {
            top: marginTwip,
            right: marginTwip,
            bottom: marginTwip,
            left: marginTwip,
          },
        },
      },
      children: await documentChildren(review, content),
    }],
  });
  const blob = await Packer.toBlob(document);
  const typed = blob.type === DOCX_MIME ? blob : new Blob([blob], { type: DOCX_MIME });
  return applyChocolateTheme(typed);
}
