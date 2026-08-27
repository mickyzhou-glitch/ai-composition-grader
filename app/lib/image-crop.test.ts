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
    expect(canvas).toMatchObject({ width: 0, height: 0 });
  });

  it.each([
    ["missing context", (canvas: ReturnType<typeof cropCanvas>) => {
      canvas.getContext.mockReturnValue(null);
    }],
    ["drawImage error", (canvas: ReturnType<typeof cropCanvas>) => {
      canvas.drawImage.mockImplementation(() => { throw new Error("draw failed"); });
    }],
    ["toBlob error", (canvas: ReturnType<typeof cropCanvas>) => {
      canvas.toBlob.mockImplementation(() => { throw new Error("encode failed"); });
    }],
    ["empty blob", (canvas: ReturnType<typeof cropCanvas>) => {
      canvas.toBlob.mockImplementation((callback) => callback(null));
    }],
    ["arrayBuffer error", (canvas: ReturnType<typeof cropCanvas>) => {
      canvas.toBlob.mockImplementation((callback) => callback({
        arrayBuffer: async () => { throw new Error("read failed"); },
      } as unknown as Blob));
    }],
  ])("releases canvas memory after %s", async (_case, arrange) => {
    const canvas = cropCanvas();
    arrange(canvas);

    await expect(cropImageRegion(
      { width: 1000, height: 1500 },
      { x: 0.1, y: 0.2, width: 0.5, height: 0.3 },
      { createCanvas: () => canvas },
    )).rejects.toBeInstanceOf(Error);
    expect(canvas).toMatchObject({ width: 0, height: 0 });
  });

  it.each([
    ["bitmap", { width: 6000, height: 5000 }, { x: 0, y: 0, width: 0.1, height: 0.1 }],
    ["crop", { width: 5000, height: 4000 }, { x: 0, y: 0, width: 1, height: 1 }],
  ])("rejects an oversized %s before creating a canvas", async (_case, bitmap, region) => {
    const createCanvas = vi.fn();
    await expect(cropImageRegion(bitmap, region, { createCanvas })).rejects.toThrow("pixel limit");
    expect(createCanvas).not.toHaveBeenCalled();
  });

  it("keeps a common 12-megapixel phone image within the crop budget", async () => {
    const canvas = cropCanvas();
    await expect(cropImageRegion(
      { width: 4032, height: 3024 },
      { x: 0, y: 0, width: 1, height: 1 },
      { createCanvas: () => canvas },
    )).resolves.toMatchObject({ width: 4032, height: 3024 });
    expect(canvas).toMatchObject({ width: 0, height: 0 });
  });
});

function cropCanvas() {
  const drawImage = vi.fn();
  return {
    width: 0,
    height: 0,
    drawImage,
    getContext: vi.fn((): { drawImage: typeof drawImage } | null => ({ drawImage })),
    toBlob: vi.fn((callback: (blob: Blob | null) => void) => callback(new Blob(["png"]))),
  };
}
