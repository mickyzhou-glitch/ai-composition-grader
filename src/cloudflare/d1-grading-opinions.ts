import { normalizeAssignmentTitle } from "../reanalysis/contracts";
import {
  describeScopedOpinion,
  isOpinionCategory,
  isOpinionScope,
  type OpinionCategory,
  type OpinionScope,
  type StandingOpinionInput,
} from "../grading-opinions/standing-guidance";

export interface GradingOpinionView {
  id: string;
  text: string;
  scope: OpinionScope;
  paragraphLabel: string | null;
  category: string;
  sourceReviewId: string | null;
  sourceStudentName: string;
  sourceClassName: string;
  sourceTitle: string;
  createdAt: string;
  updatedAt: string;
}

export interface GradingOpinionUpdate {
  text: string;
  category?: OpinionCategory;
}

interface OpinionRow {
  id: string;
  body: string;
  reason: string | null;
  changeRequest: string | null;
  paragraphLabel: string | null;
  category: string | null;
  scope: string | null;
  sourceReviewId: string | null;
  sourceStudentName: string | null;
  sourceClassName: string | null;
  sourceTitle: string | null;
  createdAt: number;
  updatedAt: number;
}

const opinionColumns = `
  id, body, reason,
  change_request AS changeRequest,
  paragraph_label AS paragraphLabel,
  category,
  scope,
  source_review_id AS sourceReviewId,
  source_student_name AS sourceStudentName,
  source_class_name AS sourceClassName,
  source_title AS sourceTitle,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

export async function listD1StandingOpinions(
  database: D1Database,
  ownerId: string,
  title: string,
): Promise<StandingOpinionInput[]> {
  const normalized = normalizeAssignmentTitle(title);
  const bound = database.prepare(`
    SELECT change_request AS text, paragraph_label AS paragraphLabel,
      category, source_title AS sourceTitle, updated_at AS updatedAt
    FROM grading_opinions
    WHERE owner_id = ? AND scope = 'standing'
    ORDER BY updated_at DESC, created_at DESC, id DESC
  `).bind(ownerId) as D1PreparedStatement & {
    all?: () => Promise<{ results?: Array<Record<string, unknown>> }>;
  };
  // Some job-enqueue doubles only stub first(). An absent archive query means no standing opinions.
  if (typeof bound.all !== "function") return [];
  const result = await bound.all();
  return (result.results ?? []).flatMap((row) => {
    const text = typeof row.text === "string" ? row.text.trim() : "";
    const sourceTitle = typeof row.sourceTitle === "string" ? row.sourceTitle : "";
    if (!text || normalizeAssignmentTitle(sourceTitle) !== normalized) return [];
    const createdAt = typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : 0;
    const category = typeof row.category === "string" && isOpinionCategory(row.category) ? row.category : undefined;
    const paragraphLabel = typeof row.paragraphLabel === "string" ? row.paragraphLabel : null;
    return [{ text, paragraphLabel, category, createdAt }];
  });
}

export class D1GradingOpinions {
  constructor(private readonly database: D1Database) {}

  async list(ownerId: string): Promise<GradingOpinionView[]> {
    const result = await this.database.prepare(`
      SELECT ${opinionColumns}
      FROM grading_opinions
      WHERE owner_id = ?
      ORDER BY created_at DESC, id DESC
    `).bind(ownerId).all<OpinionRow>();
    return (result.results ?? []).map(toView);
  }

  async update(ownerId: string, id: string, input: GradingOpinionUpdate): Promise<GradingOpinionView | null> {
    const described = describeScopedOpinion(input.text);
    if (!described) throw new TypeError("text is required");
    const row = await this.database.prepare(`
      UPDATE grading_opinions
      SET body = ?, reason = '', change_request = ?, paragraph_label = ?, category = ?, updated_at = ?
      WHERE id = ? AND owner_id = ? AND scope = 'standing'
      RETURNING ${opinionColumns}
    `).bind(
      described.body,
      described.text,
      described.paragraphLabel,
      input.category ?? described.category,
      Date.now(),
      id,
      ownerId,
    ).first<OpinionRow>();
    return row ? toView(row) : null;
  }

  async delete(ownerId: string, id: string): Promise<boolean> {
    const result = await this.database.prepare(`
      DELETE FROM grading_opinions WHERE id = ? AND owner_id = ? AND scope = 'standing'
    `).bind(id, ownerId).run();
    return (result.meta?.changes ?? 0) === 1;
  }
}

function opinionText(row: OpinionRow): string {
  const changeRequest = row.changeRequest?.trim() ?? "";
  const reason = row.reason?.trim() ?? "";
  if (reason && changeRequest && reason !== changeRequest) return `${reason}\n${changeRequest}`;
  return changeRequest || reason || row.body;
}

function toView(row: OpinionRow): GradingOpinionView {
  return {
    id: row.id,
    text: opinionText(row),
    scope: row.scope && isOpinionScope(row.scope) ? row.scope : "essay",
    paragraphLabel: row.paragraphLabel,
    category: row.category ?? "其他",
    sourceReviewId: row.sourceReviewId,
    sourceStudentName: row.sourceStudentName ?? "",
    sourceClassName: row.sourceClassName ?? "",
    sourceTitle: row.sourceTitle ?? "",
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
