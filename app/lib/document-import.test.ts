import { describe, expect, it } from "vitest";
import { validateDocumentFile, validateDocumentPageCount } from "./document-import";

describe("document import limits", () => {
  it("accepts only DOCX and PDF regardless of missing browser MIME types", () => {
    expect(validateDocumentFile(new File(["x"], "作文.DOCX"))).toBe("docx");
    expect(validateDocumentFile(new File(["x"], "作文.pdf"))).toBe("pdf");
    expect(() => validateDocumentFile(new File(["x"], "作文.doc"))).toThrow(".docx");
    expect(() => validateDocumentFile(new File([], "空.pdf"))).toThrow("为空");
    expect(() => validateDocumentFile({ name: "作文.pdf", size: 21 * 1024 * 1024 } as File)).toThrow("20MB");
  });
  it("rejects zero and excess pages before replacing the current preview", () => {
    expect(() => validateDocumentPageCount(0)).toThrow();
    expect(() => validateDocumentPageCount(5)).toThrow("4");
    expect(() => validateDocumentPageCount(4)).not.toThrow();
  });
});
