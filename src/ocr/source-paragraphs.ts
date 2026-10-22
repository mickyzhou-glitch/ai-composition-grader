import type { OcrPage, OcrParagraph } from "./contracts";

export type SourceParagraph = Omit<OcrParagraph, "id">;

interface Piece {
  pageIndex: number;
  text: string;
  indented: boolean;
}

function paragraphLines(text: string): Array<{ text: string; indented: boolean }> {
  return text.split(/\r?\n/u).flatMap((line) => {
    if (line.trim().length === 0) return [];
    return [{ text: line.trim(), indented: /^[\s\u3000]/u.test(line) }];
  });
}

function endsSentence(text: string): boolean {
  const stripped = text.trim().replace(/[”"』」）)]+$/u, "");
  return /[。！？….!?]$/u.test(stripped);
}

function isEnglishOrNumber(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z0-9]$/u.test(value);
}

function joinSegmentText(parts: string[]): string {
  return parts.reduce((combined, text, index) => {
    if (index === 0) return text;
    const previous = parts[index - 1];
    const separator = isEnglishOrNumber(previous.at(-1)) && isEnglishOrNumber(text[0]) ? " " : "";
    return `${combined}${separator}${text}`;
  }, "");
}

function piecesFromPages(pages: OcrPage[]): Piece[][] {
  const ordered = [...pages].sort((left, right) => left.pageIndex - right.pageIndex);
  const groups: Piece[][] = [];
  for (const page of ordered) {
    const lines = paragraphLines(page.text);
    lines.forEach((line, index) => {
      const previous = groups.at(-1)?.at(-1);
      const continues = index === 0
        && previous !== undefined
        && previous.pageIndex === page.pageIndex - 1
        && !endsSentence(previous.text)
        && !line.indented;
      const piece = { pageIndex: page.pageIndex, text: line.text, indented: line.indented };
      if (continues) groups.at(-1)?.push(piece);
      else groups.push([piece]);
    });
  }
  return groups;
}

function piecesFromParagraphText(paragraphs: SourceParagraph[]): Piece[][] | null {
  let expanded = false;
  const groups: Piece[][] = [];
  for (const paragraph of paragraphs) {
    const lines = paragraphLines(paragraph.text);
    const pageIndex = paragraph.segments[0]?.pageIndex ?? 0;
    if (lines.length > 1) expanded = true;
    const pieces = lines.length > 0 ? lines : [{ text: paragraph.text.trim(), indented: false }];
    for (const line of pieces) {
      groups.push([{ pageIndex, text: line.text, indented: line.indented }]);
    }
  }
  return expanded ? groups : null;
}

function synthesize(groups: Piece[][]): SourceParagraph[] {
  const perPage = new Map<number, number>();
  for (const group of groups) {
    for (const piece of group) {
      perPage.set(piece.pageIndex, (perPage.get(piece.pageIndex) ?? 0) + 1);
    }
  }
  const cursor = new Map<number, number>();
  return groups.map((group, paragraphIndex) => {
    const segments = group.map((piece) => {
      const total = perPage.get(piece.pageIndex) ?? 1;
      const index = cursor.get(piece.pageIndex) ?? 0;
      cursor.set(piece.pageIndex, index + 1);
      const slot = 1 / total;
      const y = index * slot;
      const gap = index === total - 1 ? 0 : 1e-4;
      return {
        pageIndex: piece.pageIndex,
        text: piece.text,
        x: 0,
        y,
        width: 1,
        height: Math.min(slot - gap, 1 - y),
      };
    });
    return {
      paragraphIndex,
      text: joinSegmentText(segments.map((segment) => segment.text)),
      segments,
    };
  });
}

/**
 * Expand merged OCR paragraphs so each real source paragraph stays separate.
 * Page text wins when it contains more paragraph breaks. A model that already
 * found more paragraphs is left unchanged, and a cross-page sentence is kept
 * together when the previous page does not end the sentence.
 */
export function alignParagraphsToSource(
  pages: OcrPage[],
  paragraphs: SourceParagraph[],
): SourceParagraph[] {
  const fromPages = piecesFromPages(pages);
  const fromModel = piecesFromParagraphText(paragraphs);
  const candidates = [
    fromPages.length > paragraphs.length ? fromPages : null,
    fromModel && fromModel.length > paragraphs.length ? fromModel : null,
  ].filter((candidate): candidate is Piece[][] => candidate !== null);
  if (candidates.length === 0) return paragraphs;
  const chosen = candidates.reduce((best, current) => (
    current.length > best.length ? current : best
  ));
  return synthesize(chosen);
}
