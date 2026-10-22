export const MAX_STORED_TEACHER_GUIDANCE_CHARS = 4_000;
export const MAX_STANDING_GUIDANCE_CHARS = 2_500;
export const MAX_GRADING_OPINION_BODY_CHARS = 1_200;

export const OPINION_CATEGORIES = ["结构", "内容", "语言", "字数", "其他"] as const;
export type OpinionCategory = (typeof OPINION_CATEGORIES)[number];

export const STANDING_GUIDANCE_HEADER =
  "以下是这位老师存档的长期批改要求，已归纳成规则清单，每次批改都必须遵守。与本次补充意见冲突时，以本次补充意见为准；与原文事实冲突时，以原文为准。";

export interface StandingOpinionInput {
  reason: string;
  changeRequest: string;
  paragraphLabel?: string | null;
  category?: OpinionCategory;
  createdAt: number;
}

export interface ParsedRevisionGuidance {
  reason: string;
  changeRequest: string;
}

export function isOpinionCategory(value: string): value is OpinionCategory {
  return (OPINION_CATEGORIES as readonly string[]).includes(value);
}

export function gradingOpinionBody(reason: string, changeRequest: string): string | null {
  const lines: string[] = [];
  const trimmedReason = reason.trim();
  const trimmedChange = changeRequest.trim();
  if (trimmedReason) lines.push(`为什么不合适：${trimmedReason}`);
  if (trimmedChange) lines.push(`应该怎么改：${trimmedChange}`);
  if (lines.length === 0) return null;
  return lines.join("\n").slice(0, MAX_GRADING_OPINION_BODY_CHARS);
}

const PARAGRAPH_DIGITS: Record<string, string> = {
  一: "1",
  二: "2",
  三: "3",
  四: "4",
  五: "5",
  六: "6",
  七: "7",
  八: "8",
  九: "9",
  十: "10",
};

export function paragraphLabelFromText(text: string): string | null {
  const labels = [...text.matchAll(/第([一二三四五六七八九十]|10|[1-9])段/gu)]
    .map((match) => `第${PARAGRAPH_DIGITS[match[1] ?? ""] ?? match[1]}段`);
  const unique = [...new Set(labels)];
  return unique.length > 0 ? unique.join("、") : null;
}

export function classifyOpinion(reason: string, changeRequest: string): OpinionCategory {
  const text = `${reason}\n${changeRequest}`;
  if (/字数|不少于|不超过|字以内|个字|详略|篇幅/u.test(text)) return "字数";
  if (/段|结构|框架|开头|结尾|层次|首段|尾段/u.test(text)) return "结构";
  if (/语言|用词|修辞|生硬|口语|病句|表达/u.test(text)) return "语言";
  if (/内容|事例|情节|细节|离题|跑题|切题|选材|一件事|心理/u.test(text)) return "内容";
  return "其他";
}

export function describeGradingOpinion(reason: string, changeRequest: string): {
  reason: string;
  changeRequest: string;
  paragraphLabel: string | null;
  category: OpinionCategory;
  body: string;
} | null {
  const trimmedReason = reason.trim();
  const trimmedChange = changeRequest.trim();
  const body = gradingOpinionBody(trimmedReason, trimmedChange);
  if (!body) return null;
  return {
    reason: trimmedReason,
    changeRequest: trimmedChange,
    paragraphLabel: paragraphLabelFromText(`${trimmedReason}\n${trimmedChange}`),
    category: classifyOpinion(trimmedReason, trimmedChange),
    body,
  };
}

const STANDING_GUIDANCE_MARK = "以下是这位老师存档的长期批改要求";

/** Read the two fields stored on a revision job, ignoring any later standing-rule block. */
export function parseRevisionTeacherGuidance(guidance: string | null | undefined): ParsedRevisionGuidance | null {
  if (!guidance) return null;
  const submission = guidance.split(STANDING_GUIDANCE_MARK)[0] ?? "";
  const match = submission.match(/\[不合适原因\]\n([\s\S]*?)\n\[修改要求\]\n([\s\S]*)$/u);
  if (!match) return null;
  const reason = match[1]?.trim() ?? "";
  const changeRequest = match[2]?.trim() ?? "";
  if (!reason || !changeRequest) return null;
  return { reason, changeRequest };
}

