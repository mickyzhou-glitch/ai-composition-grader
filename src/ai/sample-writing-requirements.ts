import type { AssignmentConfig } from "../domain/contracts";
import {
  resolveSampleWritingRequirements,
  type SampleParagraphCharacterRange,
} from "../domain/sample-writing-requirements";

export {
  countSampleTextCharacters,
  resolveSampleWritingRequirements,
  validateSampleWritingRequirements,
} from "../domain/sample-writing-requirements";

/** Name the paragraphs the teacher wants expanded, so 详略 is not left implicit. */
function describeDetailBalance(ranges: readonly SampleParagraphCharacterRange[]): string {
  const widest = Math.max(...ranges.map(({ maximumCharacters }) => maximumCharacters));
  const narrowest = Math.min(...ranges.map(({ maximumCharacters }) => maximumCharacters));
  if (widest <= narrowest) return "";
  const detailed = ranges.flatMap((range, index) => range.maximumCharacters === widest ? [index + 1] : []);
  const brief = ranges.flatMap((range, index) => range.maximumCharacters === narrowest ? [index + 1] : []);
  return `第${detailed.join("、")}段是详写段，必须明显比第${brief.join("、")}段写得充分、具体；`;
}

export function buildSampleWritingRule(config: AssignmentConfig): string {
  const expected = resolveSampleWritingRequirements(config);
  const primarySchoolVoice = /(?:五升六|小升初|小学)/u.test(config.grade)
    ? "本题指定的是小学阶段水平，不得写成初中生或成人范文；保持小学生真实自然的口吻。"
    : "不得写成高于指定年级的学生水平或成人范文。";

  const ranges = expected.paragraphCharacterRanges;
  const characterRule = ranges
    ? [
      "教师已为每段填写建议字数；这些数字只作生成参考，不是校验条件，实际不足或超出都正常返回。",
      ...ranges.map((range, index) =>
        `第${index + 1}段 text 建议参考 ${range.minimumCharacters}-${range.maximumCharacters} 个汉字；`,
      ),
      // 不拒绝字数，但参考值决定详略：否则模型会把各段写成差不多的长度。
      `建议字数的作用是分配详略：${describeDetailBalance(ranges)}不要把各段写成差不多的长度，也不要为凑字数注水或删掉必要内容。`,
    ].join("\n")
    : `只统计各段 text 的汉字，目标参考范围为 ${expected.minimumCharacters}-${expected.maximumCharacters} 个汉字，仅作生成参考；` +
      `实际低于${expected.minimumCharacters}或超过${expected.maximumCharacters}个汉字也可正常返回，不要为了凑字数或删减编造内容；` +
      "title、suggestion 和标点不计入。";

  return [
    "教师填写的作业配置是唯一标准，通用教学建议不得覆盖或改写它。",
    `范文作者的学生水平必须严格符合：${JSON.stringify(config.grade)}。`,
    `年级指学生实际能自然写出的水平，不是批改老师的身份；${primarySchoolVoice}`,
    `写作要求：${JSON.stringify(config.writingRequirements)}`,
    `结构与格式：${JSON.stringify(config.structureRequirements)}`,
    `评分重点：${JSON.stringify(config.scoringFocus)}`,
    "写作要求和结构与格式中括号内的例子只说明手法，是示例不是素材：必须换成贴合本篇实际材料的细节，不得把示例词句原样写进范文。",
    `sampleParagraphs 必须恰好 ${expected.paragraphCount} 段。`,
    characterRule,
    "输出前自查词汇、句式、表达方式和思考深度是否符合指定学生水平。",
  ].join("\n");
}
