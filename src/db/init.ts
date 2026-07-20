import type Database from "better-sqlite3";

export const INITIALIZE_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'draft',
      'analyzing',
      'needs_better_images',
      'ready_for_review',
      'exported',
      'failed'
    )
  ),
  config TEXT NOT NULL,
  report TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS review_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL CHECK (page_index >= 0),
  path TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  original_path TEXT NOT NULL,
  annotation_path TEXT NOT NULL,
  ai_path TEXT NOT NULL,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  rotation INTEGER NOT NULL CHECK (rotation IN (0, 90, 180, 270)),
  crop TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS review_images_review_id_idx
  ON review_images(review_id);

CREATE TABLE IF NOT EXISTS annotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  page_index INTEGER NOT NULL CHECK (page_index >= 0),
  x REAL NOT NULL CHECK (x >= 0 AND x <= 1),
  y REAL NOT NULL CHECK (y >= 0 AND y <= 1),
  category TEXT NOT NULL CHECK (
    category IN ('typo', 'punctuation', 'sentence', 'expression', 'structure', 'highlight')
  ),
  anchor_text TEXT NOT NULL,
  comment TEXT NOT NULL,
  is_highlight INTEGER NOT NULL CHECK (is_highlight IN (0, 1)),
  UNIQUE(review_id, position)
);

CREATE INDEX IF NOT EXISTS annotations_review_id_idx
  ON annotations(review_id);
`;

export function initializeSchema(database: Database.Database): void {
  database.exec(INITIALIZE_SCHEMA_SQL);
  migrateLegacyReviewImages(database);
}

function migrateLegacyReviewImages(database: Database.Database): void {
  const columns = new Set(
    (database.prepare("PRAGMA table_info(review_images)").all() as Array<{ name: string }>).map(
      ({ name }) => name,
    ),
  );
  const additions: Array<[string, string]> = [
    ["position", "INTEGER NOT NULL DEFAULT 0"],
    ["original_name", "TEXT NOT NULL DEFAULT 'legacy-image.jpg'"],
    ["mime_type", "TEXT NOT NULL DEFAULT 'image/jpeg'"],
    ["original_path", "TEXT NOT NULL DEFAULT ''"],
    ["annotation_path", "TEXT NOT NULL DEFAULT ''"],
    ["ai_path", "TEXT NOT NULL DEFAULT ''"],
    ["width", "INTEGER NOT NULL DEFAULT 1"],
    ["height", "INTEGER NOT NULL DEFAULT 1"],
    ["rotation", "INTEGER NOT NULL DEFAULT 0"],
    ["crop", "TEXT"],
  ];

  database.transaction(() => {
    for (const [name, definition] of additions) {
      if (!columns.has(name)) {
        database.exec(`ALTER TABLE review_images ADD COLUMN ${name} ${definition}`);
      }
    }
    database.exec(`
      UPDATE review_images SET
        position = page_index,
        original_path = CASE WHEN original_path = '' THEN path ELSE original_path END,
        annotation_path = CASE WHEN annotation_path = '' THEN path ELSE annotation_path END,
        ai_path = CASE WHEN ai_path = '' THEN path ELSE ai_path END
      WHERE original_path = '' OR annotation_path = '' OR ai_path = '';
    `);
  })();
}
