// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";

import {
  consumePrintToken,
  createPrintToken,
} from "./print-token";

const SECRET = "test-print-token-secret-with-at-least-32-chars";

afterEach(() => {
  delete process.env.PDF_PRINT_TOKEN_SECRET;
});

describe("PDF print token", () => {
  it("binds owner/review and is one-shot", () => {
    const now = 1_700_000_000_000;
    const token = createPrintToken({ ownerId: "teacher-1", reviewId: "review-1" }, SECRET, now);
    expect(consumePrintToken(token, { ownerId: "teacher-1", reviewId: "review-1" }, SECRET, now + 1)).toMatchObject({
      ownerId: "teacher-1",
      reviewId: "review-1",
    });
    expect(consumePrintToken(token, { ownerId: "teacher-1", reviewId: "review-1" }, SECRET, now + 2)).toBeNull();
  });

  it("rejects wrong key, owner, review and expiry", () => {
    const now = 1_700_000_000_000;
    const token = createPrintToken({ ownerId: "teacher-1", reviewId: "review-1", expiresAt: now + 10 }, SECRET, now);
    expect(consumePrintToken(token, { ownerId: "teacher-2" }, SECRET, now + 1)).toBeNull();
    expect(consumePrintToken(token, { reviewId: "review-2" }, SECRET, now + 1)).toBeNull();
    expect(consumePrintToken(token, {}, "another-print-token-secret-with-at-least-32-chars", now + 1)).toBeNull();
    expect(consumePrintToken(token, {}, SECRET, now + 11)).toBeNull();
  });

  it("requires an independent configured secret when omitted", () => {
    delete process.env.PDF_PRINT_TOKEN_SECRET;
    expect(() => createPrintToken({ ownerId: "teacher-1", reviewId: "review-1" })).toThrow(/PDF_PRINT_TOKEN_SECRET/);
    process.env.PDF_PRINT_TOKEN_SECRET = SECRET;
    expect(createPrintToken({ ownerId: "teacher-1", reviewId: "review-1" })).toEqual(expect.any(String));
  });
});
