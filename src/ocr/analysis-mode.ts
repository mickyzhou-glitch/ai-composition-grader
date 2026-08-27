import type { OcrCheckpoint } from "./contracts";

export type AnalysisMode = "full" | "content_only";

export class OcrV2RequiredError extends Error {
  readonly code = "OCR_V2_REQUIRED";
  readonly status = 409;

  constructor() {
    super("OCR_V2_REQUIRED");
    this.name = "OcrV2RequiredError";
  }
}

export function analysisModeForCheckpoint(
  requested: AnalysisMode,
  checkpoint: OcrCheckpoint | null,
): AnalysisMode {
  if (requested === "content_only" && checkpoint?.version !== 2) {
    throw new OcrV2RequiredError();
  }
  return checkpoint?.version === 2 ? requested : "full";
}
