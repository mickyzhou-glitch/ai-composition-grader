export const MAX_STORED_TEACHER_GUIDANCE_CHARS = 4_000;
export const MAX_STANDING_GUIDANCE_CHARS = 2_500;
export const MAX_GRADING_OPINION_BODY_CHARS = 1_200;

export const STANDING_GUIDANCE_HEADER =
  "以下是这位老师存档的长期批改要求，每次批改都必须遵守。与本次补充意见冲突时，以本次补充意见为准；与原文事实冲突时，以原文为准。";

export interface StandingOpinionInput {
  body: string;
  createdAt: number;
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

export function opinionDedupeKey(body: string): string {
  return body.trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
}

/** Keep the teacher's own note within its limit, then append the newest unique archived opinions that fit. */
export function guidanceWithStandingOpinions(
  current: string | null | undefined,
  opinions: readonly StandingOpinionInput[],
): string | null {
  const user = current?.trim() ?? "";
  const standing = formatStandingBlock(dedupeNewest(opinions), standingBudget(user));
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

function dedupeNewest(opinions: readonly StandingOpinionInput[]): string[] {
  const sorted = [...opinions].sort((left, right) => right.createdAt - left.createdAt);
  const seen = new Set<string>();
  const bodies: string[] = [];
  for (const opinion of sorted) {
    const body = opinion.body.trim();
    if (!body) continue;
    const key = opinionDedupeKey(body);
    if (seen.has(key)) continue;
    seen.add(key);
    bodies.push(body);
  }
  return bodies;
}

function numberedOpinion(index: number, body: string): string {
  return body.split("\n").map((line, lineIndex) => (
    lineIndex === 0 ? `${index}. ${line}` : `   ${line}`
  )).join("\n");
}

function formatStandingBlock(bodies: readonly string[], budget: number): string | null {
  if (budget <= STANDING_GUIDANCE_HEADER.length + 1) return null;
  const selected: string[] = [];
  let used = STANDING_GUIDANCE_HEADER.length + 1;
  for (const body of bodies) {
    const line = numberedOpinion(selected.length + 1, body);
    const addition = line.length + (selected.length > 0 ? 1 : 0);
    if (used + addition > budget) continue;
    selected.push(line);
    used += addition;
  }
  if (selected.length === 0) return null;
  return `${STANDING_GUIDANCE_HEADER}\n${selected.join("\n")}`;
}
