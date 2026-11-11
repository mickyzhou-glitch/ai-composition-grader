import {
  AlignmentType,
  convertMillimetersToTwip,
  Document,
  ImageRun,
  LineRuleType,
  PageOrientation,
  Packer,
  Paragraph,
  TextRun,
  UnderlineType,
  WpsShapeRun,
  HorizontalPositionRelativeFrom,
  VerticalPositionRelativeFrom,
  TextWrappingType,
  VerticalAnchor,
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

const PAGE_SHORT_MM = 210;
const PAGE_LONG_MM = 297;
const MARGIN_MM = 12;
// 小四为 12 磅；Word 字号在 OOXML 中以半磅计。
const BODY_HALF_POINTS = 24;
const BOX_LINE_TWIP = 360; // 固定 18 磅，与文本框高度计算使用同一单位。
const BOX_VERTICAL_INSET = 60;
const BOX_HORIZONTAL_INSET = 80;
const BOX_PARAGRAPH_BEFORE = 20;
const BOX_PARAGRAPH_AFTER = 40;
// WPS 对浮动文本框的最后一行会额外使用少量下沉空间；120 twip 会让末行贴边并被裁切。
// 预留 360 twip（18 磅）让楷体小四的字面和下划线都落在框内。
const BOX_HEIGHT_RESERVE = 360;
const graphemeSegmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

const pageWidthTwip = convertMillimetersToTwip(PAGE_LONG_MM);
const pageHeightTwip = convertMillimetersToTwip(PAGE_SHORT_MM);
const marginTwip = convertMillimetersToTwip(MARGIN_MM);
const contentWidthTwip = pageWidthTwip - marginTwip * 2;
const contentHeightTwip = pageHeightTwip - marginTwip * 2;
const leftColumnTwip = Math.round(contentWidthTwip * 0.46);
const rightColumnTwip = contentWidthTwip - leftColumnTwip;

const twipToEmu = (twip: number) => Math.round(twip * 635);

function floatingAt(x: number, y: number) {
  return {
    horizontalPosition: { relative: HorizontalPositionRelativeFrom.MARGIN, offset: twipToEmu(x) },
    verticalPosition: { relative: VerticalPositionRelativeFrom.MARGIN, offset: twipToEmu(y) },
    allowOverlap: true,
    lockAnchor: false,
    layoutInCell: false,
    wrap: { type: TextWrappingType.NONE },
  };
}

function points(value: number): number {
  return value * 2;
}

function nextPageAnchor() {
  return new Paragraph({
    pageBreakBefore: true,
    spacing: { before: 0, after: 0, line: 1 },
    children: [new TextRun({ text: "", size: 1 })],
  });
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
  // Leave room below the floating photo for WPS page layout and the next page anchor.
  const maxHeight = twipToPx(contentHeightTwip - 800);
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
  if (style === "suggestion") return { bold: false, color: "C00000" };
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
    snapToGrid: false,
  }));
}

function graphemeCount(value: string) {
  return Array.from(graphemeSegmenter.segment(value), () => 1).length;
}

type BoxRun = ReturnType<typeof exportParagraphRuns>[number];

function boxRunGroups(runs: BoxRun[]) {
  return [runs.filter((run) => run.style === "suggestion"), runs.filter((run) => run.style !== "suggestion")]
    .filter((group) => group.length > 0);
}

function boxCharsPerLine(width: number, halfPoints: number) {
  // 在内边距之外预留少量行宽，兼容 Word/WPS 的中文禁则和字体替换。
  return Math.max(1, Math.floor((width - BOX_HORIZONTAL_INSET * 2 - 120) / (halfPoints * 10)));
}

