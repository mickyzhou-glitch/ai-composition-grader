import {
  expectedSampleParagraphCount,
  type AssignmentConfig,
} from "../domain/contracts";

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

export function buildSampleWritingRule(config: AssignmentConfig): string {
  const expected = resolveSampleWritingRequirements(config);

  return [
    "教师填写的作业配置是唯一标准，通用教学建议不得覆盖或改写它。",
    `范文作者的学生水平必须严格符合：${JSON.stringify(config.grade)}。`,
    "年级指学生实际能自然写出的水平，不是批改老师的身份；不得写成初中生或成人范文。",
    `写作要求：${JSON.stringify(config.writingRequirements)}`,
    `结构与格式：${JSON.stringify(config.structureRequirements)}`,
    `评分重点：${JSON.stringify(config.scoringFocus)}`,
    `sampleParagraphs 必须恰好 ${expected.paragraphCount} 段。`,
    `只统计各段 text 的汉字，合计必须为 ${expected.minimumCharacters}-${expected.maximumCharacters} 个汉字；title、suggestion 和标点不计入。`,
    "输出前自查词汇、句式、修辞和感悟是否符合指定学生水平，并保留小学生真实自然的口吻。",
  ].join("\n");
}
