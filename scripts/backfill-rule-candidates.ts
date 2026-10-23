import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { opinionSourceTitle } from "../src/grading-opinions/grading-opinion-repository";
import {
  planRuleCandidates,
  rejectionOpinionText,
  type ExistingRule,
  type RuleCandidateDraft,
  type RuleSourceOpinion,
} from "../src/grading-opinions/rule-candidates";
import { parseRevisionTeacherGuidance } from "../src/grading-opinions/standing-guidance";
import { normalizeAssignmentTitle } from "../src/reanalysis/contracts";
import { executeRemoteD1, type D1StatementResult } from "./sync-model-essays";

export const DEFAULT_TITLES = ["这件事打动了我", "为自己鼓掌"];

type Execute = (statement: string) => D1StatementResult;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function sourceOpinions(value: unknown): RuleSourceOpinion[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is RuleSourceOpinion => typeof item === "object" && item !== null && typeof item.text === "string")
    : [];
}

function sqlText(value: string | null): string {
  return value === null ? "NULL" : `'${value.replace(/'/gu, "''")}'`;
}

export interface BackfillTitlePlan {
  ownerId: string;
  title: string;
  inspected: number;
  create: RuleCandidateDraft[];
  skipped: number;
}

/**
 * 只读收集历史意见：已存档的意见（不含已生效的长期规则）、旧任务里的退回说明、作文上的退回意见。
 * 按 owner + 同名题目分组，保留原话生成候选规则（只生成待审批，不自动通过）。
 */
