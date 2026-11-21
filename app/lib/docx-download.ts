import {
  AlignmentType,
  BorderStyle,
  convertMillimetersToTwip,
  Document,
  ImageRun,
  LineRuleType,
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
import type { RevisionUnderline } from "@/src/revisions/revision-diff";

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
  type ExportTextRun,
} from "./export-report-content";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
/**
 * Word/WPS 字体策略（只写系统常见、可跨平台回退的字体）：
 * - eastAsia 用「宋体」：Windows 自带 SimSun、WPS 自带宋体；Mac 版 Word/WPS 会把「宋体」
 *   映射到系统的 Songti SC / STSong。以前写的 KaiTi/楷体 在 Mac 上没有，WPS 提示「缺失字体」，
 *   替换字体的字宽不一致，排版也跟着变。
 * - ascii/hAnsi/cs 用 Times New Roman，各平台都有，数字、标点、西文不会再去找缺失字体。
 * - hint=eastAsia：中英混排时，有歧义的字符（引号、破折号等）一律按中文字体排。
 */
export const EXPORT_DOCX_FONT = {
  ascii: "Times New Roman",
  hAnsi: "Times New Roman",
  cs: "Times New Roman",
  eastAsia: "宋体",
  hint: "eastAsia",
} as const;
/** 文本框里的行距：lineRule=auto 时 276/240 = 1.15 倍行距。必须带 lineRule，避免 WPS 误读。 */
const BOX_LINE_SPACING = { line: 276, lineRule: LineRuleType.AUTO } as const;

/** 当前建议底色。主题色着色失败时，Word/WPS 仍用这个浅黄。 */
export const BOX_FILL_HEX = "E7D4A8";
/**
 * 着色 3 的巧克力黄底色。浅色 60% 的线性结果是
 * 底色 × 0.4 + 白 × 0.6 = E7D4A8。
 */
export const ACCENT3_BASE_HEX = "C39426";
/** Word「浅色 60%」写进 themeTint / themeFillTint 的值：(1 - 0.6) × 255 = 0x66。 */
export const ACCENT3_LIGHTER_60_TINT = "66";

function points(value: number): number {
  return value * 2;
}

const PAGE_SHORT_MM = 210;
const PAGE_LONG_MM = 297;
const MARGIN_MM = 12;
/** 黄色批注框统一使用小四（12 磅 = 24 半磅），不再缩小字号。 */
export const BOX_FONT_PT = 12;
export const BOX_HALF_POINTS = points(BOX_FONT_PT);
const BOX_GAP_TWIP = 120;
const BOX_LINE_HEIGHT_TWIP = 368;
const BOX_CHROME_TWIP = 300;
const CELL_TRAILING_PARAGRAPH_TWIP = 320;
const PAGE_BOTTOM_SAFETY_TWIP = 480;
const EFFECTIVE_BOX_CHARS_PER_LINE = 31.5;
const graphemeSegmenter = new Intl.Segmenter("zh-CN", { granularity: "grapheme" });

const pageWidthTwip = convertMillimetersToTwip(PAGE_LONG_MM);
const pageHeightTwip = convertMillimetersToTwip(PAGE_SHORT_MM);
const marginTwip = convertMillimetersToTwip(MARGIN_MM);
const contentWidthTwip = pageWidthTwip - marginTwip * 2;
const contentHeightTwip = pageHeightTwip - marginTwip * 2;
const leftColumnTwip = Math.round(contentWidthTwip * 0.46);
const rightColumnTwip = contentWidthTwip - leftColumnTwip;

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

function isWebpBytes(bytes: Uint8Array, mimeType?: string): boolean {
  return (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
    || Boolean(mimeType?.toLowerCase().includes("webp"));
}

async function ensureWordCompatibleImage(bytes: Uint8Array, image: ExportImage): Promise<{ bytes: Uint8Array; mimeType?: string }> {
  if (!isWebpBytes(bytes, image.mimeType) || typeof document === "undefined" || typeof createImageBitmap !== "function") {
    return { bytes, mimeType: image.mimeType };
  }
  const bitmap = await createImageBitmap(new Blob([bytes.slice().buffer], { type: "image/webp" }));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, bitmap.width);
  canvas.height = Math.max(1, bitmap.height);
  try {
    const context = canvas.getContext("2d");
    if (!context) return { bytes, mimeType: image.mimeType };
    context.drawImage(bitmap, 0, 0);
    const converted = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片格式转换失败")), "image/png");
    });
    return { bytes: new Uint8Array(await converted.arrayBuffer()), mimeType: "image/png" };
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function loadOriginalImage(reviewId: string, image: ExportImage) {
  const response = await fetch(exportOriginalImageUrl(reviewId, image.id));
  if (!response.ok) throw new Error(`作文照片读取失败（${response.status}）`);
  return ensureWordCompatibleImage(new Uint8Array(await response.arrayBuffer()), image);
}

const DOCX_UNDERLINE = {
  single: UnderlineType.SINGLE,
  wave: UnderlineType.WAVE,
  dotDotDash: UnderlineType.DOTDOTDASH,
} as const satisfies Record<RevisionUnderline, (typeof UnderlineType)[keyof typeof UnderlineType]>;

