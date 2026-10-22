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

/** 已有的待审批候选或已生效规则，用来合并或跳过相近的新意见。 */
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

/** 由 AI 把一组相近意见归纳成一条可长期执行的规则。 */
export interface RuleSummarizer {
  summarize(input: { title: string; groups: string[][] }): Promise<string[]>;
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

export function normalizeOpinionKey(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function bigrams(text: string): Map<string, number> {
  const key = normalizeOpinionKey(text);
  const result = new Map<string, number>();
  const chars = [...key];
  if (chars.length === 1) result.set(key, 1);
  for (let index = 0; index < chars.length - 1; index += 1) {
    const gram = chars[index]! + chars[index + 1]!;
    result.set(gram, (result.get(gram) ?? 0) + 1);
  }
  return result;
}

/** Dice 相似度；一方完整包含另一方时视为相同。 */
export function opinionSimilarity(left: string, right: string): number {
  const a = normalizeOpinionKey(left);
  const b = normalizeOpinionKey(right);
  if (!a || !b) return 0;
  if (a === b || (Math.min(a.length, b.length) >= 6 && (a.includes(b) || b.includes(a)))) return 1;
  const x = bigrams(a);
  const y = bigrams(b);
  let overlap = 0;
  let total = 0;
  x.forEach((count, gram) => { overlap += Math.min(count, y.get(gram) ?? 0); total += count; });
  y.forEach((count) => { total += count; });
  return total ? (2 * overlap) / total : 0;
}

export const SIMILAR_THRESHOLD = 0.6;

/** 把相近意见合成一组，组内顺序保持输入顺序。 */
export function groupSimilarOpinions(opinions: RuleSourceOpinion[]): RuleSourceOpinion[][] {
  const groups: RuleSourceOpinion[][] = [];
  for (const opinion of opinions) {
    const group = groups.find((items) => items.some((item) => opinionSimilarity(item.text, opinion.text) >= SIMILAR_THRESHOLD));
    if (group) group.push(opinion);
    else groups.push([opinion]);
  }
  return groups;
}

/** 无 AI 时的归纳：取组里信息最多（最长）的一条，去掉首尾空白。 */
export function fallbackRuleText(group: string[]): string {
  return [...group].map((text) => text.trim()).sort((a, b) => b.length - a.length)[0] ?? "";
}

export const fallbackSummarizer: RuleSummarizer = {
  async summarize({ groups }) {
    return groups.map(fallbackRuleText);
  },
};

/** 同一篇作文的同一条意见只计一次；没有作文来源的意见不在这里去重（交给相近合并）。 */
function sourceKey(source: RuleSourceOpinion): string | null {
  return source.reviewId ? `${source.reviewId}|${normalizeOpinionKey(source.text)}` : null;
}

/**
 * 归纳一批新意见：过滤无效内容，合并重复/相近的意见；
 * 与已生效规则相近的跳过，与待审批候选相近的并入该候选，其余生成新候选。
 */
export async function planRuleCandidates(input: {
  title: string;
  opinions: RuleSourceOpinion[];
  existing: ExistingRule[];
  summarizer?: RuleSummarizer;
}): Promise<RuleCandidatePlan> {
  const title = normalizeAssignmentTitle(input.title);
  const plan: RuleCandidatePlan = { create: [], merge: [], skipped: [] };
  if (!title) return plan;
  const seen = new Set(input.existing.flatMap((rule) => rule.sources.map(sourceKey)).filter((key): key is string => key !== null));
  const fresh: RuleSourceOpinion[] = [];
  for (const opinion of input.opinions) {
    const text = opinion.text.trim();
    if (!isMeaningfulOpinion(text)) { plan.skipped.push({ text, reason: "invalid" }); continue; }
    const source = { ...opinion, text };
    const key = sourceKey(source);
    if (key && seen.has(key)) { plan.skipped.push({ text, reason: "duplicate_source" }); continue; }
    if (key) seen.add(key);
    fresh.push(source);
  }
  const merges = new Map<string, RuleSourceOpinion[]>();
  const unmatched: RuleSourceOpinion[] = [];
  const approvedKeys = new Set(input.existing.filter((rule) => rule.status === "approved").map((rule) => normalizeOpinionKey(rule.ruleText)));
  for (const source of fresh) {
    // 与已通过规则一字不差（只差标点空白）才跳过；编辑过的内容按新意见处理。
    if (approvedKeys.has(normalizeOpinionKey(source.text))) {
      plan.skipped.push({ text: source.text, reason: "already_approved" });
      continue;
    }
    const match = input.existing
      .filter((rule) => rule.status === "pending")
      .map((rule) => ({ rule, score: Math.max(opinionSimilarity(rule.ruleText, source.text), ...rule.sources.map((item) => opinionSimilarity(item.text, source.text))) }))
      .filter(({ score }) => score >= SIMILAR_THRESHOLD)
      .sort((a, b) => b.score - a.score)[0]?.rule;
    if (match) merges.set(match.id, [...(merges.get(match.id) ?? []), source]);
    else unmatched.push(source);
  }
  plan.merge = [...merges.entries()].map(([id, sources]) => ({ id, sources }));
  const groups = groupSimilarOpinions(unmatched);
  if (!groups.length) return plan;
  const texts = groups.map((group) => group.map(({ text }) => text));
  let rules: string[];
  try {
    rules = await (input.summarizer ?? fallbackSummarizer).summarize({ title, groups: texts });
    if (rules.length !== groups.length || rules.some((rule) => !rule.trim())) throw new Error("summary_count_mismatch");
  } catch {
    rules = await fallbackSummarizer.summarize({ title, groups: texts });
  }
  groups.forEach((group, index) => {
    const ruleText = rules[index]!.trim();
    const joined = group.map(({ text }) => text).join("\n");
    plan.create.push({
      title,
      ruleText,
      category: classifyOpinion(joined, ruleText),
      paragraphLabel: paragraphLabelFromText(ruleText) ?? paragraphLabelFromText(joined),
      sources: group,
    });
  });
  return plan;
}

/** 退回意见的「原因」和「修改要求」合成一条来源意见。 */
export function rejectionOpinionText(reason: string, changeRequest: string): string {
  const parts = [reason.trim(), changeRequest.trim()].filter(isMeaningfulOpinion);
  return parts.join("；");
}

/** 共性意见按行拆开：老师可能勾选多条已有规则再手写补充，每行单独判断。 */
export function splitOpinionLines(text: string): string[] {
  return text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}
