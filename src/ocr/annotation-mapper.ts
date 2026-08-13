import type { Annotation } from "../domain/contracts";
import type { OcrCheckpoint, ReviewAnnotationAnchor } from "./contracts";

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

function indexBlocks(blocks: OcrCheckpoint["pages"][number]["blocks"]): IndexedText {
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
  blocks: OcrCheckpoint["pages"][number]["blocks"],
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

export function mapAnnotationAnchors(
  checkpoint: OcrCheckpoint,
  anchors: ReviewAnnotationAnchor[],
): Annotation[] {
  return anchors.flatMap((anchor) => {
    const page = checkpoint.pages[anchor.pageIndex];
    if (!page || page.pageIndex !== anchor.pageIndex) return [];
    const blockIndex = uniqueMatchStartBlock(page.blocks, anchor.anchorText);
    if (blockIndex === null) return [];
    const block = page.blocks[blockIndex];
    return [{
      ...anchor,
      x: block.x,
      y: block.y,
    }];
  });
}