export function runOptions(style: ExportRunStyle, underline?: RevisionUnderline): {
  bold: boolean;
  color: string;
  underline?: { type: (typeof DOCX_UNDERLINE)[RevisionUnderline]; color: string };
} {
  if (style === "suggestion") {
    // 修改动作只在与改后全段落实句对应时才划线，线型相同。
    return underline
      ? { bold: true, color: "C00000", underline: { type: DOCX_UNDERLINE[underline], color: "C00000" } }
      : { bold: true, color: "C00000" };
  }
  if (style === "demonstration") return { bold: true, color: "000000" };
  if (style === "changed") {
    return {
      bold: false,
      color: "1F4E78",
      underline: { type: DOCX_UNDERLINE[underline ?? "single"], color: "1F4E78" },
    };
  }
  return { bold: false, color: "000000" };
}

function textRuns(text: string, style: ExportRunStyle, halfPoints: number, underline?: RevisionUnderline) {
  const options = runOptions(style, underline);
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  return normalized.split("\n").map((line, index) => new TextRun({
    text: line,
    break: index === 0 ? undefined : 1,
    bold: options.bold,
    color: options.color,
    underline: options.underline,
    font: EXPORT_DOCX_FONT,
    size: halfPoints,
  }));
}

/** 修改动作按换行拆成逐行，每行保留各自的划线片段；空行丢弃。 */
function suggestionLines(runs: ExportTextRun[]) {
  const lines: ExportTextRun[][] = [[]];
  for (const run of runs) {
    run.text.split(/\r\n?|\n|\u2028|\u2029/u).forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines.at(-1)!.push({ ...run, text: part });
    });
  }
  return lines
    .map((line) => {
      const last = line.at(-1);
      if (last) last.text = last.text.trimEnd();
      return line.filter((run) => run.text.length > 0);
    })
    .filter((line) => line.length > 0);
}

function lineEmWidth(value: string): number {
  let total = 0;
  for (const { segment } of graphemeSegmenter.segment(value)) {
    const code = segment.codePointAt(0) ?? 0;
    total += code >= 0x20 && code <= 0x7e ? 0.55 : 1;
  }
  return total;
}

function wrappedLineCount(value: string): number {
  return Math.max(1, Math.ceil(lineEmWidth(value) / EFFECTIVE_BOX_CHARS_PER_LINE));
}

export function estimateBoxHeightTwip(paragraph: ExportParagraph): number {
  const runs = exportParagraphRuns(paragraph);
  const suggestions = runs.filter((run) => run.style === "suggestion");
  if (suggestions.length === 0) return BOX_LINE_HEIGHT_TWIP;
  const remainder = runs.filter((run) => run.style !== "suggestion");
  const suggestionLineTotal = suggestionLines(suggestions).reduce(
    (sum, line) => sum + wrappedLineCount(line.map((run) => run.text).join("")),
    0,
  );
  const revisedText = remainder
    .map((run) => (run.style === "changed" || run.style === "plain"
      ? run.text.replace(/[\r\n\u2028\u2029]+/gu, "")
      : run.text))
    .join("");
  const revisedLineTotal = wrappedLineCount(revisedText);
  return (suggestionLineTotal + revisedLineTotal) * BOX_LINE_HEIGHT_TWIP + BOX_CHROME_TWIP;
}

/**
 * 原文图片只有一张时，若小四字号下全部批注框超出一页高度，将超出的整框拆到后续页，
 * 以便每一页左侧都再贴一张同一份作文原图。
 */
