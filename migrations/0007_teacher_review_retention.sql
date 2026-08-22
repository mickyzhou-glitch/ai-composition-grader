ALTER TABLE reviews ADD COLUMN teacher_reviewed_at INTEGER;

UPDATE reviews
SET expires_at = NULL
WHERE deleting_at IS NULL;

CREATE INDEX IF NOT EXISTS reviews_owner_teacher_reviewed_idx
  ON reviews(owner_id, teacher_reviewed_at, created_at);