// 原生浮动文本框不能跨页；超长段落按可容纳的行数拆成续框，保留全部文字和样式。
function splitBoxRuns(paragraph: ExportParagraph, width: number, halfPoints: number): BoxRun[][] {
  const charsPerLine = boxCharsPerLine(width, halfPoints);
  const overhead = BOX_VERTICAL_INSET * 2 + BOX_HEIGHT_RESERVE
    + (BOX_PARAGRAPH_BEFORE + BOX_PARAGRAPH_AFTER) * 2;
  // 为建议/正文的独立段落边界和末尾空行再保留两行。
  const maxLines = Math.max(1, Math.floor((contentHeightTwip - overhead) / BOX_LINE_TWIP) - 2);
  const chunks: BoxRun[][] = [[]];
  let line = 1;
  let column = 0;
  for (const run of exportParagraphRuns(paragraph)) {
    const text = run.style === "changed" || run.style === "plain"
      ? run.text.replace(/[\r\n\u2028\u2029]+/gu, "") : run.text;
    for (const { segment } of graphemeSegmenter.segment(text)) {
      if (segment !== "\n" && column >= charsPerLine) { line += 1; column = 0; }
      if (line > maxLines) { chunks.push([]); line = 1; column = 0; }
      const chunk = chunks[chunks.length - 1];
      const last = chunk[chunk.length - 1];
      if (last?.style === run.style) last.text += segment;
      else chunk.push({ ...run, text: segment });
      if (segment === "\n") { line += 1; column = 0; }
      else column += 1;
    }
  }
  return chunks;
}

function boxHeight(runs: BoxRun[], width: number, halfPoints: number) {
  const charsPerLine = boxCharsPerLine(width, halfPoints);
  const paragraphsHeight = boxRunGroups(runs).reduce((height, group) => {
    // 与 textRuns 的实际输出一致：每个 run 末尾的换行不写入文档。
    const text = group.map((run) => run.text.endsWith("\n") ? run.text.slice(0, -1) : run.text).join("");
    const lines = text.split("\n").reduce((count, line) => count + Math.max(1, Math.ceil(graphemeCount(line) / charsPerLine)), 0);
    return height + lines * BOX_LINE_TWIP + BOX_PARAGRAPH_BEFORE + BOX_PARAGRAPH_AFTER;
  }, 0);
  return paragraphsHeight + BOX_VERTICAL_INSET * 2 + BOX_HEIGHT_RESERVE;
}

function paragraphBox(runs: BoxRun[], width: number, height: number, y: number, halfPoints: number, name: string) {
  const children = boxRunGroups(runs).map((group) => new Paragraph({
    alignment: AlignmentType.LEFT,
    run: { font: KAITI_FONT, size: halfPoints, snapToGrid: false },
    spacing: { before: BOX_PARAGRAPH_BEFORE, after: BOX_PARAGRAPH_AFTER, line: BOX_LINE_TWIP, lineRule: LineRuleType.EXACT },
    children: group.flatMap((run) => textRuns(run.text, run.style, halfPoints)),
  }));
  return new WpsShapeRun({
    type: "wps",
    transformation: { width: twipToPx(width), height: twipToPx(height) },
    floating: floatingAt(leftColumnTwip + 80, y),
    altText: { name, title: name, description: name },
    solidFill: { type: "rgb", value: BOX_FILL_HEX },
    outline: { type: "solidFill", solidFillType: "rgb", value: ACCENT3_BASE_HEX, width: 12700 },
    bodyProperties: {
      verticalAnchor: VerticalAnchor.TOP,
      noAutoFit: true,
      margins: {
        top: twipToEmu(BOX_VERTICAL_INSET), bottom: twipToEmu(BOX_VERTICAL_INSET),
        left: twipToEmu(BOX_HORIZONTAL_INSET), right: twipToEmu(BOX_HORIZONTAL_INSET),
      },
    },
    children,
  });
}

