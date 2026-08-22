export const ANALYSIS_JOB_METADATA_PREFIX = "__AI_GRADER_JOB_V1__:";
export const REANALYSIS_PENDING_PDF_MARKER_PREFIX =
  `${ANALYSIS_JOB_METADATA_PREFIX}reanalysis-pending-pdf:`;

const REANALYSIS_READY_MARKER = `${ANALYSIS_JOB_METADATA_PREFIX}reanalysis-ready`;
const ORDINARY_BOUND_MARKER = `${ANALYSIS_JOB_METADATA_PREFIX}ordinary-bound`;
const SAFE_PDF_FILENAME = /^[^/\\\0]+\.pdf$/iu;

export type AnalysisJobMetadata =
  | {
    kind: "reanalysis";
    prebound: true;
    pdfCleanup: null | { filename: string };
  }
  | {
    kind: "ordinary";
    prebound: true;
    pdfCleanup: null;
  };

export function encodeReanalysisReadyMarker(): string {
  return REANALYSIS_READY_MARKER;
}

export function encodeOrdinaryBoundMarker(): string {
  return ORDINARY_BOUND_MARKER;
}

export function encodeReanalysisPendingPdfMarker(filename: string): string {
  if (!SAFE_PDF_FILENAME.test(filename)) {
    throw new TypeError("filename must be a safe PDF filename");
  }
  return `${REANALYSIS_PENDING_PDF_MARKER_PREFIX}${encodeURIComponent(filename)}`;
}

export function parseAnalysisJobMetadata(message: string | null): AnalysisJobMetadata | null {
  if (message === REANALYSIS_READY_MARKER) {
    return { kind: "reanalysis", prebound: true, pdfCleanup: null };
  }
  if (message === ORDINARY_BOUND_MARKER) {
    return { kind: "ordinary", prebound: true, pdfCleanup: null };
  }
  if (!message?.startsWith(REANALYSIS_PENDING_PDF_MARKER_PREFIX)) return null;
  const encoded = message.slice(REANALYSIS_PENDING_PDF_MARKER_PREFIX.length);
  if (!encoded) return null;
  try {
    const filename = decodeURIComponent(encoded);
    if (encodeURIComponent(filename) !== encoded || !SAFE_PDF_FILENAME.test(filename)) return null;
    return {
      kind: "reanalysis",
      prebound: true,
      pdfCleanup: { filename },
    };
  } catch {
    return null;
  }
}

export function readyReanalysisMarkerFromPending(marker: string): string {
  const metadata = parseAnalysisJobMetadata(marker);
  if (metadata?.kind !== "reanalysis" || !metadata.pdfCleanup) {
    throw new TypeError("marker must contain pending reanalysis PDF cleanup");
  }
  return REANALYSIS_READY_MARKER;
}
