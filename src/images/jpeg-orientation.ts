import { quarterTurnFromExif, type QuarterTurn } from "./upright-orientation";

function readU16(bytes: Uint8Array, offset: number, little: boolean): number {
  const first = bytes[offset] ?? 0;
  const second = bytes[offset + 1] ?? 0;
  return little ? first | (second << 8) : (first << 8) | second;
}

function readU32(bytes: Uint8Array, offset: number, little: boolean): number {
  const first = readU16(bytes, offset, little);
  const second = readU16(bytes, offset + 2, little);
  return little ? (first | (second << 16)) >>> 0 : ((first << 16) | second) >>> 0;
}

function readTiffOrientation(bytes: Uint8Array, tiffStart: number, tiffEnd: number): number | null {
  if (tiffStart + 8 > tiffEnd) return null;
  const little = bytes[tiffStart] === 0x49 && bytes[tiffStart + 1] === 0x49;
  const big = bytes[tiffStart] === 0x4d && bytes[tiffStart + 1] === 0x4d;
  if (!little && !big) return null;
  if (readU16(bytes, tiffStart + 2, little) !== 42) return null;
  const ifdOffset = readU32(bytes, tiffStart + 4, little);
  let entry = tiffStart + ifdOffset;
  if (entry + 2 > tiffEnd) return null;
  const count = readU16(bytes, entry, little);
  entry += 2;
  for (let index = 0; index < count; index += 1) {
    const cursor = entry + index * 12;
    if (cursor + 12 > tiffEnd) return null;
    if (readU16(bytes, cursor, little) !== 0x0112) continue;
    const type = readU16(bytes, cursor + 2, little);
    const components = readU32(bytes, cursor + 4, little);
    if (type !== 3 || components !== 1) return null;
    const value = readU16(bytes, cursor + 8, little);
    return value >= 1 && value <= 8 ? value : null;
  }
  return null;
}

export function readJpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) return null;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      if (width < 1 || height < 1) return null;
      return { width, height };
    }
    offset += 2 + segmentLength;
  }
  return null;
}

export function readJpegExifOrientation(bytes: Uint8Array): number | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) return null;
    if (marker === 0xe1) {
      const start = offset + 4;
      if (
        bytes[start] === 0x45
        && bytes[start + 1] === 0x78
        && bytes[start + 2] === 0x69
        && bytes[start + 3] === 0x66
        && bytes[start + 4] === 0
        && bytes[start + 5] === 0
      ) {
        return readTiffOrientation(bytes, start + 6, offset + 2 + segmentLength);
      }
    }
    offset += 2 + segmentLength;
  }
  return null;
}

export function jpegExifQuarterTurn(bytes: Uint8Array): QuarterTurn {
  return quarterTurnFromExif(readJpegExifOrientation(bytes));
}
