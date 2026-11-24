-- 纯增量摘要与导出就绪状态物化迁移：
-- 仅新增轻量标量列、回填确定性标量字段并建立部分/组合索引，不删除、不重建任何已有表。
ALTER TABLE reviews ADD COLUMN has_report INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN summary_title TEXT;
ALTER TABLE reviews ADD COLUMN summary_grade TEXT;
ALTER TABLE reviews ADD COLUMN summary_is_legacy INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN summary_diagnostics TEXT;
ALTER TABLE reviews ADD COLUMN ocr_revision_cached INTEGER;
ALTER TABLE reviews ADD COLUMN export_ready_version TEXT;
ALTER TABLE reviews ADD COLUMN export_blocked_reason TEXT;
ALTER TABLE reviews ADD COLUMN summary_state_key TEXT;
ALTER TABLE reviews ADD COLUMN write_nonce TEXT;

-- 1) 回填标题、报告存在性、等级、诊断摘要、旧版标记与初步 OCR 版本号（兼容 JSON 中 1.0 等值整数表示，并对含 U+0000 空字符的文本按 UTF-8 真实码点精确截断）
UPDATE reviews
SET
  has_report = CASE WHEN report IS NOT NULL THEN 1 ELSE 0 END,
  summary_title = CASE
    WHEN json_valid(config) = 1 THEN
      CASE
        WHEN instr(CAST(COALESCE(json_extract(config, '$.title'), '') AS BLOB), X'00') = 0 THEN
          CASE
            WHEN length(COALESCE(json_extract(config, '$.title'), '')) > 200
            THEN substr(COALESCE(json_extract(config, '$.title'), ''), 1, 199) || '…'
            ELSE COALESCE(json_extract(config, '$.title'), '')
          END
        ELSE (
          WITH RECURSIVE
            src(txt, b) AS (
              SELECT COALESCE(json_extract(config, '$.title'), ''), substr(CAST(COALESCE(json_extract(config, '$.title'), '') AS BLOB), 1, 804)
            ),
            scan(pos, cp, cut_before_nth, total_len) AS (
              SELECT 1, CASE WHEN length(b) >= 1 AND (substr(b, 1, 1) < X'80' OR substr(b, 1, 1) >= X'C0') THEN 1 ELSE 0 END, 0, length(b) FROM src
              UNION ALL
              SELECT
                pos + 1,
                cp + CASE WHEN (substr((SELECT b FROM src), pos + 1, 1) < X'80' OR substr((SELECT b FROM src), pos + 1, 1) >= X'C0') THEN 1 ELSE 0 END,
                CASE
                  WHEN cut_before_nth = 0 AND cp = 199 AND (substr((SELECT b FROM src), pos + 1, 1) < X'80' OR substr((SELECT b FROM src), pos + 1, 1) >= X'C0')
                  THEN pos
                  ELSE cut_before_nth
                END,
                total_len
              FROM scan
              WHERE pos < total_len AND cp <= 200
            )
          SELECT CASE
            WHEN COALESCE((SELECT MAX(cp) FROM scan), 0) <= 200 THEN (SELECT txt FROM src)
            ELSE CAST(substr((SELECT b FROM src), 1, (SELECT MAX(cut_before_nth) FROM scan)) || CAST('…' AS BLOB) AS TEXT)
          END
        )
      END
    ELSE ''
  END,
  summary_is_legacy = CASE
    WHEN report IS NOT NULL
      AND json_valid(report) = 1
      AND json_type(report, '$.sampleParagraphs') = 'array'
      AND COALESCE(json_extract(report, '$.version'), 0) <> 2
    THEN 1
    ELSE 0
  END,
  summary_grade = CASE
    WHEN report IS NULL OR json_valid(report) = 0 THEN NULL
    WHEN json_type(report, '$.grade') = 'text' THEN
      CASE
        WHEN instr(CAST(json_extract(report, '$.grade') AS BLOB), X'00') = 0
        THEN substr(json_extract(report, '$.grade'), 1, 16)
        ELSE (
          WITH RECURSIVE
            src(txt, b) AS (
              SELECT json_extract(report, '$.grade'), substr(CAST(json_extract(report, '$.grade') AS BLOB), 1, 68)
            ),
            scan(pos, cp, cut_before_nth, total_len) AS (
              SELECT 1, CASE WHEN length(b) >= 1 AND (substr(b, 1, 1) < X'80' OR substr(b, 1, 1) >= X'C0') THEN 1 ELSE 0 END, 0, length(b) FROM src
              UNION ALL
              SELECT
                pos + 1,
                cp + CASE WHEN (substr((SELECT b FROM src), pos + 1, 1) < X'80' OR substr((SELECT b FROM src), pos + 1, 1) >= X'C0') THEN 1 ELSE 0 END,
                CASE
                  WHEN cut_before_nth = 0 AND cp = 16 AND (substr((SELECT b FROM src), pos + 1, 1) < X'80' OR substr((SELECT b FROM src), pos + 1, 1) >= X'C0')
                  THEN pos
                  ELSE cut_before_nth
                END,
                total_len
              FROM scan
              WHERE pos < total_len AND cp <= 16
            )
          SELECT CASE
            WHEN COALESCE((SELECT MAX(cp) FROM scan), 0) <= 16 THEN (SELECT txt FROM src)
            ELSE CAST(substr((SELECT b FROM src), 1, (SELECT MAX(cut_before_nth) FROM scan)) AS TEXT)
          END
        )
      END
    WHEN json_type(report, '$.scores.total') IN ('integer', 'real') THEN
      CASE
        WHEN json_extract(report, '$.scores.total') <= 29 THEN 'C'
        WHEN json_extract(report, '$.scores.total') <= 31 THEN 'B-'
        WHEN json_extract(report, '$.scores.total') <= 33 THEN 'B'
        WHEN json_extract(report, '$.scores.total') <= 35 THEN 'B+'
        WHEN json_extract(report, '$.scores.total') = 36 THEN 'A-'
        WHEN json_extract(report, '$.scores.total') <= 38 THEN 'A'
        ELSE 'A+'
      END
    ELSE NULL
  END,
  summary_diagnostics = CASE
    WHEN report IS NOT NULL
      AND json_valid(report) = 1
      AND json_type(report, '$.diagnostics.authenticityAndRelevance.finding') = 'text'
      AND json_type(report, '$.diagnostics.authenticityAndRelevance.action') = 'text'
      AND json_type(report, '$.diagnostics.structure.finding') = 'text'
      AND json_type(report, '$.diagnostics.structure.action') = 'text'
    THEN json_object(
      'authenticityAndRelevance', json_object(
        'finding', CASE
          WHEN instr(CAST(json_extract(report, '$.diagnostics.authenticityAndRelevance.finding') AS BLOB), X'00') = 0 THEN
            CASE
              WHEN length(json_extract(report, '$.diagnostics.authenticityAndRelevance.finding')) > 500
              THEN substr(json_extract(report, '$.diagnostics.authenticityAndRelevance.finding'), 1, 499) || '…'
              ELSE json_extract(report, '$.diagnostics.authenticityAndRelevance.finding')
            END
          ELSE (
            WITH RECURSIVE
              src(txt, b) AS (
                SELECT json_extract(report, '$.diagnostics.authenticityAndRelevance.finding'), substr(CAST(json_extract(report, '$.diagnostics.authenticityAndRelevance.finding') AS BLOB), 1, 2004)
              ),
              scan(pos, cp, cut_before_nth, total_len) AS (
                SELECT 1, CASE WHEN length(b) >= 1 AND (substr(b, 1, 1) < X'80' OR substr(b, 1, 1) >= X'C0') THEN 1 ELSE 0 END, 0, length(b) FROM src
                UNION ALL
                SELECT
                  pos + 1,
                  cp + CASE WHEN (substr((SELECT b FROM src), pos + 1, 1) < X'80' OR substr((SELECT b FROM src), pos + 1, 1) >= X'C0') THEN 1 ELSE 0 END,
                  CASE
                    WHEN cut_before_nth = 0 AND cp = 499 AND (substr((SELECT b FROM src), pos + 1, 1) < X'80' OR substr((SELECT b FROM src), pos + 1, 1) >= X'C0')
                    THEN pos
                    ELSE cut_before_nth
                  END,
                  total_len
                FROM scan
                WHERE pos < total_len AND cp <= 500
              )
            SELECT CASE
              WHEN COALESCE((SELECT MAX(cp) FROM scan), 0) <= 500 THEN (SELECT txt FROM src)
              ELSE CAST(substr((SELECT b FROM src), 1, (SELECT MAX(cut_before_nth) FROM scan)) || CAST('…' AS BLOB) AS TEXT)
            END
          )
        END,
        'action', CASE
          WHEN instr(CAST(json_extract(report, '$.diagnostics.authenticityAndRelevance.action') AS BLOB), X'00') = 0 THEN
            CASE
              WHEN length(json_extract(report, '$.diagnostics.authenticityAndRelevance.action')) > 500
              THEN substr(json_extract(report, '$.diagnostics.authenticityAndRelevance.action'), 1, 499) || '…'
              ELSE json_extract(report, '$.diagnostics.authenticityAndRelevance.action')
            END
          ELSE (
            WITH RECURSIVE
              src(txt, b) AS (
                SELECT json_extract(report, '$.diagnostics.authenticityAndRelevance.action'), substr(CAST(json_extract(report, '$.diagnostics.authenticityAndRelevance.action') AS BLOB), 1, 2004)
              ),
              scan(pos, cp, cut_before_nth, total_len) AS (
                SELECT 1, CASE WHEN length(b) >= 1 AND (substr(b, 1, 1) < X'80' OR substr(b, 1, 1) >= X'C0') THEN 1 ELSE 0 END, 0, length(b) FROM src
                UNION ALL
                SELECT
                  pos + 1,
                  cp + CASE WHEN (substr((SELECT b FROM src), pos + 1, 1) < X'80' OR substr((SELECT b FROM src), pos + 1, 1) >= X'C0') THEN 1 ELSE 0 END,
                  CASE
                    WHEN cut_before_nth = 0 AND cp = 499 AND (substr((SELECT b FROM src), pos + 1, 1) < X'80' OR substr((SELECT b FROM src), pos + 1, 1) >= X'C0')
                    THEN pos
                    ELSE cut_before_nth
                  END,
                  total_len
                FROM scan
                WHERE pos < total_len AND cp <= 500
              )
            SELECT CASE
              WHEN COALESCE((SELECT MAX(cp) FROM scan), 0) <= 500 THEN (SELECT txt FROM src)
              ELSE CAST(substr((SELECT b FROM src), 1, (SELECT MAX(cut_before_nth) FROM scan)) || CAST('…' AS BLOB) AS TEXT)
            END
          )
        END
      ),
      'structure', json_object(
        'finding', CASE
          WHEN instr(CAST(json_extract(report, '$.diagnostics.structure.finding') AS BLOB), X'00') = 0 THEN
            CASE
              WHEN length(json_extract(report, '$.diagnostics.structure.finding')) > 500
              THEN substr(json_extract(report, '$.diagnostics.structure.finding'), 1, 499) || '…'
              ELSE json_extract(report, '$.diagnostics.structure.finding')
            END
          ELSE (
            WITH RECURSIVE
              src(txt, b) AS (
                SELECT json_extract(report, '$.diagnostics.structure.finding'), substr(CAST(json_extract(report, '$.diagnostics.structure.finding') AS BLOB), 1, 2004)
              ),
              scan(pos, cp, cut_before_nth, total_len) AS (
                SELECT 1, CASE WHEN length(b) >= 1 AND (substr(b, 1, 1) < X'80' OR substr(b, 1, 1) >= X'C0') THEN 1 ELSE 0 END, 0, length(b) FROM src
                UNION ALL
                SELECT
                  pos + 1,
                  cp + CASE WHEN (substr((SELECT b FROM src), pos + 1, 1) < X'80' OR substr((SELECT b FROM src), pos + 1, 1) >= X'C0') THEN 1 ELSE 0 END,
                  CASE
                    WHEN cut_before_nth = 0 AND cp = 499 AND (substr((SELECT b FROM src), pos + 1, 1) < X'80' OR substr((SELECT b FROM src), pos + 1, 1) >= X'C0')
                    THEN pos
                    ELSE cut_before_nth
                  END,
                  total_len
                FROM scan
                WHERE pos < total_len AND cp <= 500
              )
            SELECT CASE
              WHEN COALESCE((SELECT MAX(cp) FROM scan), 0) <= 500 THEN (SELECT txt FROM src)
              ELSE CAST(substr((SELECT b FROM src), 1, (SELECT MAX(cut_before_nth) FROM scan)) || CAST('…' AS BLOB) AS TEXT)
            END
          )
        END,
        'action', CASE
          WHEN instr(CAST(json_extract(report, '$.diagnostics.structure.action') AS BLOB), X'00') = 0 THEN
            CASE
              WHEN length(json_extract(report, '$.diagnostics.structure.action')) > 500
              THEN substr(json_extract(report, '$.diagnostics.structure.action'), 1, 499) || '…'
              ELSE json_extract(report, '$.diagnostics.structure.action')
            END
          ELSE (
            WITH RECURSIVE
              src(txt, b) AS (
                SELECT json_extract(report, '$.diagnostics.structure.action'), substr(CAST(json_extract(report, '$.diagnostics.structure.action') AS BLOB), 1, 2004)
              ),
              scan(pos, cp, cut_before_nth, total_len) AS (
                SELECT 1, CASE WHEN length(b) >= 1 AND (substr(b, 1, 1) < X'80' OR substr(b, 1, 1) >= X'C0') THEN 1 ELSE 0 END, 0, length(b) FROM src
                UNION ALL
                SELECT
                  pos + 1,
                  cp + CASE WHEN (substr((SELECT b FROM src), pos + 1, 1) < X'80' OR substr((SELECT b FROM src), pos + 1, 1) >= X'C0') THEN 1 ELSE 0 END,
                  CASE
                    WHEN cut_before_nth = 0 AND cp = 499 AND (substr((SELECT b FROM src), pos + 1, 1) < X'80' OR substr((SELECT b FROM src), pos + 1, 1) >= X'C0')
                    THEN pos
                    ELSE cut_before_nth
                  END,
                  total_len
                FROM scan
                WHERE pos < total_len AND cp <= 500
              )
            SELECT CASE
              WHEN COALESCE((SELECT MAX(cp) FROM scan), 0) <= 500 THEN (SELECT txt FROM src)
              ELSE CAST(substr((SELECT b FROM src), 1, (SELECT MAX(cut_before_nth) FROM scan)) || CAST('…' AS BLOB) AS TEXT)
            END
          )
        END
      )
    )
    ELSE NULL
  END,
  ocr_revision_cached = CASE
    WHEN ocr_checkpoint IS NOT NULL
      AND json_valid(ocr_checkpoint) = 1
      AND json_type(ocr_checkpoint, '$.version') IN ('integer', 'real')
      AND json_extract(ocr_checkpoint, '$.version') = 2
      AND json_type(ocr_checkpoint, '$.sourceRevision') IN ('integer', 'real')
      AND json_extract(ocr_checkpoint, '$.sourceRevision') = image_revision
      AND json_type(ocr_checkpoint, '$.ocrRevision') IN ('integer', 'real')
      AND json_extract(ocr_checkpoint, '$.ocrRevision') >= 0
      AND json_extract(ocr_checkpoint, '$.ocrRevision') = CAST(json_extract(ocr_checkpoint, '$.ocrRevision') AS INTEGER)
    THEN CAST(json_extract(ocr_checkpoint, '$.ocrRevision') AS INTEGER)
    ELSE NULL
  END,
  export_ready_version = NULL;

