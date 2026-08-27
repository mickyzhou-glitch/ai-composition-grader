import { DELIVERY_STYLE, type DeliveryDocument, type DeliveryParagraph } from "@/src/delivery/contracts";
import type { RevisionRun } from "@/src/revisions/revision-diff";

const CONTENT_WIDTH_MM = DELIVERY_STYLE.page.widthMm - DELIVERY_STYLE.page.marginXmm * 2;
const CONTENT_HEIGHT_MM = DELIVERY_STYLE.page.heightMm - DELIVERY_STYLE.page.marginYmm * 2;
const DOCUMENT_TITLE_HEIGHT_MM = 14;
const PARAGRAPH_HEADING_HEIGHT_MM = 9;
const SECTION_HEADING_HEIGHT_MM = 9;
const SUGGESTION_LINE_HEIGHT_MM = 5;
const SUGGESTION_PADDING_MM = 6;
const REVISION_LINE_HEIGHT_MM = 5.6;
const MAX_CROP_HEIGHT_MM = 80;
const EPSILON = 0.001;

export type DeliveryTextMeasurer = (
  text: string,
  fontPt: number,
  fontFamily: "sans" | "kaiti",
) => number;

export type DeliveryPageBlock =
  | { kind: "paragraph-heading"; paragraphNumber: number; continued: boolean; heightMm: number }
  | { kind: "crop"; cropIndex: number; widthMm: number; heightMm: number }
  | { kind: "suggestion-heading"; continued: boolean; heightMm: number }
  | { kind: "suggestion"; suggestionIndex: number; heightMm: number }
  | { kind: "revision-heading"; continued: boolean; heightMm: number }
  | { kind: "revision-lines"; runs: RevisionRun[]; lineCount: number; heightMm: number };

export interface DeliveryPage {
  pageNumber: number;
  hasDocumentTitle: boolean;
  blocks: DeliveryPageBlock[];
  usedHeightMm: number;
  remainingHeightMm: number;
}

export interface DeliveryPaginationOptions {
  measureText?: DeliveryTextMeasurer;
}

function defaultMeasureText(text: string, fontPt: number): number {
  return Array.from(text).length * fontPt * 0.19;
}

function graphemes(value: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    return Array.from(
      new Intl.Segmenter("zh-CN", { granularity: "grapheme" }).segment(value),
      ({ segment }) => segment,
    );
  }
  return Array.from(value);
}

function wrappedLineCount(
  text: string,
  fontPt: number,
  fontFamily: "sans" | "kaiti",
  measureText: DeliveryTextMeasurer,
): number {
  let lines = 0;
  for (const rawLine of text.replace(/\r\n?/gu, "\n").split("\n")) {
    let width = 0;
    let hasText = false;
    for (const character of graphemes(rawLine)) {
      const characterWidth = measureText(character, fontPt, fontFamily);
      if (hasText && width + characterWidth > CONTENT_WIDTH_MM) {
        lines += 1;
        width = characterWidth;
      } else {
        width += characterWidth;
      }
      hasText = true;
    }
    lines += 1;
  }
  return Math.max(1, lines);
}

function appendRun(runs: RevisionRun[], kind: RevisionRun["kind"], text: string): void {
  const previous = runs.at(-1);
  if (previous?.kind === kind) previous.text += text;
  else runs.push({ kind, text });
}

function wrapRevisionRuns(
  runs: RevisionRun[],
  measureText: DeliveryTextMeasurer,
): RevisionRun[][] {
  const lines: RevisionRun[][] = [];
  let current: RevisionRun[] = [];
  let width = 0;

  const pushLine = () => {
    lines.push(current.length > 0 ? current : [{ kind: "unchanged", text: "" }]);
    current = [];
    width = 0;
  };

  for (const run of runs) {
    for (const character of graphemes(run.text.replace(/\r\n?/gu, "\n"))) {
      if (character === "\n") {
        pushLine();
        continue;
      }
      const characterWidth = measureText(
        character,
        DELIVERY_STYLE.fontPt.revision,
        "kaiti",
      );
      if (current.length > 0 && width + characterWidth > CONTENT_WIDTH_MM) {
        pushLine();
      }
      appendRun(current, run.kind, character);
      width += characterWidth;
    }
  }
  if (current.length > 0 || lines.length === 0) pushLine();
  return lines;
}

