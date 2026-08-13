import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import type {
  Annotation,
  AssignmentConfig,
  EvaluationReport,
  NormalizedCrop,
  ReviewStatus,
} from "../domain/contracts";
import type { OcrCheckpoint } from "../ocr/contracts";

export const settings = sqliteTable("settings", {
  role: text("role").$type<"vision" | "content">().primaryKey(),
  baseUrl: text("base_url").notNull(),
  model: text("model").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type UserRole = "admin" | "teacher";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").$type<UserRole>().notNull(),
    mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull(),
    disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("users_username_unique_idx").on(table.username),
    check("users_role_check", sql`${table.role} IN ('admin', 'teacher')`),
    check(
      "users_must_change_password_check",
      sql`${table.mustChangePassword} IN (0, 1)`,
    ),
  ],
);

export const reviews = sqliteTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => users.id),
    status: text("status").$type<ReviewStatus>().notNull(),
    studentName: text("student_name").notNull().default(""),
    config: text("config", { mode: "json" }).$type<AssignmentConfig>().notNull(),
    report: text("report", { mode: "json" }).$type<EvaluationReport>(),
    revision: integer("revision").notNull().default(0),
    imageRevision: integer("image_revision").notNull().default(0),
    ocrCheckpoint: text("ocr_checkpoint", { mode: "json" }).$type<OcrCheckpoint>(),
    reportOcrRevision: integer("report_ocr_revision"),
    analysisRunId: text("analysis_run_id"),
    pdfFilename: text("pdf_filename"),
    pdfPath: text("pdf_path"),
    pdfRevision: integer("pdf_revision"),
    exportedAt: integer("exported_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    deletingAt: integer("deleting_at", { mode: "timestamp_ms" }),
    privacyConsentVersion: text("privacy_consent_version"),
    privacyConsentedAt: integer("privacy_consented_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("reviews_owner_created_at_idx").on(table.ownerId, table.createdAt),
    index("reviews_owner_deleting_at_idx").on(table.ownerId, table.deletingAt),
    index("reviews_expires_deleting_at_idx").on(table.expiresAt, table.deletingAt),
  ],
);

export const savedAssignments = sqliteTable(
  "saved_assignments",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    config: text("config", { mode: "json" }).$type<AssignmentConfig>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("saved_assignments_owner_title_unique_idx").on(table.ownerId, table.title),
    index("saved_assignments_owner_updated_at_idx").on(table.ownerId, table.updatedAt),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("sessions_user_id_idx").on(table.userId),
    uniqueIndex("sessions_token_hash_unique_idx").on(table.tokenHash),
  ],
);

export const loginAttempts = sqliteTable(
  "login_attempts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    normalizedUsername: text("normalized_username").notNull(),
    ipHash: text("ip_hash").notNull(),
    succeeded: integer("succeeded", { mode: "boolean" }).notNull(),
    attemptedAt: integer("attempted_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    check("login_attempts_succeeded_check", sql`${table.succeeded} IN (0, 1)`),
    index("login_attempts_username_attempted_at_idx").on(
      table.normalizedUsername,
      table.attemptedAt,
    ),
    index("login_attempts_ip_attempted_at_idx").on(table.ipHash, table.attemptedAt),
  ],
);

export const securityEvents = sqliteTable(
  "security_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    check("security_events_metadata_json_check", sql`json_valid(${table.metadata})`),
    index("security_events_user_created_at_idx").on(table.userId, table.createdAt),
  ],
);

export const reviewImages = sqliteTable("review_images", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reviewId: text("review_id")
    .notNull()
    .references(() => reviews.id, { onDelete: "cascade" }),
  pageIndex: integer("page_index").notNull(),
  path: text("path").notNull(),
  position: integer("position").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  originalPath: text("original_path").notNull(),
  annotationPath: text("annotation_path").notNull(),
  aiPath: text("ai_path").notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  rotation: integer("rotation").notNull(),
  crop: text("crop", { mode: "json" }).$type<NormalizedCrop>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const annotations = sqliteTable("annotations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reviewId: text("review_id")
    .notNull()
    .references(() => reviews.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  pageIndex: integer("page_index").notNull(),
  x: real("x").notNull(),
  y: real("y").notNull(),
  category: text("category").$type<Annotation["category"]>().notNull(),
  anchorText: text("anchor_text").notNull(),
  comment: text("comment").notNull(),
  isHighlight: integer("is_highlight", { mode: "boolean" }).notNull(),
});

export type AnalysisJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";
export type AnalysisProgressStage =
  | "queued"
  | "reading_images"
  | "generating_review"
  | "validating_result"
  | "saving_result";

export const analysisJobs = sqliteTable(
  "analysis_jobs",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status").$type<AnalysisJobStatus>().notNull(),
    attempt: integer("attempt").notNull().default(0),
    availableAt: integer("available_at", { mode: "timestamp_ms" }).notNull(),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    progressStage: text("progress_stage").$type<AnalysisProgressStage>().notNull(),
    errorCode: text("error_code"),
    message: text("message"),
    teacherGuidance: text("teacher_guidance"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    check(
      "analysis_jobs_status_check",
      sql`${table.status} IN ('queued', 'running', 'succeeded', 'failed', 'canceled')`,
    ),
    check("analysis_jobs_attempt_check", sql`${table.attempt} >= 0`),
    check(
      "analysis_jobs_progress_stage_check",
      sql`${table.progressStage} IN ('queued', 'reading_images', 'generating_review', 'validating_result', 'saving_result')`,
    ),
    index("analysis_jobs_claim_idx").on(table.status, table.availableAt, table.createdAt),
    index("analysis_jobs_owner_review_idx").on(table.ownerId, table.reviewId),
    index("analysis_jobs_review_id_idx").on(table.reviewId),
    uniqueIndex("analysis_jobs_one_active_per_review_idx")
      .on(table.reviewId)
      .where(sql`${table.status} IN ('queued', 'running')`),
  ],
);
