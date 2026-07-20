import type Database from "better-sqlite3";

export const INITIALIZE_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'draft',
      'analyzing',
      'needs_better_images',
      'ready_for_review',
      'exported',
      'failed'
    )
  ),
  config TEXT NOT NULL,
  report TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS review_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL CHECK (page_index >= 0),
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS review_images_review_id_idx
  ON review_images(review_id);

CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  page_index INTEGER NOT NULL CHECK (page_index >= 0),
  x REAL NOT NULL CHECK (x >= 0 AND x <= 1),
  y REAL NOT NULL CHECK (y >= 0 AND y <= 1),
  category TEXT NOT NULL CHECK (
    category IN ('typo', 'punctuation', 'sentence', 'expression', 'structure', 'highlight')
  ),
  anchor_text TEXT NOT NULL,
  comment TEXT NOT NULL,
  is_highlight INTEGER NOT NULL CHECK (is_highlight IN (0, 1)),
  UNIQUE(review_id, position)
);

CREATE INDEX IF NOT EXISTS annotations_review_id_idx
  ON annotations(review_id);
`;

export function initializeSchema(database: Database.Database): void {
  database.exec(INITIALIZE_SCHEMA_SQL);
}

