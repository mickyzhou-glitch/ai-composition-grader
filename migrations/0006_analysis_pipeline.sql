PRAGMA foreign_keys = OFF;

CREATE TABLE analysis_jobs_new (
  id TEXT PRIMARY KEY NOT NULL,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'full' CHECK (mode IN ('full', 'content_only')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  available_at INTEGER NOT NULL,
  lease_expires_at INTEGER,
  progress_stage TEXT NOT NULL CHECK (
    progress_stage IN (
      'queued', 'reading_images', 'saving_ocr', 'generating_review',
      'mapping_annotations', 'validating_result', 'saving_result'
    )
  ),
  error_code TEXT,
  message TEXT,
  teacher_guidance TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

INSERT INTO analysis_jobs_new (
  id, review_id, owner_id, mode, status, attempt, available_at, lease_expires_at,
  progress_stage, error_code, message, teacher_guidance, created_at, started_at, finished_at
)
SELECT id, review_id, owner_id, 'full', status, attempt, available_at, lease_expires_at,
  progress_stage, error_code, message, teacher_guidance, created_at, started_at, finished_at
FROM analysis_jobs;

DROP TABLE analysis_jobs;
ALTER TABLE analysis_jobs_new RENAME TO analysis_jobs;
CREATE INDEX analysis_jobs_claim_idx ON analysis_jobs(status, available_at, created_at);
CREATE INDEX analysis_jobs_owner_review_idx ON analysis_jobs(owner_id, review_id);
CREATE INDEX analysis_jobs_review_id_idx ON analysis_jobs(review_id);
CREATE UNIQUE INDEX analysis_jobs_one_active_per_review_idx
  ON analysis_jobs(review_id) WHERE status IN ('queued', 'running');

PRAGMA foreign_keys = ON;
