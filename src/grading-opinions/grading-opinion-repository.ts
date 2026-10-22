import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import type { AppDatabase } from "../db/client";
import { gradingOpinions } from "../db/schema";
import { assignmentConfigSchema } from "../domain/contracts";
import { MAX_REVISION_FIELD_CHARS, normalizeAssignmentTitle } from "../reanalysis/contracts";
import {
  describeScopedOpinion,
  isOpinionCategory,
  type OpinionCategory,
  type OpinionScope,
  type StandingOpinionInput,
} from "./standing-guidance";

type OpinionReader = Pick<AppDatabase, "select">;

export interface GradingOpinionRecord {
  id: string;
  ownerId: string;
  body: string;
  reason: string;
  changeRequest: string;
  paragraphLabel: string | null;
  category: string;
  scope: OpinionScope;
  sourceReviewId: string | null;
  sourceJobId: string | null;
  sourceStudentName: string;
  sourceClassName: string;
  sourceTitle: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewGradingOpinion {
  ownerId: string;
  text: string;
  scope: OpinionScope;
  category?: OpinionCategory;
  sourceReviewId: string | null;
  sourceJobId?: string | null;
  sourceStudentName: string;
  sourceClassName: string;
  sourceTitle: string;
  createdAt: Date;
}

export interface GradingOpinionUpdate {
  text: string;
  category?: OpinionCategory;
}

export function standingOpinions(database: OpinionReader, ownerId: string, title: string): StandingOpinionInput[] {
  const normalized = normalizeAssignmentTitle(title);
  return database.select({
    changeRequest: gradingOpinions.changeRequest,
    paragraphLabel: gradingOpinions.paragraphLabel,
    category: gradingOpinions.category,
    sourceTitle: gradingOpinions.sourceTitle,
    updatedAt: gradingOpinions.updatedAt,
  }).from(gradingOpinions)
    .where(and(eq(gradingOpinions.ownerId, ownerId), eq(gradingOpinions.scope, "standing")))
    .orderBy(desc(gradingOpinions.updatedAt), desc(gradingOpinions.createdAt), desc(gradingOpinions.id))
    .all()
    .flatMap((row) => {
      const text = row.changeRequest.trim();
      if (!text || normalizeAssignmentTitle(row.sourceTitle) !== normalized) return [];
      return [{
        text,
        paragraphLabel: row.paragraphLabel,
        category: isOpinionCategory(row.category) ? row.category : undefined,
        createdAt: row.updatedAt.getTime(),
      }];
    });
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
    const described = requireDescribed(input.text);
    const id = this.options.createId?.() ?? randomUUID();
    this.database.insert(gradingOpinions).values({
      id,
      ownerId: input.ownerId,
      body: described.body,
      reason: "",
      changeRequest: described.text,
      paragraphLabel: described.paragraphLabel,
      category: input.category ?? described.category,
      scope: input.scope,
      sourceReviewId: input.sourceReviewId,
      sourceJobId: input.sourceJobId ?? null,
      sourceStudentName: input.sourceStudentName,
      sourceClassName: input.sourceClassName,
      sourceTitle: input.sourceTitle,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    }).run();
    return this.require(input.ownerId, id);
  }

  update(ownerId: string, id: string, input: GradingOpinionUpdate): GradingOpinionRecord | null {
    const described = requireDescribed(input.text);
    const now = this.options.now?.() ?? new Date();
    const updated = this.database.update(gradingOpinions).set({
      body: described.body,
      reason: "",
      changeRequest: described.text,
      paragraphLabel: described.paragraphLabel,
      category: input.category ?? described.category,
      updatedAt: now,
    }).where(and(
      eq(gradingOpinions.id, id),
      eq(gradingOpinions.ownerId, ownerId),
      eq(gradingOpinions.scope, "standing"),
    )).run();
    if (updated.changes !== 1) return null;
    return this.require(ownerId, id);
  }

  delete(ownerId: string, id: string): boolean {
    return this.database.delete(gradingOpinions)
      .where(and(
        eq(gradingOpinions.id, id),
        eq(gradingOpinions.ownerId, ownerId),
        eq(gradingOpinions.scope, "standing"),
      ))
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

function requireDescribed(text: string) {
  const described = describeScopedOpinion(text);
  if (!described || described.text.length > MAX_REVISION_FIELD_CHARS) {
    throw new TypeError(`text must be 1 to ${MAX_REVISION_FIELD_CHARS} characters`);
  }
  return described;
}
