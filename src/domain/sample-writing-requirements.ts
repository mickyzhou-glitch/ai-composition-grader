import {
  expectedSampleParagraphCount,
  type AssignmentConfig,
} from "./contracts";

interface SampleParagraphLike {
  title: string;
  text: string;
  suggestion: string;
}

export interface SampleParagraphCharacterRange {
  minimumCharacters: number;
  maximumCharacters: number;
}

export interface SampleWritingRequirements {
  paragraphCount: number;
  minimumCharacters: number;
  maximumCharacters: number;
  paragraphCharacterRanges?: SampleParagraphCharacterRange[];
}

const CHARACTER_REQUIREMENT = /(?:(\d{2,4})\s*[-‐‑‒–—−~～至到]\s*(\d{2,4})\s*字?|(?:约|大约)\s*(\d{2,4})\s*字?|(?<![\d])(?:(\d{2,4})\s*字\s*(?:左右|上下)))/gu;

const APPROXIMATE_CHARACTER_TOLERANCE = 20;

export function parseSampleParagraphCharacterRanges(
  structureRequirements: string,
  paragraphCount: number,
): SampleParagraphCharacterRange[] | null {
  const ranges = [...structureRequirements.matchAll(CHARACTER_REQUIREMENT)].map((match) => {
    const minimumCharacters = match[1] ? Number(match[1]) : Number(match[3] ?? match[4]);
    const maximumCharacters = match[2]
      ? Number(match[2])
      : minimumCharacters + APPROXIMATE_CHARACTER_TOLERANCE;
    return match[1] || match[2]
      ? { minimumCharacters, maximumCharacters }
      : {
        minimumCharacters: Math.max(1, minimumCharacters - APPROXIMATE_CHARACTER_TOLERANCE),
        maximumCharacters,
      };
  });
  if (
    ranges.length !== paragraphCount ||
    ranges.some(({ minimumCharacters, maximumCharacters }) =>
      minimumCharacters < 1 || maximumCharacters < minimumCharacters,
    )
  ) {
    return null;
  }
  return ranges;
}

export function resolveSampleWritingRequirements(
  config: AssignmentConfig,
): SampleWritingRequirements {
  const paragraphCount = expectedSampleParagraphCount(config);
  const paragraphCharacterRanges = parseSampleParagraphCharacterRanges(
    config.structureRequirements,
    paragraphCount,
  );
  const requirements: SampleWritingRequirements = {
    paragraphCount,
    minimumCharacters: Math.max(1, config.targetCharacters - 50),
    maximumCharacters: config.targetCharacters + 100,
  };
  if (paragraphCharacterRanges) requirements.paragraphCharacterRanges = paragraphCharacterRanges;
  return requirements;
}

export function countSampleTextCharacters(
  paragraphs: SampleParagraphLike[],
): number {
  return paragraphs.reduce(
    (total, paragraph) =>
      total + (paragraph.text.match(/\p{Script=Han}/gu)?.length ?? 0),
    0,
  );
}

export function validateSampleWritingRequirements(
  paragraphs: SampleParagraphLike[],
  config: AssignmentConfig,
): void {
  const expected = resolveSampleWritingRequirements(config);
  if (paragraphs.length !== expected.paragraphCount) {
    throw new Error(
      `sample paragraphs invalid: expectedParagraphs=${expected.paragraphCount}; ` +
      `actualParagraphs=${paragraphs.length}`,
    );
  }

  // Character targets are generation guidance only. The paragraph count remains
  // the structural requirement enforced by this validator.
}
