import type { PublicOcrView } from "./contracts";

/** One placeholder per character the vision model could not read. */
export const OCR_UNREADABLE_PLACEHOLDER = "□";

/** At or above this share of placeholders in the essay text, the teacher must proofread first. */
export const OCR_PLACEHOLDER_RATIO_THRESHOLD = 0.03;

export interface OcrProofreadAssessment {
  needsProofread: boolean;
  reasons: string[];
  placeholderCount: number;
  /** Placeholders divided by non-whitespace characters of the essay text, 0..1. */
  placeholderRatio: number;
}

type OcrInput = Pick<PublicOcrView, "pages"> & { paragraphs?: ReadonlyArray<{ text: string }> };

function countChars(text: string): { total: number; placeholders: number } {
  let total = 0;
  let placeholders = 0;
  for (const char of text) {
    if (/\s/u.test(char)) continue;
    total += 1;
    if (char === OCR_UNREADABLE_PLACEHOLDER) placeholders += 1;
  }
  return { total, placeholders };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 1000) / 10}%`;
}

/** Decide whether the recognized text is reliable enough to review without proofreading first. */
export function assessOcrProofreading(ocr: OcrInput | null | undefined): OcrProofreadAssessment {
  if (!ocr) return { needsProofread: false, reasons: [], placeholderCount: 0, placeholderRatio: 0 };
  const reasons: string[] = [];
  const unreadablePages = ocr.pages.filter((page) => !page.readable).map((page) => page.pageIndex + 1);
  if (unreadablePages.length > 0) {
    reasons.push(`模型警告：第 ${unreadablePages.join("、")} 页无法完整辨认`);
  }
  const warnings = [...new Set(ocr.pages.flatMap((page) => page.warnings.map((warning) => warning.trim()).filter(Boolean)
    .map((warning) => ocr.pages.length > 1 ? `第 ${page.pageIndex + 1} 页：${warning}` : warning)))];
  if (warnings.length > 0) reasons.push(`模型警告：${warnings.join("；")}`);

  const text = ocr.paragraphs && ocr.paragraphs.length > 0
    ? ocr.paragraphs.map(({ text: paragraph }) => paragraph).join("\n")
    : ocr.pages.map((page) => page.text).join("\n");
  const { total, placeholders } = countChars(text);
  const placeholderRatio = total > 0 ? placeholders / total : 0;
  if (placeholders > 0 && placeholderRatio >= OCR_PLACEHOLDER_RATIO_THRESHOLD) {
    reasons.push(`看不清的字（「${OCR_UNREADABLE_PLACEHOLDER}」）共 ${placeholders} 个，占正文 ${percent(placeholderRatio)}，超过 ${percent(OCR_PLACEHOLDER_RATIO_THRESHOLD)}`);
  }
  return { needsProofread: reasons.length > 0, reasons, placeholderCount: placeholders, placeholderRatio };
}
