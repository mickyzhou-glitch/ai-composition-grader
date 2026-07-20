import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import type {
  Annotation,
  AssignmentConfig,
  EvaluationReport,
  NormalizedCrop,
  ReviewStatus,
} from "../domain/contracts";

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey().default(1),
  baseUrl: text("base_url").notNull(),
  model: text("model").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const reviews = sqliteTable("reviews", {
  id: text("id").primaryKey(),
  status: text("status").$type<ReviewStatus>().notNull(),
  config: text("config", { mode: "json" }).$type<AssignmentConfig>().notNull(),
  report: text("report", { mode: "json" }).$type<EvaluationReport>(),
  revision: integer("revision").notNull().default(0),
  analysisRunId: text("analysis_run_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

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
