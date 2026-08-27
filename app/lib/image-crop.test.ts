import { describe, expect, it, vi } from "vitest";

import { cropImageRegion, paddedCropRect } from "./image-crop";

describe("image crop", () => {
  it("adds one percent page padding before converting normalized coordinates", () => {
    expect(paddedCropRect(
      { width: 1000, height: 1500 },
      { x: 0.1, y: 0.2, width: 0.5, height: 0.3 },
    )).toEqual({ left: 90, top: 285, width: 520, height: 480 });
  });

  it("clamps padding to the bitmap edge and rejects invalid regions", () => {
    expect(paddedCropRect(
      { width: 1000, height: 1500 },
      { x: 0, y: 0, width: 0.05, height: 0.05 },
    )).toEqual({ left: 0, top: 0, width: 60, height: 90 });
    expect(() => paddedCropRect(
      { width: 1000, height: 1500 },
      { x: 0.9, y: 0.1, width: 0.2, height: 0.2 },
    )).toThrow("normalized crop region");
  });

  it("draws the actual bitmap crop and returns PNG bytes", async () => {
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob: vi.fn((callback: (blob: Blob | null) => void) => callback(new Blob([
        new Uint8Array([137, 80, 78, 71]),
      ], { type: "image/png" }))),
    };
    const bitmap = { width: 1000, height: 1500 };

    await expect(cropImageRegion(bitmap, {
      x: 0.1, y: 0.2, width: 0.5, height: 0.3,
    }, { createCanvas: () => canvas })).resolves.toEqual({
      bytes: new Uint8Array([137, 80, 78, 71]),
      width: 520,
      height: 480,
    });
    expect(drawImage).toHaveBeenCalledWith(bitmap, 90, 285, 520, 480, 0, 0, 520, 480);
  });
});
