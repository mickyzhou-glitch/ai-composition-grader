export interface NormalizedImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BitmapDimensions {
  width: number;
  height: number;
}

export interface PixelCropRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CroppedPng {
  bytes: Uint8Array;
  width: number;
  height: number;
}

interface Canvas2dLike {
  drawImage(...args: unknown[]): void;
}

interface CanvasLike {
  width: number;
  height: number;
  getContext(contextId: "2d"): Canvas2dLike | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string): void;
}

export interface CropDependencies {
  createCanvas?: (width: number, height: number) => CanvasLike;
}

export const MAX_CROP_SOURCE_PIXELS = 24_000_000;
export const MAX_CROP_OUTPUT_PIXELS = 16_000_000;

function validDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function assertRegion(region: NormalizedImageRegion): void {
  if (
    ![region.x, region.y, region.width, region.height].every(Number.isFinite)
    || region.x < 0
    || region.y < 0
    || region.width <= 0
    || region.height <= 0
    || region.x + region.width > 1
    || region.y + region.height > 1
  ) {
    throw new RangeError("invalid normalized crop region");
  }
}

export function paddedCropRect(
  bitmap: BitmapDimensions,
  region: NormalizedImageRegion,
): PixelCropRect {
  if (!validDimension(bitmap.width) || !validDimension(bitmap.height)) {
    throw new RangeError("invalid bitmap dimensions");
  }
  assertRegion(region);
  const left = Math.max(0, Math.floor((region.x - 0.01) * bitmap.width + Number.EPSILON));
  const top = Math.max(0, Math.floor((region.y - 0.01) * bitmap.height + Number.EPSILON));
  const right = Math.min(
    bitmap.width,
    Math.ceil((region.x + region.width + 0.01) * bitmap.width - 1e-9),
  );
  const bottom = Math.min(
    bitmap.height,
    Math.ceil((region.y + region.height + 0.01) * bitmap.height - 1e-9),
  );
  return { left, top, width: right - left, height: bottom - top };
}

function browserCanvas(width: number, height: number): CanvasLike {
  void width;
  void height;
  return document.createElement("canvas");
}

export async function cropImageRegion(
  bitmap: BitmapDimensions,
  region: NormalizedImageRegion,
  dependencies: CropDependencies = {},
): Promise<CroppedPng> {
  const rect = paddedCropRect(bitmap, region);
  if (bitmap.width > MAX_CROP_SOURCE_PIXELS / bitmap.height) {
    throw new RangeError("source bitmap exceeds crop pixel limit");
  }
  if (rect.width > MAX_CROP_OUTPUT_PIXELS / rect.height) {
    throw new RangeError("output crop exceeds pixel limit");
  }
  const canvas = (dependencies.createCanvas ?? browserCanvas)(rect.width, rect.height);
  try {
    canvas.width = rect.width;
    canvas.height = rect.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context unavailable");
    context.drawImage(
      bitmap,
      rect.left,
      rect.top,
      rect.width,
      rect.height,
      0,
      0,
      rect.width,
      rect.height,
    );
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value) resolve(value);
        else reject(new Error("PNG crop encoding failed"));
      }, "image/png");
    });
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width: rect.width,
      height: rect.height,
    };
  } finally {
    try {
      canvas.width = 0;
    } catch {
      // Continue releasing the other backing-store dimension.
    }
    try {
      canvas.height = 0;
    } catch {
      // Cleanup failures must not hide the crop result or its original error.
    }
  }
}