function photoPages(bytes: Uint8Array, page: ExportReportPage) {
  const halfPoints = BODY_HALF_POINTS;
  const boxWidth = rightColumnTwip - 160;
  const pages: Paragraph[] = [];
  let y = 0;
  let drawings: Array<ImageRun | WpsShapeRun> = [];
  const startPage = () => {
    const alt = `第 ${page.image.position + 1} 页作文原图`;
    drawings = [new ImageRun({
      type: imageKind(bytes, page.image.mimeType),
      data: bytes,
      transformation: fittedImageSize(page.image),
      floating: floatingAt(0, 0),
      altText: { name: alt, title: alt, description: alt },
    })];
    y = 0;
  };
  const finishPage = () => pages.push(new Paragraph({
    spacing: { before: 0, after: 0, line: 20 },
    children: drawings,
  }));
  startPage();
  page.paragraphs.forEach((paragraph, index) => {
    splitBoxRuns(paragraph, boxWidth, halfPoints).forEach((runs, part) => {
      const height = boxHeight(runs, boxWidth, halfPoints);
      if (y > 0 && y + height > contentHeightTwip) { finishPage(); startPage(); }
      drawings.push(paragraphBox(runs, boxWidth, height, y, halfPoints, `第 ${index + 1} 段批注${part > 0 ? "（续）" : ""}`));
      y += height + 80;
    });
  });
  finishPage();
  return pages.flatMap((paragraph, index) => index === 0 ? [paragraph] : [nextPageAnchor(), paragraph]);
}

/** 段内文字去掉换行，避免 Word/WPS 里出现硬换行。 */
export function singleLineParagraphText(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/gu, "").replace(/^[\s\u3000]+/u, "").trimEnd();
}

/**
 * 完整范文：每个自然段一个 w:p，段内不插换行，首行缩进两字，由 Word/WPS 自动折行和分页。
 * 不复用 PDF 的按宽度折行结果（那会把每一行写成独立段落，行尾单字另起一行）。
 */
function essayBlocks(paragraphs: readonly string[], startsNewPage: boolean) {
  return [
    new Paragraph({
      pageBreakBefore: startsNewPage,
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
      spacing: { before: 0, after: 80, line: BOX_LINE_TWIP, lineRule: LineRuleType.EXACT },
      run: { font: KAITI_FONT, size: BODY_HALF_POINTS, snapToGrid: false },
      indent: { firstLineChars: 200 },
      children: [new TextRun({
        text,
        color: "000000",
        font: KAITI_FONT,
        size: BODY_HALF_POINTS,
      })],
    })),
  ];
}

async function documentChildren(review: ExportReviewSource, content: ExportReportContent) {
  const images = await Promise.all(content.pages.map((page) => loadOriginalImage(review.id, page.image)));
  const children = content.pages.flatMap((page, index) => [
    ...(index === 0 ? [] : [nextPageAnchor()]),
    ...photoPages(images[index], page),
  ]);
  if (content.rewrittenEssay.length === 0) return children;
  return [
    ...children,
    ...essayBlocks(content.rewrittenEssay, children.length > 0),
  ];
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
  let drawingId = 0;
  const documentXml = (await documentFile.async("string")).replace(
    new RegExp(`<a:srgbClr val="${BOX_FILL_HEX}"\\s*/>`, "g"),
    `<a:schemeClr val="accent3"><a:tint val="60000"/></a:schemeClr>`,
  )
    // docx 9.7 的形状输出把填充放在线条之后，并重复使用对象 ID；在打包前规范化。
    .replace(/<wps:spPr([^>]*)>([\s\S]*?)<\/wps:spPr>/g, (_, attrs: string, body: string) => {
      const fill = body.match(/<a:solidFill>(?:(?!<a:solidFill>)[\s\S])*?<\/a:solidFill>$/)?.[0];
      if (!fill) return `<wps:spPr${attrs}>${body}</wps:spPr>`;
      const normalized = body.replace("<a:noFill/>", "").replace(fill, "");
      return `<wps:spPr${attrs}>${normalized.replace("<a:ln", `${fill}<a:ln`)}</wps:spPr>`;
    })
    .replace(/<wp:anchor\b[\s\S]*?<\/wp:anchor>/g, (anchor) => anchor.includes("<wps:wsp>")
      ? anchor.replace('noChangeAspect="1"', 'noChangeAspect="0"') : anchor)
    .replace(/<wp:docPr\s+id="\d+"/g, () => `<wp:docPr id="${++drawingId}"`);
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
    styles: { default: { document: { run: { font: KAITI_FONT, size: BODY_HALF_POINTS } } } },
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
