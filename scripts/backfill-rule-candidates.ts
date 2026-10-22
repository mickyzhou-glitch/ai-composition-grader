import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { opinionSourceTitle } from "../src/grading-opinions/grading-opinion-repository";
import {
  planRuleCandidates,
  rejectionOpinionText,
  splitOpinionLines,
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
 * 按 owner + 同名题目分组，归纳成候选规则（只生成待审批，不自动通过）。
 */
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
    const text = str(row.change_request).trim() || str(row.reason).trim() || str(row.body).trim();
    for (const line of splitOpinionLines(text)) {
      target.opinions.push({ text: line, reviewId: str(row.source_review_id) || null, studentName: str(row.source_student_name), kind: "history" });
    }
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
  const pendingRows = execute("SELECT id, owner_id, source_title, rule_text, sources FROM grading_rule_candidates WHERE status = 'pending'").rows;
  const standingRows = execute("SELECT id, owner_id, source_title, change_request FROM grading_opinions WHERE scope = 'standing'").rows;
  const plans: BackfillTitlePlan[] = [];
  for (const { ownerId, title, opinions } of buckets.values()) {
    const existing: ExistingRule[] = [
      ...pendingRows.filter((row) => str(row.owner_id) === ownerId && normalizeAssignmentTitle(str(row.source_title)) === title)
        .map((row) => ({ id: str(row.id), ruleText: str(row.rule_text), status: "pending" as const, sources: (jsonValue(row.sources) as RuleSourceOpinion[]) ?? [] })),
      ...standingRows.filter((row) => str(row.owner_id) === ownerId && normalizeAssignmentTitle(str(row.source_title)) === title)
        .map((row) => ({ id: str(row.id), ruleText: str(row.change_request), status: "approved" as const, sources: [] })),
    ];
    // 回填不合并进已有待审批候选，也不重复导入：与已有候选相近的意见跳过。
    const plan = await planRuleCandidates({ title, opinions, existing });
    plans.push({ ownerId, title, inspected: opinions.length, create: plan.create, skipped: plan.skipped.length + plan.merge.reduce((sum, item) => sum + item.sources.length, 0) });
  }
  return plans.sort((a, b) => a.title.localeCompare(b.title));
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
  const unknown = args.filter((arg, index) => !["--dry-run", "--d1", "--title"].includes(arg) && args[index - 1] !== "--title");
  if (!remote || unknown.length) {
    process.stderr.write("用法：npm run backfill:rule-candidates -- --d1 [--dry-run] [--title 题目 ...]\n只生成待审批的候选规则，不自动通过。--dry-run 只打印计划不写入。默认题目：这件事打动了我、为自己鼓掌。\n");
    process.exitCode = 2;
  } else {
    void (async () => {
      try {
        const plans = await planBackfill(executeRemoteD1, titles.length ? titles : DEFAULT_TITLES);
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
