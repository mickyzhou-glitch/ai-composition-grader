import type { Annotation } from "../domain/contracts";
import type {
  OcrCheckpointV2,
  OcrParagraphSegment,
  ParagraphAnnotationAnchor,
} from "./contracts";

const MAX_MATCHED_BLOCKS = 4;

function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[，﹐､]/gu, ",")
    .replace(/[。｡]/gu, ".")
    .replace(/\s+/gu, "");
}

interface IndexedText {
  text: string;
  blockAt: number[];
}

function indexBlocks(blocks: OcrCheckpointV2["pages"][number]["blocks"]): IndexedText {
  let text = "";
  const blockAt: number[] = [];
  blocks.forEach((block, blockIndex) => {
    const normalized = normalizeText(block.text);
    text += normalized;
    blockAt.push(...Array.from({ length: normalized.length }, () => blockIndex));
  });
  return { text, blockAt };
}

function uniqueMatchStartBlock(
  blocks: OcrCheckpointV2["pages"][number]["blocks"],
  anchorText: string,
): number | null {
  const anchor = normalizeText(anchorText);
  if (!anchor) return null;
  const indexed = indexBlocks(blocks);
  const matches: number[] = [];
  let offset = indexed.text.indexOf(anchor);
  while (offset >= 0) {
    const startBlock = indexed.blockAt[offset];
    const endBlock = indexed.blockAt[offset + anchor.length - 1];
    if (
      startBlock !== undefined &&
      endBlock !== undefined &&
      endBlock - startBlock + 1 <= MAX_MATCHED_BLOCKS
    ) {
      matches.push(startBlock);
    }
    offset = indexed.text.indexOf(anchor, offset + 1);
  }
  return matches.length === 1 ? matches[0] : null;
}

function matchCount(text: string, anchorText: string): number {
  const source = normalizeText(text);
  const anchor = normalizeText(anchorText);
  if (!anchor) return 0;
  let count = 0;
  let offset = source.indexOf(anchor);
  while (offset >= 0) {
    count += 1;
    offset = source.indexOf(anchor, offset + 1);
  }
  return count;
}

function uniqueMatchingSegment(
  segments: OcrParagraphSegment[],
  anchorText: string,
): OcrParagraphSegment | null {
  const matches = segments.flatMap((segment) => {
    const count = matchCount(segment.text, anchorText);
    return Array.from({ length: count }, () => segment);
  });
  return matches.length === 1 ? matches[0] : null;
}

export function mapAnnotationAnchors(
  checkpoint: OcrCheckpointV2,
  anchors: ParagraphAnnotationAnchor[],
): Annotation[] {
  return anchors.flatMap((anchor) => {
    const paragraph = checkpoint.paragraphs.find(({ id }) => id === anchor.paragraphId);
    if (!paragraph) return [];
    const segment = uniqueMatchingSegment(paragraph.segments, anchor.anchorText);
    if (!segment) return [];
    const page = checkpoint.pages[segment.pageIndex];
    if (!page || page.pageIndex !== segment.pageIndex) return [];
    const blockIndex = uniqueMatchStartBlock(page.blocks, anchor.anchorText);
    if (blockIndex === null) return [];
    const block = page.blocks[blockIndex];
    return [{
      pageIndex: segment.pageIndex,
      x: block.x,
      y: block.y,
      category: anchor.category,
      anchorText: anchor.anchorText,
      comment: anchor.comment,
      isHighlight: anchor.isHighlight,
    }];
  });
}
