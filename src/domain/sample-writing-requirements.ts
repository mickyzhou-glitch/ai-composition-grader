import {
  expectedSampleParagraphCount,
  type AssignmentConfig,
} from "./contracts";

interface SampleParagraphLike {
  title: string;
  text: string;
  suggestion: string;
}

export interface SampleWritingRequirements {
  paragraphCount: number;
  minimumCharacters: number;
  maximumCharacters: number;
}

export function resolveSampleWritingRequirements(
  config: AssignmentConfig,
): SampleWritingRequirements {
  return {
    paragraphCount: expectedSampleParagraphCount(config),
    minimumCharacters: config.targetCharacters,
    maximumCharacters: Math.ceil(config.targetCharacters * 1.1),
  };
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
  const actualCharacters = countSampleTextCharacters(paragraphs);

  if (
    paragraphs.length !== expected.paragraphCount ||
    actualCharacters < expected.minimumCharacters ||
    actualCharacters > expected.maximumCharacters
  ) {
    throw new Error(
      `sample paragraphs invalid: expectedParagraphs=${expected.paragraphCount}; ` +
      `actualParagraphs=${paragraphs.length}; ` +
      `expectedCharacters=${expected.minimumCharacters}..${expected.maximumCharacters}; ` +
      `actualCharacters=${actualCharacters}`,
    );
  }
}
