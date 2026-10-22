-- 把「提交后台修改并继续」的两项文字分开保存，并记下段落位置、类别和来源任务。
-- 0010 已建表但尚未部署；已有本地库靠这些 ADD COLUMN 补齐。
ALTER TABLE grading_opinions ADD COLUMN reason TEXT NOT NULL DEFAULT '';
ALTER TABLE grading_opinions ADD COLUMN change_request TEXT NOT NULL DEFAULT '';
ALTER TABLE grading_opinions ADD COLUMN paragraph_label TEXT;
ALTER TABLE grading_opinions ADD COLUMN category TEXT NOT NULL DEFAULT '其他';
ALTER TABLE grading_opinions ADD COLUMN source_job_id TEXT;

UPDATE grading_opinions
SET
  reason = TRIM(SUBSTR(
    body,
    LENGTH('为什么不合适：') + 1,
    INSTR(body, CHAR(10) || '应该怎么改：') - LENGTH('为什么不合适：') - 1
  )),
  change_request = TRIM(SUBSTR(
    body,
    INSTR(body, CHAR(10) || '应该怎么改：') + LENGTH(CHAR(10) || '应该怎么改：')
  ))
WHERE change_request = ''
  AND INSTR(body, CHAR(10) || '应该怎么改：') > LENGTH('为什么不合适：')
  AND SUBSTR(body, 1, LENGTH('为什么不合适：')) = '为什么不合适：';

UPDATE grading_opinions
SET reason = TRIM(body)
WHERE reason = '' AND change_request = '' AND length(TRIM(body)) > 0;

CREATE INDEX IF NOT EXISTS grading_opinions_source_job_idx
  ON grading_opinions(source_job_id);