/** Read an older archive row that stored both fields in one body. */
export function parseArchivedOpinionBody(body: string | null | undefined): ParsedRevisionGuidance | null {
  if (!body) return null;
  const match = body.match(/^为什么不合适：([\s\S]*?)\n应该怎么改：([\s\S]*)$/u);
  if (!match) return null;
  const reason = match[1]?.trim() ?? "";
  const changeRequest = match[2]?.trim() ?? "";
  if (!reason || !changeRequest) return null;
  return { reason, changeRequest };
}

export function opinionDedupeKey(body: string): string {
  return body.trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
}

/** Keep this submission intact, then append a deduped rule list that fits the length budget. */
export function guidanceWithStandingOpinions(
  current: string | null | undefined,
  opinions: readonly StandingOpinionInput[],
): string | null {
  const user = current?.trim() ?? "";
  const standing = formatStandingBlock(aggregateRules(opinions), standingBudget(user));
  if (!standing) return user || null;
  return user ? `${user}\n\n${standing}` : standing;
}

function standingBudget(user: string): number {
  const separator = user ? 2 : 0;
  return Math.min(
    MAX_STANDING_GUIDANCE_CHARS,
    MAX_STORED_TEACHER_GUIDANCE_CHARS - user.length - separator,
  );
}

interface StandingRule {
  category: OpinionCategory;
  reason: string;
  changeRequest: string;
  paragraphLabel: string | null;
  createdAt: number;
  count: number;
}

function aggregateRules(opinions: readonly StandingOpinionInput[]): StandingRule[] {
  const sorted = [...opinions].sort((left, right) => right.createdAt - left.createdAt);
  const rules = new Map<string, StandingRule>();
  for (const opinion of sorted) {
    const reason = opinion.reason.trim();
    const changeRequest = opinion.changeRequest.trim();
    if (!reason && !changeRequest) continue;
    const paragraphLabel = opinion.paragraphLabel?.trim()
      || paragraphLabelFromText(`${reason}\n${changeRequest}`);
    const key = opinionDedupeKey([paragraphLabel, reason, changeRequest].filter(Boolean).join(" "));
    const existing = rules.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const category = opinion.category && isOpinionCategory(opinion.category)
      ? opinion.category
      : classifyOpinion(reason, changeRequest);
    rules.set(key, {
      category,
      reason,
      changeRequest,
      paragraphLabel,
      createdAt: opinion.createdAt,
      count: 1,
    });
  }
  return [...rules.values()];
}

function ruleText(rule: StandingRule, index: number): string {
  const where = rule.paragraphLabel ? `（${rule.paragraphLabel}）` : "";
  const times = rule.count > 1 ? `（出现 ${rule.count} 次）` : "";
  const lines = [`${index}. 应该怎么改：${rule.changeRequest}${where}${times}`];
  if (rule.reason) lines.push(`   为什么不合适：${rule.reason}`);
  return lines.join("\n");
}

function formatStandingBlock(rules: readonly StandingRule[], budget: number): string | null {
  if (budget <= STANDING_GUIDANCE_HEADER.length + 1) return null;
  let text = STANDING_GUIDANCE_HEADER;
  for (const category of OPINION_CATEGORIES) {
    const group = rules
      .filter((rule) => rule.category === category)
      .sort((left, right) => right.createdAt - left.createdAt);
    if (group.length === 0) continue;
    let section = `【${category}】`;
    let kept = 0;
    for (const rule of group) {
      const line = ruleText(rule, kept + 1);
      const candidate = `${text}\n${section}\n${line}`;
      if (candidate.length > budget) continue;
      section = `${section}\n${line}`;
      kept += 1;
    }
    if (kept > 0) text = `${text}\n${section}`;
  }
  return text === STANDING_GUIDANCE_HEADER ? null : text;
}
