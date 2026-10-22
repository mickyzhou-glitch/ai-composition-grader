-- SQLite cannot alter a CHECK constraint in place. Rebuild reviews so
-- status can be 'rejected' (审核不通过) and keep the archived return notes.
PRAGMA foreign_keys = OFF;

CREATE TABLE reviews_rejected_migration (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('draft', 'analyzing', 'needs_better_images', 'ready_for_review', 'exported', 'failed', 'rejected')),
  student_name TEXT NOT NULL DEFAULT '',
  class_name TEXT NOT NULL DEFAULT '',
  rejection_reason TEXT,
  rejection_change_request TEXT,
  config TEXT NOT NULL,
  report TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  image_revision INTEGER NOT NULL DEFAULT 0,
  ocr_checkpoint TEXT,
  report_ocr_revision INTEGER,
  analysis_run_id TEXT,
  pdf_filename TEXT,
  pdf_path TEXT,
  pdf_revision INTEGER,
  exported_at INTEGER,
  teacher_reviewed_at INTEGER,
  expires_at INTEGER,
  deleting_at INTEGER,
  privacy_consent_version TEXT,
  privacy_consented_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO reviews_rejected_migration (
  id, owner_id, status, student_name, class_name, rejection_reason, rejection_change_request,
  config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, analysis_run_id,
  pdf_filename, pdf_path, pdf_revision, exported_at, teacher_reviewed_at, expires_at,
  deleting_at, privacy_consent_version, privacy_consented_at, created_at, updated_at
)
SELECT
  id, owner_id, status, student_name, class_name, NULL, NULL,
  config, report, revision, image_revision, ocr_checkpoint, report_ocr_revision, analysis_run_id,
  pdf_filename, pdf_path, pdf_revision, exported_at, teacher_reviewed_at, expires_at,
  deleting_at, privacy_consent_version, privacy_consented_at, created_at, updated_at
FROM reviews;

DROP TABLE reviews;
ALTER TABLE reviews_rejected_migration RENAME TO reviews;

CREATE INDEX IF NOT EXISTS reviews_owner_class ON reviews(owner_id, class_name);
CREATE INDEX IF NOT EXISTS reviews_owner_created_at_idx ON reviews(owner_id, created_at);
CREATE INDEX IF NOT EXISTS reviews_owner_teacher_reviewed_idx ON reviews(owner_id, teacher_reviewed_at, created_at);
CREATE INDEX IF NOT EXISTS reviews_owner_deleting_at_idx ON reviews(owner_id, deleting_at);
CREATE INDEX IF NOT EXISTS reviews_expires_deleting_at_idx ON reviews(expires_at, deleting_at);

PRAGMA foreign_keys = ON;