/** 一眼可见的通用要求（结构、段落、字数、开头结尾、名言、详略等）。 */
const GENERAL_OPINION = /结构|五段|段|名人名言|名言|欲扬先抑|抑|扬|字数|开头|结尾|框架|详略|铺垫|引入|语言/u;
/** 针对单篇的具体内容：人物、真实姓名、指定情节或引用原句。 */
const SPECIFIC_OPINION = /[“"「][^”"」]{2,}[”"」]|爷爷|奶奶|阿姨|叔叔|父亲|母亲|爸爸|妈妈|老师是|金老师|主角|姓名|改为|改成|换成|这个事情|这件事/u;

export function isGeneralOpinion(text: string): boolean {
  return GENERAL_OPINION.test(text) && !SPECIFIC_OPINION.test(text);
}

/** 从任务里的老师补充意见取出两栏：只取本次提交部分，不含后面附带的长期规则清单。 */
export function revisionSections(guidance: string): { common: string; content: string } {
  const submission = guidance.split(/\n\n以下是这位老师存档的长期批改要求/u)[0] ?? "";
  const common = submission.match(/\[结构问题 \/ 共性问题\]\n([\s\S]*?)(?=\n\[内容建议\]|$)/u)?.[1] ?? "";
  const content = submission.match(/\[内容建议\]\n([\s\S]*)$/u)?.[1] ?? "";
  return { common: common.trim(), content: content.trim() };
}

/**
 * --since：只收界点之后的意见。第一栏（结构 / 共性问题）全部收；
 * 第二栏和退回意见只收整体明显通用的原话。按 owner + 同名题目合并完全相同原文。
 */
export async function planBackfillSince(execute: Execute, since: number, titles?: string[]): Promise<BackfillTitlePlan[]> {
  const wanted = titles?.length ? new Set(titles.map(normalizeAssignmentTitle)) : null;
  const buckets = new Map<string, { ownerId: string; title: string; opinions: RuleSourceOpinion[] }>();
  const add = (ownerId: string, title: string, opinion: RuleSourceOpinion) => {
    if (!title || (wanted && !wanted.has(title))) return;
    const key = `${ownerId}\u0000${title}`;
    if (!buckets.has(key)) buckets.set(key, { ownerId, title, opinions: [] });
    buckets.get(key)!.opinions.push(opinion);
  };
  const sinceSql = String(Math.trunc(since));
  for (const row of execute(`SELECT j.owner_id, j.review_id, j.teacher_guidance, r.student_name, r.config FROM analysis_jobs j INNER JOIN reviews r ON r.id = j.review_id WHERE j.teacher_guidance IS NOT NULL AND j.created_at >= ${sinceSql} ORDER BY j.created_at, j.id`).rows) {
    const title = opinionSourceTitle(jsonValue(row.config));
    const { common, content } = revisionSections(str(row.teacher_guidance));
    const base = { reviewId: str(row.review_id) || null, studentName: str(row.student_name), kind: "history" as const };
    if (common) add(str(row.owner_id), title, { ...base, text: common });
    if (isGeneralOpinion(content)) add(str(row.owner_id), title, { ...base, text: content });
  }
  for (const row of execute(`SELECT id, owner_id, student_name, config, rejection_reason, rejection_change_request FROM reviews WHERE deleting_at IS NULL AND updated_at >= ${sinceSql} AND (rejection_reason IS NOT NULL OR rejection_change_request IS NOT NULL)`).rows) {
    const title = opinionSourceTitle(jsonValue(row.config));
    const text = rejectionOpinionText(str(row.rejection_reason), str(row.rejection_change_request));
    if (isGeneralOpinion(text)) add(str(row.owner_id), title, { text, reviewId: str(row.id), studentName: str(row.student_name), kind: "rejection" });
  }
  return finishPlans(execute, [...buckets.values()]);
}

async function finishPlans(execute: Execute, buckets: Array<{ ownerId: string; title: string; opinions: RuleSourceOpinion[] }>): Promise<BackfillTitlePlan[]> {
  const pendingRows = execute("SELECT id, owner_id, source_title, rule_text, sources FROM grading_rule_candidates WHERE status = 'pending'").rows;
  const standingRows = execute("SELECT id, owner_id, source_title, change_request FROM grading_opinions WHERE scope = 'standing'").rows;
  const plans: BackfillTitlePlan[] = [];
  for (const { ownerId, title, opinions } of buckets) {
    const existing: ExistingRule[] = [
      ...pendingRows.filter((row) => str(row.owner_id) === ownerId && normalizeAssignmentTitle(str(row.source_title)) === title)
        .map((row) => ({ id: str(row.id), ruleText: str(row.rule_text), status: "pending" as const, sources: sourceOpinions(row.sources) })),
      ...standingRows.filter((row) => str(row.owner_id) === ownerId && normalizeAssignmentTitle(str(row.source_title)) === title)
        .map((row) => ({ id: str(row.id), ruleText: str(row.change_request), status: "approved" as const, sources: [] })),
    ];
    const plan = await planRuleCandidates({ title, opinions, existing });
    plans.push({ ownerId, title, inspected: opinions.length, create: plan.create, skipped: plan.skipped.length + plan.merge.reduce((sum, item) => sum + item.sources.length, 0) });
  }
  return plans.sort((a, b) => a.title.localeCompare(b.title));
}

export async function planBackfill(execute: Execute, titles: string[] = DEFAULT_TITLES): Promise<BackfillTitlePlan[]> {
  const wanted = new Set(titles.map(normalizeAssignmentTitle));
  const buckets = new Map<string, { ownerId: string; title: string; opinions: RuleSourceOpinion[]; jobIds: Set<string> }>();
  const bucket = (ownerId: string, title: string) => {
    const key = `${ownerId}\u0000${title}`;
    let value = buckets.get(key);
    if (!value) { value = { ownerId, title, opinions: [], jobIds: new Set() }; buckets.set(key, value); }
    return value;
  };
  for (const row of execute("SELECT owner_id, change_request, reason, body, source_title, source_student_name, source_review_id, source_job_id FROM grading_opinions WHERE scope = 'essay' ORDER BY created_at, id").rows) {
    const title = normalizeAssignmentTitle(str(row.source_title));
    if (!wanted.has(title)) continue;
    const target = bucket(str(row.owner_id), title);
    if (str(row.source_job_id)) target.jobIds.add(str(row.source_job_id));
    const text = [str(row.change_request), str(row.reason), str(row.body)].find((value) => value.trim()) ?? "";
    target.opinions.push({ text, reviewId: str(row.source_review_id) || null, studentName: str(row.source_student_name), kind: "history" });
  }
  for (const row of execute("SELECT j.id AS job_id, j.owner_id, j.review_id, j.teacher_guidance, r.student_name, r.config FROM analysis_jobs j INNER JOIN reviews r ON r.id = j.review_id WHERE j.teacher_guidance IS NOT NULL ORDER BY j.created_at, j.id").rows) {
    const title = opinionSourceTitle(jsonValue(row.config));
    if (!wanted.has(title)) continue;
    const target = bucket(str(row.owner_id), title);
    if (target.jobIds.has(str(row.job_id))) continue;
    const parsed = parseRevisionTeacherGuidance(str(row.teacher_guidance));
    if (!parsed) continue;
    const text = rejectionOpinionText(parsed.reason, parsed.changeRequest);
    if (text) target.opinions.push({ text, reviewId: str(row.review_id) || null, studentName: str(row.student_name), kind: "history" });
  }
  for (const row of execute("SELECT id, owner_id, student_name, config, rejection_reason, rejection_change_request FROM reviews WHERE deleting_at IS NULL AND (rejection_reason IS NOT NULL OR rejection_change_request IS NOT NULL)").rows) {
    const title = opinionSourceTitle(jsonValue(row.config));
    if (!wanted.has(title)) continue;
    const text = rejectionOpinionText(str(row.rejection_reason), str(row.rejection_change_request));
    if (text) bucket(str(row.owner_id), title).opinions.push({ text, reviewId: str(row.id), studentName: str(row.student_name), kind: "rejection" });
  }
  // 离线回填只规划新候选，已有候选的相同原话计为跳过，不修改已有来源。
  return finishPlans(execute, [...buckets.values()]);
}

export function backfillInsertStatements(plans: BackfillTitlePlan[], now = Date.now(), createId: () => string = randomUUID): string[] {
  return plans.flatMap((plan) => plan.create.map((draft) => [
    "INSERT INTO grading_rule_candidates (id, owner_id, source_title, rule_text, category, paragraph_label, sources, status, created_at, updated_at) VALUES (",
    [sqlText(createId()), sqlText(plan.ownerId), sqlText(draft.title), sqlText(draft.ruleText), sqlText(draft.category), sqlText(draft.paragraphLabel), sqlText(JSON.stringify(draft.sources)), "'pending'", String(now), String(now)].join(", "),
    ")",
  ].join("")));
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry!).href;
}

