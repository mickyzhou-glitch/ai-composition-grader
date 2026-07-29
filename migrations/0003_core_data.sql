CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('draft', 'analyzing', 'needs_better_images', 'ready_for_review', 'exported', 'failed')),
  student_name TEXT NOT NULL DEFAULT '',
  config TEXT NOT NULL,
  report TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  analysis_run_id TEXT,
  pdf_filename TEXT,
  pdf_path TEXT,
  pdf_revision INTEGER,
  exported_at INTEGER,
  expires_at INTEGER,
  deleting_at INTEGER,
  privacy_consent_version TEXT,
  privacy_consented_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_owner_created_at_idx ON reviews(owner_id, created_at);
CREATE INDEX IF NOT EXISTS reviews_owner_deleting_at_idx ON reviews(owner_id, deleting_at);
CREATE INDEX IF NOT EXISTS reviews_expires_deleting_at_idx ON reviews(expires_at, deleting_at);

CREATE TABLE IF NOT EXISTS saved_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  config TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_id, title)
);
CREATE INDEX IF NOT EXISTS saved_assignments_owner_updated_at_idx ON saved_assignments(owner_id, updated_at);

CREATE TABLE IF NOT EXISTS review_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL CHECK (page_index >= 0),
  path TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  original_path TEXT NOT NULL,
  annotation_path TEXT NOT NULL,
  ai_path TEXT NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  rotation INTEGER NOT NULL CHECK (rotation IN (0, 90, 180, 270)),
  crop TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS review_images_review_id_idx ON review_images(review_id);

CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  page_index INTEGER NOT NULL CHECK (page_index >= 0),
  x REAL NOT NULL CHECK (x >= 0 AND x <= 1),
  y REAL NOT NULL CHECK (y >= 0 AND y <= 1),
  category TEXT NOT NULL CHECK (category IN ('typo', 'punctuation', 'sentence', 'expression', 'structure', 'highlight')),
  anchor_text TEXT NOT NULL,
  comment TEXT NOT NULL,
  is_highlight INTEGER NOT NULL CHECK (is_highlight IN (0, 1)),
  UNIQUE(review_id, position)
);
CREATE INDEX IF NOT EXISTS annotations_review_id_idx ON annotations(review_id);

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  available_at INTEGER NOT NULL,
  lease_expires_at INTEGER,
  progress_stage TEXT NOT NULL CHECK (progress_stage IN ('queued', 'reading_images', 'generating_review', 'validating_result', 'saving_result')),
  error_code TEXT,
  message TEXT,
  teacher_guidance TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS analysis_jobs_claim_idx ON analysis_jobs(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS analysis_jobs_owner_review_idx ON analysis_jobs(owner_id, review_id);
CREATE INDEX IF NOT EXISTS analysis_jobs_review_id_idx ON analysis_jobs(review_id);
CREATE UNIQUE INDEX IF NOT EXISTS analysis_jobs_one_active_per_review_idx
  ON analysis_jobs(review_id) WHERE status IN ('queued', 'running');
