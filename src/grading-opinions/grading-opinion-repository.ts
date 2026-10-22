import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import type { AppDatabase } from "../db/client";
import { gradingOpinions } from "../db/schema";
import { assignmentConfigSchema } from "../domain/contracts";
import { normalizeAssignmentTitle } from "../reanalysis/contracts";
import { MAX_GRADING_OPINION_BODY_CHARS, type StandingOpinionInput } from "./standing-guidance";

type OpinionReader = Pick<AppDatabase, "select">;

export interface GradingOpinionRecord {
  id: string;
  ownerId: string;
  body: string;
  sourceReviewId: string | null;
  sourceStudentName: string;
  sourceClassName: string;
  sourceTitle: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewGradingOpinion {
  ownerId: string;
  body: string;
  sourceReviewId: string | null;
  sourceStudentName: string;
  sourceClassName: string;
  sourceTitle: string;
  createdAt: Date;
}

export function standingOpinions(database: OpinionReader, ownerId: string): StandingOpinionInput[] {
  return database.select({
    body: gradingOpinions.body,
    updatedAt: gradingOpinions.updatedAt,
  }).from(gradingOpinions)
    .where(eq(gradingOpinions.ownerId, ownerId))
    .orderBy(desc(gradingOpinions.updatedAt), desc(gradingOpinions.createdAt), desc(gradingOpinions.id))
    .all()
    .map((row) => ({ body: row.body, createdAt: row.updatedAt.getTime() }));
}

export function opinionSourceTitle(config: unknown): string {
  const parsed = assignmentConfigSchema.safeParse(config);
  return parsed.success ? normalizeAssignmentTitle(parsed.data.title) : "";
}

export class GradingOpinionRepository {
  constructor(
    private readonly database: AppDatabase,
    private readonly options: { now?: () => Date; createId?: () => string } = {},
  ) {}

  list(ownerId: string): GradingOpinionRecord[] {
    return this.database.select().from(gradingOpinions)
      .where(eq(gradingOpinions.ownerId, ownerId))
      .orderBy(desc(gradingOpinions.createdAt), desc(gradingOpinions.id))
      .all();
  }

  insert(input: NewGradingOpinion): GradingOpinionRecord {
    const id = this.options.createId?.() ?? randomUUID();
    this.database.insert(gradingOpinions).values({ id, ...input, updatedAt: input.createdAt }).run();
    return this.require(input.ownerId, id);
  }

  update(ownerId: string, id: string, body: string): GradingOpinionRecord | null {
    const trimmed = body.trim();
    if (!trimmed || trimmed.length > MAX_GRADING_OPINION_BODY_CHARS) {
      throw new TypeError(`body must be 1 to ${MAX_GRADING_OPINION_BODY_CHARS} characters`);
    }
    const now = this.options.now?.() ?? new Date();
    const updated = this.database.update(gradingOpinions).set({ body: trimmed, updatedAt: now })
      .where(and(eq(gradingOpinions.id, id), eq(gradingOpinions.ownerId, ownerId)))
      .run();
    if (updated.changes !== 1) return null;
    return this.require(ownerId, id);
  }

  delete(ownerId: string, id: string): boolean {
    return this.database.delete(gradingOpinions)
      .where(and(eq(gradingOpinions.id, id), eq(gradingOpinions.ownerId, ownerId)))
      .run().changes === 1;
  }

  private require(ownerId: string, id: string): GradingOpinionRecord {
    const row = this.database.select().from(gradingOpinions)
      .where(and(eq(gradingOpinions.id, id), eq(gradingOpinions.ownerId, ownerId)))
      .get();
    if (!row) throw new Error("GRADING_OPINION_NOT_FOUND");
    return row;
  }
}