function joinedRevisionRuns(lines: RevisionRun[][]): RevisionRun[] {
  const runs: RevisionRun[] = [];
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) appendRun(runs, "unchanged", "\n");
    for (const run of line) appendRun(runs, run.kind, run.text);
  });
  return runs;
}

function cropBlock(paragraph: DeliveryParagraph, cropIndex: number): DeliveryPageBlock {
  const crop = paragraph.crops[cropIndex];
  const ratio = crop.width / crop.height;
  let widthMm = CONTENT_WIDTH_MM;
  let heightMm = widthMm / ratio;
  if (heightMm > MAX_CROP_HEIGHT_MM) {
    heightMm = MAX_CROP_HEIGHT_MM;
    widthMm = heightMm * ratio;
  }
  return { kind: "crop", cropIndex, widthMm, heightMm };
}

function suggestionBlock(
  paragraph: DeliveryParagraph,
  suggestionIndex: number,
  measureText: DeliveryTextMeasurer,
): DeliveryPageBlock {
  const suggestion = paragraph.suggestions[suggestionIndex];
  const lines = [
    `问题：${suggestion.problem}`,
    `动作：${suggestion.advice}`,
    `示例：${suggestion.example}`,
  ].reduce((sum, text) => sum + wrappedLineCount(
    text,
    DELIVERY_STYLE.fontPt.suggestion,
    "sans",
    measureText,
  ), 0);
  return {
    kind: "suggestion",
    suggestionIndex,
    heightMm: lines * SUGGESTION_LINE_HEIGHT_MM + SUGGESTION_PADDING_MM,
  };
}

function revisionBlock(lines: RevisionRun[][]): DeliveryPageBlock {
  return {
    kind: "revision-lines",
    runs: joinedRevisionRuns(lines),
    lineCount: lines.length,
    heightMm: lines.length * REVISION_LINE_HEIGHT_MM,
  };
}

function totalHeight(blocks: DeliveryPageBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.heightMm, 0);
}

function completeParagraphBlocks(
  paragraph: DeliveryParagraph,
  measureText: DeliveryTextMeasurer,
): DeliveryPageBlock[] {
  const revisionLines = wrapRevisionRuns(paragraph.revisionRuns, measureText);
  return [
    {
      kind: "paragraph-heading",
      paragraphNumber: paragraph.paragraphNumber,
      continued: false,
      heightMm: PARAGRAPH_HEADING_HEIGHT_MM,
    },
    ...paragraph.crops.map((_, index) => cropBlock(paragraph, index)),
    { kind: "suggestion-heading", continued: false, heightMm: SECTION_HEADING_HEIGHT_MM },
    ...paragraph.suggestions.map((_, index) => suggestionBlock(paragraph, index, measureText)),
    { kind: "revision-heading", continued: false, heightMm: SECTION_HEADING_HEIGHT_MM },
    revisionBlock(revisionLines),
  ];
}

