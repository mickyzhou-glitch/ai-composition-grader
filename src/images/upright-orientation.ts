export type QuarterTurn = 0 | 90 | 180 | 270;

export interface LuminanceImage {
  width: number;
  height: number;
  luminance: Uint8Array;
}

const DOWNSAMPLE_MAX_SIDE = 96;
const INK_RATIO_FLOOR = 0.008;
const LINE_DOMINANCE = 1.8;
const ALIGN_MARGIN = 0.08;

export function addQuarterTurns(...turns: QuarterTurn[]): QuarterTurn {
  const sum = turns.reduce<number>((total, turn) => total + turn, 0) % 360;
  if (sum === 90 || sum === 180 || sum === 270) return sum;
  return 0;
}

export function quarterTurnFromExif(orientation: number | null | undefined): QuarterTurn {
  if (orientation === 3) return 180;
  if (orientation === 6) return 90;
  if (orientation === 8) return 270;
  return 0;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = average(values);
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

function inkCutoff(luminance: Uint8Array): number {
  const step = Math.max(1, Math.floor(luminance.length / 2000));
  let sum = 0;
  let count = 0;
  for (let index = 0; index < luminance.length; index += step) {
    sum += luminance[index];
    count += 1;
  }
  const mean = count === 0 ? 255 : sum / count;
  return Math.max(40, Math.min(210, mean - 25));
}

function downsample(image: LuminanceImage, maxSide: number): LuminanceImage {
  const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
  if (scale === 1) return image;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const luminance = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor((y * image.height) / height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor((x * image.width) / width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / width));
      let darkest = 255;
      for (let sy = y0; sy < y1; sy += 1) {
        const row = sy * image.width;
        for (let sx = x0; sx < x1; sx += 1) {
          const value = image.luminance[row + sx];
          if (value < darkest) darkest = value;
        }
      }
      luminance[y * width + x] = darkest;
    }
  }
  return { width, height, luminance };
}

function rotateClockwise(image: LuminanceImage, turn: QuarterTurn): LuminanceImage {
  if (turn === 0) return image;
  const { width, height, luminance } = image;
  if (turn === 180) {
    const rotated = new Uint8Array(luminance.length);
    for (let index = 0; index < luminance.length; index += 1) {
      rotated[luminance.length - 1 - index] = luminance[index];
    }
    return { width, height, luminance: rotated };
  }
  const rotated = new Uint8Array(luminance.length);
  const nextWidth = height;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = luminance[y * width + x];
      if (turn === 90) {
        const nextX = height - 1 - y;
        const nextY = x;
        rotated[nextY * nextWidth + nextX] = value;
      } else {
        const nextX = y;
        const nextY = width - 1 - x;
        rotated[nextY * nextWidth + nextX] = value;
      }
    }
  }
  return { width: nextWidth, height: width, luminance: rotated };
}

function measure(image: LuminanceImage) {
  const cutoff = inkCutoff(image.luminance);
  const rowInk = new Array<number>(image.height).fill(0);
  const lefts: number[] = [];
  const rights: number[] = [];
  let inkCount = 0;
  const minRun = Math.max(2, Math.round(image.width * 0.04));
  for (let y = 0; y < image.height; y += 1) {
    let count = 0;
    let left = -1;
    let right = -1;
    const row = y * image.width;
    for (let x = 0; x < image.width; x += 1) {
      if (image.luminance[row + x] > cutoff) continue;
      count += 1;
      inkCount += 1;
      if (left < 0) left = x;
      right = x;
    }
    rowInk[y] = count;
    if (count >= minRun && left >= 0 && right >= left) {
      lefts.push(left / image.width);
      rights.push(right / image.width);
    }
  }
  const line = variance(rowInk) / (image.width * image.width);
  let align = 0;
  if (lefts.length >= 3) {
    align = variance(rights) - variance(lefts) + (0.35 - average(lefts));
  }
  return {
    line,
    align,
    inkRatio: inkCount / image.luminance.length,
  };
}

/**
 * Clockwise quarter turn that makes handwritten Chinese lines horizontal
 * and left-aligned. Returns 0 when the page is already upright or has no
 * reliable text lines, so a second pass does not keep rotating it.
 */
export function chooseUprightQuarterTurn(image: LuminanceImage): QuarterTurn {
  if (image.width < 2 || image.height < 2 || image.luminance.length < image.width * image.height) {
    return 0;
  }
  const base = downsample(image, DOWNSAMPLE_MAX_SIDE);
  const turns: QuarterTurn[] = [0, 90, 180, 270];
  const scored = turns.map((turn) => ({
    turn,
    ...measure(rotateClockwise(base, turn)),
  }));
  const upright = scored[0];
  const bestLine = Math.max(...scored.map((item) => item.line));
  const contenders = scored.filter((item) => (
    item.line >= bestLine * 0.75 && item.inkRatio >= INK_RATIO_FLOOR
  ));
  if (contenders.length === 0) return 0;
  contenders.sort((left, right) => right.align - left.align || left.turn - right.turn);
  const winner = contenders[0];
  if (winner.turn === 0) return 0;
  const clearlySideways = winner.line > upright.line * LINE_DOMINANCE;
  const clearlyUpsideDown = winner.align > upright.align + ALIGN_MARGIN
    && winner.line >= upright.line * 0.75;
  if (!clearlySideways && !clearlyUpsideDown) return 0;
  return winner.turn;
}
