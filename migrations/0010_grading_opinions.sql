-- 老师名下的批改意见存档。不引用 reviews，避免单篇保存、重新分析或删除作文时把意见一起删掉。
CREATE TABLE grading_opinions (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(body) > 0),
  source_review_id TEXT,
  source_student_name TEXT NOT NULL DEFAULT '',
  source_class_name TEXT NOT NULL DEFAULT '',
  source_title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX grading_opinions_owner_created_idx
  ON grading_opinions(owner_id, created_at, id);
