-- 纯增量查询性能索引：仅使用 CREATE INDEX IF NOT EXISTS，不删除、不重建任何已有表。
-- 1) 超时回收与空草稿维护（消除每分钟/每刻钟对 reviews 全表扫描）
CREATE INDEX IF NOT EXISTS reviews_analyzing_idx
  ON reviews(analysis_run_id)
  WHERE status = 'analyzing';

CREATE INDEX IF NOT EXISTS reviews_empty_draft_cleanup_idx
  ON reviews(updated_at)
  WHERE status = 'draft' AND deleting_at IS NULL AND report IS NULL AND ocr_checkpoint IS NULL;

-- 2) 批改历史列表按更新时间倒序（消除 GET /api/reviews 的临时 B-tree 排序）
CREATE INDEX IF NOT EXISTS reviews_owner_active_updated_idx
  ON reviews(owner_id, updated_at DESC, created_at DESC)
  WHERE deleting_at IS NULL;

-- 3) 单篇最新任务与失败摘要（消除跨租户 status 扫描与临时排序）
CREATE INDEX IF NOT EXISTS analysis_jobs_owner_review_recent_idx
  ON analysis_jobs(owner_id, review_id, created_at DESC, id DESC);

-- 4) 登录防护与会话定期清理（消除 login_challenges / sessions / login_attempts 全表扫描）
CREATE INDEX IF NOT EXISTS login_challenges_ip_created_idx
  ON login_challenges(ip_hash, created_at);

CREATE INDEX IF NOT EXISTS sessions_expires_at_idx
  ON sessions(expires_at);

CREATE INDEX IF NOT EXISTS login_attempts_attempted_at_idx
  ON login_attempts(attempted_at);

-- 5) 长期规则与单篇历史意见读取（按 owner + scope + review 定向检索）
CREATE INDEX IF NOT EXISTS grading_opinions_owner_scope_review_idx
  ON grading_opinions(owner_id, scope, source_review_id, updated_at DESC, created_at DESC, id DESC);
