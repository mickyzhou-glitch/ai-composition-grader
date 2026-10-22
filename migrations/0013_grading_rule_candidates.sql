-- 候选长期规则：老师的修改/退回意见经 AI 归纳后先进入待审批，通过后才写入 grading_opinions(scope='standing')。
-- 只新建表和索引，不 DROP、不重建任何已有表（D1 忽略 PRAGMA foreign_keys=OFF，重建被引用的表会触发级联删除）。
CREATE TABLE IF NOT EXISTS grading_rule_candidates (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_title TEXT NOT NULL CHECK (length(trim(source_title)) > 0),
  rule_text TEXT NOT NULL CHECK (length(trim(rule_text)) > 0),
  category TEXT NOT NULL DEFAULT '其他',
  paragraph_label TEXT,
  sources TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  approved_opinion_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE INDEX IF NOT EXISTS grading_rule_candidates_owner_status_idx
  ON grading_rule_candidates(owner_id, status, created_at, id);