export function paginateDeliveryDocument(
  document: DeliveryDocument,
  options: DeliveryPaginationOptions = {},
): DeliveryPage[] {
  const measureText = options.measureText ?? defaultMeasureText;
  const pages: DeliveryPage[] = [];
  let page!: DeliveryPage;

  const createPage = () => {
    const hasDocumentTitle = pages.length === 0;
    page = {
      pageNumber: pages.length + 1,
      hasDocumentTitle,
      blocks: [],
      usedHeightMm: hasDocumentTitle ? DOCUMENT_TITLE_HEIGHT_MM : 0,
      remainingHeightMm: CONTENT_HEIGHT_MM - (hasDocumentTitle ? DOCUMENT_TITLE_HEIGHT_MM : 0),
    };
    pages.push(page);
  };
  const add = (block: DeliveryPageBlock) => {
    page.blocks.push(block);
    page.usedHeightMm += block.heightMm;
    page.remainingHeightMm = Math.max(0, CONTENT_HEIGHT_MM - page.usedHeightMm);
  };
  const fits = (heightMm: number) => heightMm <= page.remainingHeightMm + EPSILON;
  const continueParagraph = (paragraphNumber: number) => {
    createPage();
    add({
      kind: "paragraph-heading",
      paragraphNumber,
      continued: true,
      heightMm: PARAGRAPH_HEADING_HEIGHT_MM,
    });
  };

  createPage();
  for (const paragraph of document.paragraphs) {
    const complete = completeParagraphBlocks(paragraph, measureText);
    const completeHeight = totalHeight(complete);
    const pageHasParagraphContent = page.blocks.length > 0;
    if (completeHeight <= CONTENT_HEIGHT_MM && fits(completeHeight)) {
      complete.forEach(add);
      continue;
    }
    if (completeHeight <= CONTENT_HEIGHT_MM && pageHasParagraphContent) {
      createPage();
      complete.forEach(add);
      continue;
    }

    const heading: DeliveryPageBlock = {
      kind: "paragraph-heading",
      paragraphNumber: paragraph.paragraphNumber,
      continued: false,
      heightMm: PARAGRAPH_HEADING_HEIGHT_MM,
    };
    const crops = paragraph.crops.map((_, index) => cropBlock(paragraph, index));
    const firstCrop = crops[0];
    if (!fits(heading.heightMm + (firstCrop?.heightMm ?? 0)) && page.blocks.length > 0) {
      createPage();
    }
    add(heading);
    for (const crop of crops) {
      if (!fits(crop.heightMm)) continueParagraph(paragraph.paragraphNumber);
      add(crop);
    }

    const suggestions = paragraph.suggestions.map((_, index) => (
      suggestionBlock(paragraph, index, measureText)
    ));
    const firstSuggestion = suggestions[0];
    if (!fits(SECTION_HEADING_HEIGHT_MM + (firstSuggestion?.heightMm ?? 0))) {
      continueParagraph(paragraph.paragraphNumber);
    }
    add({ kind: "suggestion-heading", continued: false, heightMm: SECTION_HEADING_HEIGHT_MM });
    for (let index = 0; index < suggestions.length; index += 1) {
      const suggestion = suggestions[index];
      if (!fits(suggestion.heightMm)) {
        continueParagraph(paragraph.paragraphNumber);
        add({ kind: "suggestion-heading", continued: true, heightMm: SECTION_HEADING_HEIGHT_MM });
      }
      add(suggestion);
    }

    const revisionLines = wrapRevisionRuns(paragraph.revisionRuns, measureText);
    const requiredRevisionLines = Math.min(2, revisionLines.length);
    const requiredRevisionHeight = SECTION_HEADING_HEIGHT_MM
      + requiredRevisionLines * REVISION_LINE_HEIGHT_MM;
    if (!fits(requiredRevisionHeight)) continueParagraph(paragraph.paragraphNumber);
    add({ kind: "revision-heading", continued: false, heightMm: SECTION_HEADING_HEIGHT_MM });
    let revisionIndex = 0;
    while (revisionIndex < revisionLines.length) {
      let lineCapacity = Math.floor((page.remainingHeightMm + EPSILON) / REVISION_LINE_HEIGHT_MM);
      if (lineCapacity === 0) {
        continueParagraph(paragraph.paragraphNumber);
        add({ kind: "revision-heading", continued: true, heightMm: SECTION_HEADING_HEIGHT_MM });
        lineCapacity = Math.floor((page.remainingHeightMm + EPSILON) / REVISION_LINE_HEIGHT_MM);
      }
      const count = Math.min(lineCapacity, revisionLines.length - revisionIndex);
      add(revisionBlock(revisionLines.slice(revisionIndex, revisionIndex + count)));
      revisionIndex += count;
      if (revisionIndex < revisionLines.length) {
        continueParagraph(paragraph.paragraphNumber);
        add({ kind: "revision-heading", continued: true, heightMm: SECTION_HEADING_HEIGHT_MM });
      }
    }
  }

  return pages.filter((candidate) => candidate.blocks.length > 0);
}
