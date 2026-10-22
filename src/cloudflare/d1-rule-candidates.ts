import { normalizeAssignmentTitle } from "../reanalysis/contracts";
import {
  planRuleCandidates,
  type ExistingRule,
  type RuleSourceOpinion,
  type RuleSummarizer,
} from "../grading-opinions/rule-candidates";
import { MAX_GRADING_OPINION_BODY_CHARS } from "../grading-opinions/standing-guidance";

export interface RuleCandidateView {
  id: string;
  title: string;
  ruleText: string;
  category: string;
  paragraphLabel: string | null;
  sources: RuleSourceOpinion[];
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  updatedAt: string;
}

interface CandidateRow {
  id: string;
  source_title: string;
  rule_text: string;
  category: string;
  paragraph_label: string | null;
  sources: string;
  status: string;
  created_at: number;
  updated_at: number;
}

function parseSources(value: string): RuleSourceOpinion[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is RuleSourceOpinion => typeof item === "object" && item !== null && typeof (item as { text?: unknown }).text === "string")
      : [];
  } catch {
    return [];
  }
}

function toView(row: CandidateRow): RuleCandidateView {
  return {
    id: row.id,
    title: row.source_title,
    ruleText: row.rule_text,
    category: row.category,
    paragraphLabel: row.paragraph_label,
    sources: parseSources(row.sources),
    status: row.status === "approved" || row.status === "rejected" ? row.status : "pending",
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class D1RuleCandidates {
  constructor(
    private readonly database: D1Database,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  async listPending(ownerId: string): Promise<RuleCandidateView[]> {
    const { results = [] } = await this.database.prepare(`
      SELECT id, source_title, rule_text, category, paragraph_label, sources, status, created_at, updated_at
      FROM grading_rule_candidates WHERE owner_id = ? AND status = 'pending'
      ORDER BY source_title, created_at, id
    `).bind(ownerId).all<CandidateRow>();
    return results.map(toView);
  }

  async countPending(ownerId: string): Promise<number> {
    const row = await this.database.prepare(`
      SELECT count(*) AS n FROM grading_rule_candidates WHERE owner_id = ? AND status = 'pending'
    `).bind(ownerId).first<{ n: number }>();
    return Number(row?.n ?? 0);
  }

  /** 同名题目下已有的待审批候选和已生效长期规则，用来合并和去重。 */
  async existingRules(ownerId: string, title: string): Promise<ExistingRule[]> {
    const normalized = normalizeAssignmentTitle(title);
    const { results: pending = [] } = await this.database.prepare(`
      SELECT id, rule_text, sources FROM grading_rule_candidates
      WHERE owner_id = ? AND status = 'pending' AND trim(source_title) = ?
    `).bind(ownerId, normalized).all<{ id: string; rule_text: string; sources: string }>();
    const { results: standing = [] } = await this.database.prepare(`
      SELECT id, change_request AS text FROM grading_opinions
      WHERE owner_id = ? AND scope = 'standing' AND trim(source_title) = ?
    `).bind(ownerId, normalized).all<{ id: string; text: string }>();
    return [
      ...pending.map((row) => ({ id: row.id, ruleText: row.rule_text, status: "pending" as const, sources: parseSources(row.sources) })),
      ...standing.map((row) => ({ id: row.id, ruleText: row.text ?? "", status: "approved" as const, sources: [] })),
    ];
  }

  /** 把新意见归纳成候选规则写入待审批。返回新建和合并的候选数量。 */
  async ingest(
    ownerId: string,
    title: string,
    opinions: RuleSourceOpinion[],
    summarizer?: RuleSummarizer,
  ): Promise<{ created: number; merged: number }> {
    const normalized = normalizeAssignmentTitle(title);
    if (!normalized || opinions.length === 0) return { created: 0, merged: 0 };
    const existing = await this.existingRules(ownerId, normalized);
    const plan = await planRuleCandidates({ title: normalized, opinions, existing, summarizer });
    const now = this.now();
    const statements: D1PreparedStatement[] = [];
    for (const merge of plan.merge) {
      const current = existing.find((rule) => rule.id === merge.id)!;
      statements.push(this.database.prepare(`
        UPDATE grading_rule_candidates SET sources = ?, updated_at = ?
        WHERE id = ? AND owner_id = ? AND status = 'pending'
      `).bind(JSON.stringify([...current.sources, ...merge.sources]), now, merge.id, ownerId));
    }
    for (const draft of plan.create) {
      statements.push(this.database.prepare(`
        INSERT INTO grading_rule_candidates (
          id, owner_id, source_title, rule_text, category, paragraph_label, sources, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).bind(
        this.createId(), ownerId, draft.title, draft.ruleText.slice(0, MAX_GRADING_OPINION_BODY_CHARS),
        draft.category, draft.paragraphLabel, JSON.stringify(draft.sources), now, now,
      ));
    }
    if (statements.length) await this.database.batch(statements);
    return { created: plan.create.length, merged: plan.merge.length };
  }

  /** 通过：写入该题目的长期规则（scope='standing'），之后的分析立即带上。 */
  async approve(ownerId: string, id: string, ruleText?: string): Promise<boolean> {
    const row = await this.database.prepare(`
      SELECT id, source_title, rule_text, category, paragraph_label, sources, status, created_at, updated_at
      FROM grading_rule_candidates WHERE id = ? AND owner_id = ? AND status = 'pending'
    `).bind(id, ownerId).first<CandidateRow>();
    if (!row) return false;
    const text = (ruleText?.trim() || row.rule_text).slice(0, MAX_GRADING_OPINION_BODY_CHARS);
    const opinionId = this.createId();
    const now = this.now();
    const outcomes = await this.database.batch([
      this.database.prepare(`
        UPDATE grading_rule_candidates
        SET status = 'approved', rule_text = ?, approved_opinion_id = ?, decided_at = ?, updated_at = ?
        WHERE id = ? AND owner_id = ? AND status = 'pending'
      `).bind(text, opinionId, now, now, id, ownerId),
      this.database.prepare(`
        INSERT INTO grading_opinions (
          id, owner_id, body, reason, change_request, paragraph_label, category, scope,
          source_review_id, source_job_id, source_student_name, source_class_name, source_title,
          created_at, updated_at
        )
        SELECT ?, owner_id, ?, '', ?, paragraph_label, category, 'standing',
          NULL, NULL, '', '', source_title, ?, ?
        FROM grading_rule_candidates
        WHERE id = ? AND owner_id = ? AND approved_opinion_id = ?
      `).bind(opinionId, text, text, now, now, id, ownerId, opinionId),
    ]) as Array<{ meta?: { changes?: number } }>;
    return (outcomes[0]?.meta?.changes ?? 0) === 1;
  }

  /** 驳回：不导入长期规则。 */
  async reject(ownerId: string, id: string): Promise<boolean> {
    const now = this.now();
    const result = await this.database.prepare(`
      UPDATE grading_rule_candidates SET status = 'rejected', decided_at = ?, updated_at = ?
      WHERE id = ? AND owner_id = ? AND status = 'pending'
    `).bind(now, now, id, ownerId).run();
    return (result.meta?.changes ?? 0) === 1;
  }
}