-- 2) 仅对顶层关系列即可 100% 确定不可导出的记录（status = 'rejected'、report IS NULL、teacher_reviewed_at IS NULL）
--    直接写入阻塞原因与 summary_state_key（零 JSON 解析差异风险）；
--    凡「已审核（teacher_reviewed_at IS NOT NULL）、非 rejected 且有报告」的历史记录一律保持 summary_state_key = NULL，
--    统一交由权威 TypeScript 回填（backfillReviewSummaries / 单次硬上限 20 条的有界惰性回填）调用真实
--    readStoredOcrCheckpoint + evaluationReportSchema + deliveryReadiness 精确判定，确保与权威导出门禁 100% 等价。
UPDATE reviews
SET
  export_blocked_reason = CASE
    WHEN status = 'rejected' THEN '审核不通过的作文不能导出'
    WHEN report IS NULL THEN '批改报告尚未完成'
    WHEN teacher_reviewed_at IS NULL THEN
      CASE
        WHEN summary_is_legacy = 1 THEN '旧版示范段落报告需要完整重新分析后才能导出新格式'
        ELSE '尚未经过老师审核'
      END
    ELSE NULL
  END,
  summary_state_key = CASE
    WHEN (status = 'rejected' OR report IS NULL OR teacher_reviewed_at IS NULL)
      AND instr(CAST(COALESCE(config, '') AS BLOB), X'00') = 0
      AND instr(CAST(COALESCE(report, '') AS BLOB), X'00') = 0
      AND COALESCE(config, '') NOT LIKE '%\u0000%'
      AND COALESCE(report, '') NOT LIKE '%\u0000%'
    THEN CAST(revision AS TEXT) || ':' || CAST(image_revision AS TEXT) || ':' ||
         CAST(COALESCE(ocr_revision_cached, -1) AS TEXT) || ':' ||
         CAST(COALESCE(report_ocr_revision, -1) AS TEXT) || ':' ||
         status || ':' || CAST(COALESCE(teacher_reviewed_at, -1) AS TEXT)
    ELSE NULL
  END;

-- 3) 班级分页列表与待导出候选轻量覆盖索引（不改动 0014 既有 reviews_owner_active_updated_idx）
CREATE INDEX IF NOT EXISTS reviews_owner_class_updated_idx
  ON reviews(owner_id, class_name, updated_at DESC, created_at DESC)
  WHERE deleting_at IS NULL;

CREATE INDEX IF NOT EXISTS reviews_pending_export_ready_idx
  ON reviews(
    owner_id,
    class_name,
    updated_at DESC,
    created_at DESC,
    id DESC,
    revision,
    image_revision,
    ocr_revision_cached,
    report_ocr_revision,
    export_ready_version,
    status
  )
  WHERE deleting_at IS NULL AND teacher_reviewed_at IS NOT NULL AND status <> 'exported';
