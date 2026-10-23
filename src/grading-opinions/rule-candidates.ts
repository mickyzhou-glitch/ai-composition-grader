import { normalizeAssignmentTitle } from "../reanalysis/contracts";
import {
  classifyOpinion,
  paragraphLabelFromText,
  type OpinionCategory,
} from "./standing-guidance";

/** 一条原始意见（批量审核修改意见或退回意见）。 */
export interface RuleSourceOpinion {
  text: string;
  reviewId?: string | null;
  studentName?: string;
  kind?: "revision" | "rejection" | "history";
}

export interface RuleCandidateDraft {
  title: string;
  ruleText: string;
  category: OpinionCategory;
  paragraphLabel: string | null;
  sources: RuleSourceOpinion[];
}

/** 已有的待审批候选或已生效规则，只按完全相同原文合并或跳过。 */
export interface ExistingRule {
  id: string;
  ruleText: string;
  status: "pending" | "approved";
  sources: RuleSourceOpinion[];
}

export interface RuleCandidatePlan {
  create: RuleCandidateDraft[];
  merge: Array<{ id: string; sources: RuleSourceOpinion[] }>;
  skipped: Array<{ text: string; reason: "invalid" | "already_approved" | "duplicate_source" }>;
}

const EMPTY_OPINION = /^(无|没有|暂无|无意见|没意见|无修改|不用改|无需修改|同上|ok|none|null|n\/?a|[-—_.。，,、!！?？~～\s]*)$/iu;
const TEST_OPINION = /^(测试|test|testing|asdf|qwer|aaa+|111+|123+|哈哈+|随便)/iu;

/** 过滤「无」、空内容和测试数据。 */
export function isMeaningfulOpinion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || EMPTY_OPINION.test(trimmed)) return false;
  if (TEST_OPINION.test(trimmed) && trimmed.length <= 12) return false;
  if (/测试/u.test(trimmed) && trimmed.replace(/[\s\p{P}]/gu, "").length <= 8) return false;
  return normalizeOpinionKey(trimmed).length >= 2;
}

function normalizeOpinionKey(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

/** 展示、审批共用的原话：来源按完整字符串去重，旧数据没有可用来源时回退 ruleText。 */
export function originalRuleTexts(candidate: {
  ruleText: string;
  sources: ReadonlyArray<{ text: string }>;
}): string[] {
  const originals = [...new Set(candidate.sources.map(({ text }) => text).filter((text) => text.trim().length > 0))];
  return originals.length ? originals : candidate.ruleText.trim() ? [candidate.ruleText] : [];
}

/** 同一篇作文的相同原话只计一次；不同来源保留在同一候选中。 */
function sourceKey(source: RuleSourceOpinion): string | null {
  return source.reviewId ? JSON.stringify([source.reviewId, source.text]) : null;
}

/**
 * 过滤无效意见后保留老师原话。仅完全相同原文可以跳过已生效规则或合并待审批来源。
 */
export async function planRuleCandidates(input: {
  title: string;
  opinions: RuleSourceOpinion[];
  existing: ExistingRule[];
}): Promise<RuleCandidatePlan> {
  const title = normalizeAssignmentTitle(input.title);
  const plan: RuleCandidatePlan = { create: [], merge: [], skipped: [] };
  if (!title) return plan;
  const seen = new Set(input.existing.flatMap((rule) => rule.sources.map(sourceKey)).filter((key): key is string => key !== null));
  const fresh: RuleSourceOpinion[] = [];
  for (const opinion of input.opinions) {
    const text = opinion.text;
    if (!isMeaningfulOpinion(text)) { plan.skipped.push({ text, reason: "invalid" }); continue; }
    const source = { ...opinion, text };
    const key = sourceKey(source);
    if (key && seen.has(key)) { plan.skipped.push({ text, reason: "duplicate_source" }); continue; }
    if (key) seen.add(key);
    fresh.push(source);
  }
  const merges = new Map<string, RuleSourceOpinion[]>();
  const unmatched = new Map<string, RuleSourceOpinion[]>();
  const approvedTexts = new Set(input.existing.filter((rule) => rule.status === "approved").map((rule) => rule.ruleText));
  const pendingByText = new Map<string, ExistingRule>();
  for (const rule of input.existing.filter((rule) => rule.status === "pending")) {
    for (const text of originalRuleTexts(rule)) {
      if (!pendingByText.has(text)) pendingByText.set(text, rule);
    }
  }
  for (const source of fresh) {
    if (approvedTexts.has(source.text)) {
      plan.skipped.push({ text: source.text, reason: "already_approved" });
      continue;
    }
    const match = pendingByText.get(source.text);
    if (match) merges.set(match.id, [...(merges.get(match.id) ?? []), source]);
    else unmatched.set(source.text, [...(unmatched.get(source.text) ?? []), source]);
  }
  plan.merge = [...merges.entries()].map(([id, sources]) => ({ id, sources }));
  for (const [ruleText, sources] of unmatched) {
    plan.create.push({
      title,
      ruleText,
      category: classifyOpinion(ruleText, ""),
      paragraphLabel: paragraphLabelFromText(ruleText),
      sources,
    });
  }
  return plan;
}

/** 退回意见的「原因」和「修改要求」合成一条来源意见。 */
export function rejectionOpinionText(reason: string, changeRequest: string): string {
  const parts = [reason.trim(), changeRequest.trim()].filter(isMeaningfulOpinion);
  return parts.join("；");
}
