import type Database from "better-sqlite3";

const CREATE_USERS_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'teacher')),
  must_change_password INTEGER NOT NULL CHECK (must_change_password IN (0, 1)),
  disabled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique_idx
  ON users(username);
`;

const CREATE_REVIEWS_SQL = `
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
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
  student_name TEXT NOT NULL DEFAULT '',
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
  expires_at INTEGER,
  deleting_at INTEGER,
  privacy_consent_version TEXT,
  privacy_consented_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const CREATE_REMAINING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  role TEXT PRIMARY KEY CHECK (role IN ('vision', 'content')),
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS saved_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  config TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_id, title)
);

CREATE INDEX IF NOT EXISTS saved_assignments_owner_updated_at_idx
  ON saved_assignments(owner_id, updated_at);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx
  ON sessions(user_id);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_unique_idx
  ON sessions(token_hash);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  normalized_username TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  succeeded INTEGER NOT NULL CHECK (succeeded IN (0, 1)),
  attempted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS login_attempts_username_attempted_at_idx
  ON login_attempts(normalized_username, attempted_at);

CREATE INDEX IF NOT EXISTS login_attempts_ip_attempted_at_idx
  ON login_attempts(ip_hash, attempted_at);

CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  created_at INTEGER NOT NULL
);

DROP INDEX IF EXISTS security_events_user_id_idx;
DROP INDEX IF EXISTS security_events_created_at_idx;

CREATE INDEX IF NOT EXISTS security_events_user_created_at_idx
  ON security_events(user_id, created_at);

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

CREATE TABLE IF NOT EXISTS analysis_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'full' CHECK (mode IN ('full', 'content_only')),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')
  ),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  available_at INTEGER NOT NULL,
  lease_expires_at INTEGER,
  progress_stage TEXT NOT NULL CHECK (
    progress_stage IN (
      'queued',
      'reading_images',
      'saving_ocr',
      'generating_review',
      'mapping_annotations',
      'validating_result',
      'saving_result'
    )
  ),
  error_code TEXT,
  message TEXT,
  teacher_guidance TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS analysis_jobs_claim_idx
  ON analysis_jobs(status, available_at, created_at);

CREATE INDEX IF NOT EXISTS analysis_jobs_owner_review_idx
  ON analysis_jobs(owner_id, review_id);

CREATE INDEX IF NOT EXISTS analysis_jobs_review_id_idx
  ON analysis_jobs(review_id);

CREATE UNIQUE INDEX IF NOT EXISTS analysis_jobs_one_active_per_review_idx
  ON analysis_jobs(review_id)
  WHERE status IN ('queued', 'running');
