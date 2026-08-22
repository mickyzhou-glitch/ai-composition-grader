const NUMBERED_ITEM = /(?:^|[\s])([1-9]\d?)[.、．)）]\s*/gu;

export const STRUCTURE_COVERAGE_ERROR_PREFIX = "structure coverage invalid";

export function parseNumberedStructureRequirements(value: string): string[] | null {
  const matches = [...value.matchAll(NUMBERED_ITEM)];
  if (matches.length < 2) return null;

  const numbers = matches.map((match) => Number(match[1]));
  if (numbers.some((number, index) => number !== index + 1)) return null;

  const items = matches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? value.length;
    return value.slice(start, end).trim();
  });
  return items.every(Boolean) ? items : null;
}

export function buildStructureReviewRule(structureRequirements: string): string {
  const items = parseNumberedStructureRequirements(structureRequirements);
  if (!items) {
    return `必须按照教师填写的结构要求逐段核对学生原文：${JSON.stringify(structureRequirements)}。缺少要求、顺序错误、段落混乱或格式不符时，必须明确指出原文位置和修改方法。`;
  }

  const checklist = items.map((item, index) => `${index + 1}. ${item}`).join("\n");
  const markers = items.map((_, index) => `【第${index + 1}项】`).join("、");
  return [
    `教师填写了 ${items.length} 项结构要求，必须先逐项核对原文，再判断等级：`,
    checklist,
    `diagnostics.structure.finding 必须恰好输出 ${items.length} 个非空行，并按顺序以 ${markers} 开头。`,
    "每行格式必须是“【第N项】符合：原文依据”“【第N项】部分符合：原文依据”或“【第N项】不符合：原文依据”；不得用一句总评代替逐项分析。",
    "diagnostics.structure.action 只针对部分符合或不符合的项目给出能直接执行的修改；若全部符合，明确写无需结构调整。",
    "发现结构问题时，在原文可辨认的对应句子或段落起点生成结构批注；坐标或锚点不确定时不要臆造。",
  ].join("\n");
}

export function validateStructureRequirementCoverage(
  finding: string,
  structureRequirements: string,
): void {
  const items = parseNumberedStructureRequirements(structureRequirements);
  if (!items) return;

  const lines = finding.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const valid = lines.length === items.length && lines.every((line, index) => {
    const marker = `【第${index + 1}项】`;
    const remainder = line.slice(marker.length);
    return line.startsWith(marker) && /^(?:部分符合|不符合|符合)[：:]\S+/u.test(remainder);
  });
  if (!valid) {
    throw new Error(`${STRUCTURE_COVERAGE_ERROR_PREFIX}: expected=${items.length}`);
  }
}
