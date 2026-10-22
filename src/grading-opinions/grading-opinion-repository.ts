import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import type { AppDatabase } from "../db/client";
import { gradingOpinions } from "../db/schema";
import { assignmentConfigSchema } from "../domain/contracts";
import { MAX_REVISION_FIELD_CHARS, normalizeAssignmentTitle } from "../reanalysis/contracts";
import {
  describeGradingOpinion,
  isOpinionCategory,
  type OpinionCategory,
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
  reason: string;
  changeRequest: string;
  category?: OpinionCategory;
  sourceReviewId: string | null;
  sourceJobId?: string | null;
  sourceStudentName: string;
  sourceClassName: string;
  sourceTitle: string;
  createdAt: Date;
}

export interface GradingOpinionUpdate {
  reason: string;
  changeRequest: string;
  category?: OpinionCategory;
}

export function standingOpinions(database: OpinionReader, ownerId: string): StandingOpinionInput[] {
  return database.select({
    reason: gradingOpinions.reason,
    changeRequest: gradingOpinions.changeRequest,
    paragraphLabel: gradingOpinions.paragraphLabel,
    category: gradingOpinions.category,
    updatedAt: gradingOpinions.updatedAt,
  }).from(gradingOpinions)
    .where(eq(gradingOpinions.ownerId, ownerId))
    .orderBy(desc(gradingOpinions.updatedAt), desc(gradingOpinions.createdAt), desc(gradingOpinions.id))
    .all()
    .flatMap((row) => {
      if (!row.reason.trim() && !row.changeRequest.trim()) return [];
      return [{
        reason: row.reason,
        changeRequest: row.changeRequest,
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
    const described = requireDescribed(input.reason, input.changeRequest);
    const id = this.options.createId?.() ?? randomUUID();
    this.database.insert(gradingOpinions).values({
      id,
      ownerId: input.ownerId,
      body: described.body,
      reason: described.reason,
      changeRequest: described.changeRequest,
      paragraphLabel: described.paragraphLabel,
      category: input.category ?? described.category,
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
    const described = requireDescribed(input.reason, input.changeRequest);
    const now = this.options.now?.() ?? new Date();
    const updated = this.database.update(gradingOpinions).set({
      body: described.body,
      reason: described.reason,
      changeRequest: described.changeRequest,
      paragraphLabel: described.paragraphLabel,
      category: input.category ?? described.category,
      updatedAt: now,
    }).where(and(eq(gradingOpinions.id, id), eq(gradingOpinions.ownerId, ownerId))).run();
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

function requireDescribed(reason: string, changeRequest: string) {
  const described = describeGradingOpinion(reason, changeRequest);
  if (
    !described
    || described.reason.length > MAX_REVISION_FIELD_CHARS
    || described.changeRequest.length > MAX_REVISION_FIELD_CHARS
  ) {
    throw new TypeError(`reason and changeRequest must each be 1 to ${MAX_REVISION_FIELD_CHARS} characters`);
  }
  return described;
}