export function splitSingleImageParagraphs(
  paragraphs: ExportParagraph[],
  availableHeightTwip = contentHeightTwip - PAGE_BOTTOM_SAFETY_TWIP,
): ExportParagraph[][] {
  if (paragraphs.length <= 1) return [paragraphs];
  const chunks: ExportParagraph[][] = [];
  let current: ExportParagraph[] = [];
  let usedTwip = CELL_TRAILING_PARAGRAPH_TWIP;

  for (const paragraph of paragraphs) {
    const boxHeight = estimateBoxHeightTwip(paragraph);
    const gap = current.length > 0 ? BOX_GAP_TWIP : 0;
    if (current.length > 0 && usedTwip + gap + boxHeight > availableHeightTwip) {
      chunks.push(current);
      current = [paragraph];
      usedTwip = CELL_TRAILING_PARAGRAPH_TWIP + boxHeight;
    } else {
      current.push(paragraph);
      usedTwip += gap + boxHeight;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** 文本框里的段落：显式左对齐 + 带 lineRule 的行距，不继承 WPS 默认的两端对齐。 */
function boxTextParagraph(children: TextRun[], before: number, after: number) {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { before, after, ...BOX_LINE_SPACING },
    children,
  });
}

function boxGapParagraph() {
  return new Paragraph({
    spacing: { before: 0, after: 0, line: BOX_GAP_TWIP, lineRule: LineRuleType.EXACT },
  });
}

function paragraphBox(paragraph: ExportParagraph, width: number, halfPoints: number) {
  const runs = exportParagraphRuns(paragraph);
  const suggestions = runs.filter((run) => run.style === "suggestion");
  const remainder = runs.filter((run) => run.style !== "suggestion");
  const singlePageBoxBudget = contentHeightTwip - PAGE_BOTTOM_SAFETY_TWIP - CELL_TRAILING_PARAGRAPH_TWIP;
  const keepBoxTogether = estimateBoxHeightTwip(paragraph) <= singlePageBoxBudget;
  const children = suggestions.length
    ? [
      // 建议每条编号各占一个 w:p，不用 w:br 软换行：两端对齐的段落里，软换行前的一行
      // 会被 Word/WPS 拉满整行宽，汉字之间出现很大的间距（像分散对齐）。
      ...suggestionLines(suggestions).map((line, index, lines) => boxTextParagraph(
        line.flatMap((run) => textRuns(run.text, run.style, halfPoints, run.underline)),
        index === 0 ? 40 : 0,
        index === lines.length - 1 ? 40 : 0,
      )),
      boxTextParagraph(
        // 「改后全段」是一个自然段：只保留标签行自带的换行，正文里的换行去掉。
        remainder.flatMap((run) => textRuns(
          run.style === "changed" || run.style === "plain" ? run.text.replace(/[\r\n\u2028\u2029]+/gu, "") : run.text,
          run.style,
          halfPoints,
          run.underline,
        )),
        20,
        40,
      ),
    ]
    : [new Paragraph({})];
  return new Table({
    width: { size: width, type: WidthType.DXA },
    columnWidths: [width],
    layout: TableLayoutType.FIXED,
    borders: boxBorders,
    rows: [new TableRow({
      cantSplit: keepBoxTogether,
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
  const boxWidth = rightColumnTwip - 160;
  const boxes = page.paragraphs.flatMap((paragraph, index) => [
    ...(index === 0 ? [] : [boxGapParagraph()]),
    paragraphBox(paragraph, boxWidth, BOX_HALF_POINTS),
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
        font: EXPORT_DOCX_FONT,
        size: points(18),
      })],
    }),
    ...paragraphs.map(singleLineParagraphText).filter((text) => text.length > 0).map((text) => new Paragraph({
      spacing: { before: 0, after: 80, line: 360, lineRule: LineRuleType.AUTO },
      indent: { firstLineChars: 200 },
      children: [new TextRun({
        text,
        color: "000000",
        font: EXPORT_DOCX_FONT,
        size: points(14),
      })],
    })),
  ];
}

async function documentChildren(review: ExportReviewSource, content: ExportReportContent) {
  const images = await Promise.all(content.pages.map((page) => loadOriginalImage(review.id, page.image)));
  const pageSlices = content.pages.length === 1
    ? splitSingleImageParagraphs(content.pages[0]!.paragraphs).map((paragraphs) => ({
      bytes: images[0]!.bytes,
      page: {
        image: { ...content.pages[0]!.image, mimeType: images[0]!.mimeType },
        paragraphs,
      },
    }))
    : content.pages.map((page, index) => ({
      bytes: images[index]!.bytes,
      page: { ...page, image: { ...page.image, mimeType: images[index]!.mimeType } },
    }));
  const children = pageSlices.flatMap((slice, index) => [
    ...(index === 0 ? [] : [pageBreakParagraph()]),
    photoTable(slice.bytes, slice.page),
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
  const xmlOptions = { compression: "DEFLATE" as const };
  const documentXml = (await documentFile.async("string")).replace(
    /<w:shd\b[^>]*\/>/g,
    chocolateBoxShading,
  );
  zip.file("word/document.xml", documentXml, xmlOptions);
  zip.file("word/theme/theme1.xml", themeXml(), xmlOptions);

  const rels = await relsFile.async("string");
  if (!rels.includes("/theme")) {
    const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((match) => Number(match[1]));
    const relationshipId = `rId${Math.max(0, ...ids) + 1}`;
    zip.file("word/_rels/document.xml.rels", rels.replace(
      "</Relationships>",
      `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`,
    ), xmlOptions);
  }
  const types = await typesFile.async("string");
  if (!types.includes("/word/theme/theme1.xml")) {
    zip.file("[Content_Types].xml", types.replace(
      "</Types>",
      `<Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`,
    ), xmlOptions);
  }
  zip.forEach((relativePath, entry) => {
    if (!entry.dir && relativePath.startsWith("word/media/")) {
      entry.options.compression = "STORE";
    }
  });
  const bytes = await zip.generateAsync({ type: "uint8array" });
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.slice().buffer as ArrayBuffer);
  return new Blob([buffer], { type: DOCX_MIME });
}

export async function createReviewDocx(review: ExportReviewSource): Promise<Blob> {
  const content = buildExportReportContent(review);
  const document = new Document({
    creator: "AI 作业批改助手",
    title: content.documentTitle,
    subject: "作文逐段批改",
    styles: {
      default: {
        document: {
          run: { font: EXPORT_DOCX_FONT },
          paragraph: { alignment: AlignmentType.LEFT },
        },
      },
    },
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
