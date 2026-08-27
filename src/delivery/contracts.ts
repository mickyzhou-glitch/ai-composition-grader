import type { ParagraphSuggestion } from "../domain/contracts";
import type { RevisionRun } from "../revisions/revision-diff";

export const DELIVERY_STYLE = {
  page: { widthMm: 210, heightMm: 297, marginXmm: 18, marginYmm: 16 },
  colors: { text: "171717", change: "C91F32", suggestion: "FFF0BD" },
  fontPt: { title: 16, section: 11, suggestion: 10.5, revision: 11.5 },
} as const;

export interface DeliveryCrop {
  pageIndex: number;
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface DeliveryParagraph {
  paragraphNumber: number;
  crops: DeliveryCrop[];
  suggestions: ParagraphSuggestion[];
  revisionRuns: RevisionRun[];
}

export interface DeliveryDocument {
  title: string;
  studentName: string;
  paragraphs: DeliveryParagraph[];
}
