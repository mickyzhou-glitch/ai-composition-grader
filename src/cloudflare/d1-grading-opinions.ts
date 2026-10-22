import { MAX_GRADING_OPINION_BODY_CHARS, type StandingOpinionInput } from "../grading-opinions/standing-guidance";

export interface GradingOpinionView {
  id: string;
  body: string;
  sourceReviewId: string | null;
  sourceStudentName: string;
  sourceClassName: string;
  sourceTitle: string;
  createdAt: string;
  updatedAt: string;
}

interface OpinionRow {
  id: string;
  body: string;
  sourceReviewId: string | null;
  sourceStudentName: string | null;
  sourceClassName: string | null;
  sourceTitle: string | null;
  createdAt: number;
  updatedAt: number;
}

const opinionColumns = `
  id, body,
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
): Promise<StandingOpinionInput[]> {
  const bound = database.prepare(`
    SELECT body, updated_at AS updatedAt
    FROM grading_opinions
    WHERE owner_id = ?
    ORDER BY updated_at DESC, created_at DESC, id DESC
  `).bind(ownerId) as D1PreparedStatement & {
    all?: () => Promise<{ results?: Array<{ body?: unknown; updatedAt?: unknown }> }>;
  };
  // Some job-enqueue doubles only stub first(). An absent archive query means no standing opinions.
  if (typeof bound.all !== "function") return [];
  const result = await bound.all();
  return (result.results ?? []).flatMap((row) => {
    if (typeof row.body !== "string" || !row.body.trim()) return [];
    const createdAt = typeof row.updatedAt === "number" && Number.isFinite(row.updatedAt) ? row.updatedAt : 0;
    return [{ body: row.body, createdAt }];
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

  async update(ownerId: string, id: string, body: string): Promise<GradingOpinionView | null> {
    const trimmed = body.trim();
    if (!trimmed || trimmed.length > MAX_GRADING_OPINION_BODY_CHARS) {
      throw new TypeError(`body must be 1 to ${MAX_GRADING_OPINION_BODY_CHARS} characters`);
    }
    const row = await this.database.prepare(`
      UPDATE grading_opinions
      SET body = ?, updated_at = ?
      WHERE id = ? AND owner_id = ?
      RETURNING ${opinionColumns}
    `).bind(trimmed, Date.now(), id, ownerId).first<OpinionRow>();
    return row ? toView(row) : null;
  }

  async delete(ownerId: string, id: string): Promise<boolean> {
    const result = await this.database.prepare(`
      DELETE FROM grading_opinions WHERE id = ? AND owner_id = ?
    `).bind(id, ownerId).run();
    return (result.meta?.changes ?? 0) === 1;
  }
}

function toView(row: OpinionRow): GradingOpinionView {
  return {
    id: row.id,
    body: row.body,
    sourceReviewId: row.sourceReviewId,
    sourceStudentName: row.sourceStudentName ?? "",
    sourceClassName: row.sourceClassName ?? "",
    sourceTitle: row.sourceTitle ?? "",
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}
