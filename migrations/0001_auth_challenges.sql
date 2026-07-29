CREATE TABLE IF NOT EXISTS user_password_proofs (
  user_id TEXT PRIMARY KEY NOT NULL,
  salt TEXT NOT NULL,
  sealed_verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  normalized_username TEXT NOT NULL,
  salt TEXT NOT NULL,
  nonce TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS login_challenges_expiry_idx
  ON login_challenges(expires_at);
