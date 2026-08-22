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

const CHARACTER_RANGE = /(\d{2,4})\s*[-‐‑‒–—−~～至到]\s*(\d{2,4})\s*字?/gu;

export function parseSampleParagraphCharacterRanges(
  structureRequirements: string,
  paragraphCount: number,
): SampleParagraphCharacterRange[] | null {
  const ranges = [...structureRequirements.matchAll(CHARACTER_RANGE)].map((match) => ({
    minimumCharacters: Number(match[1]),
    maximumCharacters: Number(match[2]),
  }));
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

  if (expected.paragraphCharacterRanges) {
    const invalidIndex = expected.paragraphCharacterRanges.findIndex((range, index) => {
      const actualCharacters = paragraphs[index].text.match(/\p{Script=Han}/gu)?.length ?? 0;
      return actualCharacters < range.minimumCharacters || actualCharacters > range.maximumCharacters;
    });
    if (invalidIndex >= 0) {
      const range = expected.paragraphCharacterRanges[invalidIndex];
      const actualCharacters = paragraphs[invalidIndex].text.match(/\p{Script=Han}/gu)?.length ?? 0;
      throw new Error(
        `sample paragraphs invalid: expectedParagraphs=${expected.paragraphCount}; ` +
        `actualParagraphs=${paragraphs.length}; paragraphIndex=${invalidIndex + 1}; ` +
        `expectedParagraphCharacters=${range.minimumCharacters}..${range.maximumCharacters}; ` +
        `actualParagraphCharacters=${actualCharacters}`,
      );
    }
    return;
  }

  const actualCharacters = countSampleTextCharacters(paragraphs);

  if (actualCharacters < expected.minimumCharacters || actualCharacters > expected.maximumCharacters) {
    throw new Error(
      `sample paragraphs invalid: expectedParagraphs=${expected.paragraphCount}; ` +
      `actualParagraphs=${paragraphs.length}; ` +
      `expectedCharacters=${expected.minimumCharacters}..${expected.maximumCharacters}; ` +
      `actualCharacters=${actualCharacters}`,
    );
  }
}
