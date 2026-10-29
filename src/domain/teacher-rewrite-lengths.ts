import { countHanCharacters } from "./sample-writing-requirements";

// Only parse unambiguous hard limits. Approximate targets and numbers in
// narrative facts must not become validation rules.
function constraints(guidance: string) {
  // 旧任务把抱怨写在「不合适原因」里，字数硬性要求只认「修改要求」之后。
  // 新任务的两个框都是要落实的要求，整段都要检查。
  const task = guidance.includes("[修改要求]") ? guidance.split("[修改要求]").at(-1) ?? "" : guidance;
  const number = "(10|[1-9]|[一二两三四五六七八九十])";
  const pattern = new RegExp(`(前|第)${number}(?:[、和与](?:第)?${number})?段\\s*(?:合计|总计)?\\s*(不超过|至多|最多|不少于|至少)\\s*(\\d{1,4})\\s*字`, "gu");
  const chinese: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const valueOf = (value: string) => chinese[value] ?? Number(value);
  const result: Array<{ indices: number[]; limit: number; minimum: boolean }> = [];
  for (const match of task.matchAll(pattern)) {
    const first = valueOf(match[2]);
    const indices = match[1] === "前"
      ? Array.from({ length: first }, (_, index) => index + 1)
      : [first, ...(match[3] ? [valueOf(match[3])] : [])];
    const limit = Number(match[5]);
    if (limit < 1 || limit > 4000) continue;
    result.push({ indices, limit, minimum: /不少于|至少/u.test(match[4]) });
  }
  return result;
}

export function teacherRewriteLengthRule(guidance = ""): string {
  return constraints(guidance).map(({ indices, limit, minimum }) =>
    `完整范文第${indices.join("、")}段${indices.length > 1 ? "合计" : ""}必须${minimum ? "不少于" : "不超过"}${limit}个汉字（不含标点）；建议${minimum ? "至少写到" : "控制在"}${minimum ? Math.ceil((limit * 11) / 10) : Math.floor((limit * 95) / 100)}个汉字${minimum ? "以上" : "以内"}，预留计数余量，不要压在边界上。`,
  ).join("\n");
}

export function validateTeacherRewriteLengths(essay: string[], guidance = ""): void {
  for (const { indices, limit, minimum } of constraints(guidance)) {
    if (indices.some((index) => !essay[index - 1])) continue;
    const actual = indices.reduce((sum, index) => sum + countHanCharacters(essay[index - 1]), 0);
    if (minimum ? actual < limit : actual > limit) {
      throw new Error(`rewritten_essay_chars_${indices.join("_")}_${minimum ? "min" : "max"}_${limit}_actual_${actual}`);
    }
  }
}