if (isDirectRun()) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const remote = args.includes("--d1");
  const titles = args.flatMap((arg, index) => arg === "--title" && args[index + 1] ? [args[index + 1]!] : []);
  const sinceIndex = args.indexOf("--since");
  const sinceRaw = sinceIndex >= 0 ? args[sinceIndex + 1] ?? "" : "";
  const since = sinceRaw ? (/^\d+$/u.test(sinceRaw) ? Number(sinceRaw) : Date.parse(sinceRaw)) : null;
  const unknown = args.filter((arg, index) => !["--dry-run", "--d1", "--title", "--since"].includes(arg) && !["--title", "--since"].includes(args[index - 1] ?? ""));
  if (!remote || unknown.length || (sinceIndex >= 0 && !Number.isFinite(since))) {
    process.stderr.write("用法：npm run backfill:rule-candidates -- --d1 [--dry-run] [--since 2026-10-22T20:34:47+08:00] [--title 题目 ...]\n--since 只收界点之后的意见：第一栏全部收，其它只收明显通用的句子；不指定 --title 时包含所有题目。\n只生成待审批的候选规则，不自动通过。--dry-run 只打印计划不写入。默认题目：这件事打动了我、为自己鼓掌。\n");
    process.exitCode = 2;
  } else {
    void (async () => {
      try {
        const plans = since !== null
          ? await planBackfillSince(executeRemoteD1, since, titles)
          : await planBackfill(executeRemoteD1, titles.length ? titles : DEFAULT_TITLES);
        const statements = backfillInsertStatements(plans);
        const summary = plans.map((plan) => ({ title: plan.title, inspected: plan.inspected, candidates: plan.create.length, skipped: plan.skipped, rules: plan.create.map((item) => ({ rule: item.ruleText, sources: item.sources.length })) }));
        if (!dryRun) statements.forEach((statement) => executeRemoteD1(statement));
        process.stdout.write(`${JSON.stringify({ dryRun, target: "d1", written: dryRun ? 0 : statements.length, summary }, null, 2)}\n`);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      }
    })();
  }
}