`;

export const INITIALIZE_SCHEMA_SQL = [
  CREATE_USERS_SQL,
  CREATE_REVIEWS_SQL,
  CREATE_REMAINING_SCHEMA_SQL,
].join("\n");

function tableColumns(database: Database.Database, table: string): Set<string> {
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      ({ name }) => name,
    ),
  );
}

function migrateReviews(database: Database.Database): void {
  const columns = tableColumns(database, "reviews");
  const additions: Array<[string, string]> = [
    [
      "owner_id",
      "TEXT REFERENCES users(id)",
    ],
    ["revision", "INTEGER NOT NULL DEFAULT 0"],
    ["image_revision", "INTEGER NOT NULL DEFAULT 0"],
    ["ocr_checkpoint", "TEXT"],
    ["report_ocr_revision", "INTEGER"],
    ["analysis_run_id", "TEXT"],
    ["pdf_filename", "TEXT"],
    ["pdf_path", "TEXT"],
    ["pdf_revision", "INTEGER"],
    ["exported_at", "INTEGER"],
    ["expires_at", "INTEGER"],
    ["deleting_at", "INTEGER"],
    ["privacy_consent_version", "TEXT"],
    ["privacy_consented_at", "INTEGER"],
    ["student_name", "TEXT NOT NULL DEFAULT ''"],
  ];

  for (const [name, definition] of additions) {
    if (!columns.has(name)) {
      database.exec(`ALTER TABLE reviews ADD COLUMN ${name} ${definition}`);
    }
  }

  database.exec(`
    UPDATE reviews SET owner_id = 'local-admin' WHERE owner_id IS NULL;

    CREATE INDEX IF NOT EXISTS reviews_owner_created_at_idx
      ON reviews(owner_id, created_at);
    CREATE INDEX IF NOT EXISTS reviews_owner_deleting_at_idx
      ON reviews(owner_id, deleting_at);
    CREATE INDEX IF NOT EXISTS reviews_expires_deleting_at_idx
      ON reviews(expires_at, deleting_at);
  `);

  const ownerColumn = database
    .prepare("PRAGMA table_info(reviews)")
    .all()
    .find((column) => (column as { name: string }).name === "owner_id") as
    | { notnull: number; dflt_value: string | null }
    | undefined;
  if (ownerColumn && (ownerColumn.notnull !== 1 || ownerColumn.dflt_value !== null)) {
    // SQLite cannot change NOT NULL/default metadata in place. Rebuild the
    // parent table after legacy rows have been assigned to local-admin.
    database.exec(`
      CREATE TABLE reviews_owner_migration (
        id TEXT PRIMARY KEY NOT NULL,
        owner_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL CHECK (
          status IN ('draft', 'analyzing', 'needs_better_images', 'ready_for_review', 'exported', 'failed')
        ),
        student_name TEXT NOT NULL DEFAULT '',
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
        expires_at INTEGER,
        deleting_at INTEGER,
        privacy_consent_version TEXT,
        privacy_consented_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO reviews_owner_migration (
        id, owner_id, status, student_name, config, report, revision, image_revision,
        ocr_checkpoint, report_ocr_revision, analysis_run_id,
        pdf_filename, pdf_path, pdf_revision, exported_at, expires_at,
        deleting_at, privacy_consent_version, privacy_consented_at, created_at, updated_at
      )
      SELECT id, owner_id, status, student_name, config, report, revision, image_revision,
        ocr_checkpoint, report_ocr_revision, analysis_run_id,
        pdf_filename, pdf_path, pdf_revision, exported_at, expires_at,
        deleting_at, privacy_consent_version, privacy_consented_at, created_at, updated_at
      FROM reviews;
      DROP TABLE reviews;
      ALTER TABLE reviews_owner_migration RENAME TO reviews;
    `);
  }

  // The rebuild above drops table-local indexes, so recreate them afterwards
  // for both legacy and already-current databases.
  database.exec(`
    CREATE INDEX IF NOT EXISTS reviews_owner_created_at_idx
      ON reviews(owner_id, created_at);
    CREATE INDEX IF NOT EXISTS reviews_owner_deleting_at_idx
      ON reviews(owner_id, deleting_at);
    CREATE INDEX IF NOT EXISTS reviews_expires_deleting_at_idx
      ON reviews(expires_at, deleting_at);
  `);
}

function migrateSettings(database: Database.Database): void {
  const columns = tableColumns(database, "settings");
  if (columns.has("role")) return;
  database.exec(`
    CREATE TABLE settings_role_migration (
      role TEXT PRIMARY KEY CHECK (role IN ('vision', 'content')),
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    INSERT INTO settings_role_migration (role, base_url, model, updated_at)
      SELECT 'vision', base_url, model, updated_at FROM settings WHERE id = 1;
    INSERT INTO settings_role_migration (role, base_url, model, updated_at)
      SELECT 'content', base_url, model, updated_at FROM settings WHERE id = 1;
    DROP TABLE settings;
    ALTER TABLE settings_role_migration RENAME TO settings;
  `);
}

function migrateLegacyReviewImages(database: Database.Database): void {
  const columns = tableColumns(database, "review_images");
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
}

function migrateAnalysisJobs(database: Database.Database): void {
  const columns = tableColumns(database, "analysis_jobs");
  const tableSql = (database.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'analysis_jobs'",
  ).get() as { sql?: string } | undefined)?.sql ?? "";
  if (columns.has("mode") && tableSql.includes("saving_ocr") && tableSql.includes("mapping_annotations")) return;

  database.exec(`
    CREATE TABLE analysis_jobs_pipeline_migration (
      id TEXT PRIMARY KEY NOT NULL,
      review_id TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mode TEXT NOT NULL DEFAULT 'full' CHECK (mode IN ('full', 'content_only')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
      available_at INTEGER NOT NULL,
      lease_expires_at INTEGER,
      progress_stage TEXT NOT NULL CHECK (
        progress_stage IN (
          'queued', 'reading_images', 'saving_ocr', 'generating_review',
          'mapping_annotations', 'validating_result', 'saving_result'
        )
      ),
      error_code TEXT,
      message TEXT,
      teacher_guidance TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER
    );
    INSERT INTO analysis_jobs_pipeline_migration (
      id, review_id, owner_id, mode, status, attempt, available_at, lease_expires_at,
      progress_stage, error_code, message, teacher_guidance, created_at, started_at, finished_at
    )
    SELECT id, review_id, owner_id, ${columns.has("mode") ? "mode" : "'full'"}, status, attempt,
      available_at, lease_expires_at, progress_stage, error_code, message,
      ${columns.has("teacher_guidance") ? "teacher_guidance" : "NULL"}, created_at, started_at, finished_at
    FROM analysis_jobs;
    DROP TABLE analysis_jobs;
    ALTER TABLE analysis_jobs_pipeline_migration RENAME TO analysis_jobs;
    CREATE INDEX analysis_jobs_claim_idx ON analysis_jobs(status, available_at, created_at);
    CREATE INDEX analysis_jobs_owner_review_idx ON analysis_jobs(owner_id, review_id);
    CREATE INDEX analysis_jobs_review_id_idx ON analysis_jobs(review_id);
    CREATE UNIQUE INDEX analysis_jobs_one_active_per_review_idx
      ON analysis_jobs(review_id) WHERE status IN ('queued', 'running');
  `);
}

function assertForeignKeys(database: Database.Database): void {
  const violations = database.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(`Schema migration left ${violations.length} foreign key violation(s)`);
  }
}

export function initializeSchema(database: Database.Database): void {
  if (database.inTransaction) {
    throw new Error("initializeSchema cannot run inside an existing transaction");
  }

  database.pragma("foreign_keys = OFF");
  try {
    database.transaction(() => {
      database.exec(CREATE_USERS_SQL);
      database.exec(`
        INSERT OR IGNORE INTO users (
          id,
          username,
          password_hash,
          role,
          must_change_password,
          created_at,
          updated_at
        ) VALUES (
          'local-admin',
          'local-admin',
          '!bootstrap-required',
          'admin',
          1,
          unixepoch() * 1000,
          unixepoch() * 1000
        );
      `);

      database.exec(CREATE_REVIEWS_SQL);
      migrateReviews(database);
      database.exec(CREATE_REMAINING_SCHEMA_SQL);
      migrateSettings(database);
      migrateAnalysisJobs(database);
      migrateLegacyReviewImages(database);
      assertForeignKeys(database);
    })();
  } finally {
    database.pragma("foreign_keys = ON");
  }
}
