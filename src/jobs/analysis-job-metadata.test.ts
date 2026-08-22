import { describe, expect, it } from "vitest";

import {
  encodeOrdinaryBoundMarker,
  encodeReanalysisPendingPdfMarker,
  encodeReanalysisReadyMarker,
  parseAnalysisJobMetadata,
  readyReanalysisMarkerFromPending,
} from "./analysis-job-metadata";

describe("analysis job internal metadata", () => {
  it("represents a prebound reanalysis job with no pending PDF", () => {
    const marker = encodeReanalysisReadyMarker();

    expect(parseAnalysisJobMetadata(marker)).toEqual({
      kind: "reanalysis",
      prebound: true,
      pdfCleanup: null,
    });
  });

  it("round-trips a safe pending PDF and converts it to ready", () => {
    const pending = encodeReanalysisPendingPdfMarker("作文 批改-v3.pdf");

    expect(parseAnalysisJobMetadata(pending)).toEqual({
      kind: "reanalysis",
      prebound: true,
      pdfCleanup: { filename: "作文 批改-v3.pdf" },
    });
    expect(pending).not.toContain("作文 批改-v3.pdf");
    expect(readyReanalysisMarkerFromPending(pending)).toBe(encodeReanalysisReadyMarker());
  });

  it("represents an ordinary job after its first direct prepare binds the review", () => {
    expect(parseAnalysisJobMetadata(encodeOrdinaryBoundMarker())).toEqual({
      kind: "ordinary",
      prebound: true,
      pdfCleanup: null,
    });
  });

  it.each([
    null,
    "",
    "analysis failed",
    "__AI_GRADER_JOB_V1__:reanalysis-pending-pdf:%E0%A4%A",
    "__AI_GRADER_JOB_V1__:reanalysis-pending-pdf:../old.pdf",
    "__AI_GRADER_JOB_V1__:reanalysis-pending-pdf:old.txt",
    "__AI_GRADER_JOB_V1__:unknown",
  ])("does not interpret normal or malformed messages: %s", (message) => {
    expect(parseAnalysisJobMetadata(message)).toBeNull();
  });

  it.each(["../old.pdf", "folder/old.pdf", "folder\\old.pdf", "old.txt", "\0.pdf"])(
    "rejects unsafe pending PDF filenames: %s",
    (filename) => {
      expect(() => encodeReanalysisPendingPdfMarker(filename)).toThrow(TypeError);
    },
  );

  it("refuses to acknowledge a non-pending marker", () => {
    expect(() => readyReanalysisMarkerFromPending(encodeReanalysisReadyMarker())).toThrow(TypeError);
    expect(() => readyReanalysisMarkerFromPending("ordinary message")).toThrow(TypeError);
  });
});
