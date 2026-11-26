-- 纯增量班级整体花名册与按作文题目筛选索引迁移：
-- 仅新建 class_rosters 表与增量查询索引，不删除、不重建任何已有表。
CREATE TABLE IF NOT EXISTS class_rosters (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_name TEXT NOT NULL CHECK (length(trim(class_name)) > 0 AND length(class_name) <= 50),
  students TEXT NOT NULL CHECK (json_valid(students) AND json_type(students) = 'array'),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_id, class_name)
);

CREATE INDEX IF NOT EXISTS class_rosters_owner_updated_idx
  ON class_rosters(owner_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS reviews_owner_title_updated_idx
  ON reviews(owner_id, summary_title, updated_at DESC, created_at DESC)
  WHERE deleting_at IS NULL;

CREATE INDEX IF NOT EXISTS reviews_owner_class_title_updated_idx
  ON reviews(owner_id, class_name, summary_title, updated_at DESC, created_at DESC)
  WHERE deleting_at IS NULL;
