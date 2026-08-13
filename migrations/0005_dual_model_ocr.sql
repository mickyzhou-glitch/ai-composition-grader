PRAGMA foreign_keys = OFF;

CREATE TABLE settings_new (
  role TEXT PRIMARY KEY CHECK (role IN ('vision', 'content')),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  encrypted_api_key TEXT
);

INSERT INTO settings_new (role, base_url, model, updated_at, encrypted_api_key)
SELECT 'vision', base_url, model, updated_at, encrypted_api_key FROM settings WHERE id = 1;

INSERT INTO settings_new (role, base_url, model, updated_at, encrypted_api_key)
SELECT 'content', base_url, model, updated_at, encrypted_api_key FROM settings WHERE id = 1;

DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

ALTER TABLE reviews ADD COLUMN image_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN ocr_checkpoint TEXT;
ALTER TABLE reviews ADD COLUMN report_ocr_revision INTEGER;

PRAGMA foreign_keys = ON;
