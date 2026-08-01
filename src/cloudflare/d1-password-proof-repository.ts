import type { AuthenticatedUser, UserRole } from "../auth/auth-types";
import type { SealedPasswordVerifier } from "../auth/password-proof";

interface UserProofRow {
  id: string;
  username: string;
  role: UserRole;
  must_change_password: number;
  disabled_at: number | null;
  salt: string;
  sealed_verifier: string;
}

interface LoginCandidateRow {
  id: string;
  username: string;
  role: UserRole;
  must_change_password: number;
  disabled_at: number | null;
  password_hash: string;
  salt: string | null;
  sealed_verifier: string | null;
}

export interface UserPasswordProof {
  user: AuthenticatedUser;
  disabledAt: Date | null;
  salt: string;
  sealed: SealedPasswordVerifier;
}

export interface LegacyPasswordUser {
  user: AuthenticatedUser;
  disabledAt: Date | null;
  passwordHash: string;
}

export interface PasswordLoginCandidate {
  proof: UserPasswordProof | null;
  legacy: LegacyPasswordUser;
}

function authenticatedUser(row: Pick<UserProofRow, "id" | "username" | "role" | "must_change_password">): AuthenticatedUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    mustChangePassword: row.must_change_password === 1,
  };
}

function asProof(row: UserProofRow): UserPasswordProof {
  return {
    user: authenticatedUser(row),
    disabledAt: row.disabled_at === null ? null : new Date(row.disabled_at),
    salt: row.salt,
    sealed: JSON.parse(row.sealed_verifier) as SealedPasswordVerifier,
  };
}

export class D1PasswordProofRepository {
  constructor(private readonly database: D1Database) {}

  async findByUsername(username: string): Promise<UserPasswordProof | null> {
    const row = await this.database.prepare(`
      SELECT users.id, users.username, users.role, users.must_change_password, users.disabled_at,
             user_password_proofs.salt, user_password_proofs.sealed_verifier
      FROM users INNER JOIN user_password_proofs ON user_password_proofs.user_id = users.id
      WHERE users.username = ?
    `).bind(username).first<UserProofRow>();
    return row ? asProof(row) : null;
  }

  async findLoginCandidateByUsername(username: string): Promise<PasswordLoginCandidate | null> {
    const row = await this.database.prepare(`
      SELECT users.id, users.username, users.role, users.must_change_password, users.disabled_at,
             users.password_hash, user_password_proofs.salt, user_password_proofs.sealed_verifier
      FROM users LEFT JOIN user_password_proofs ON user_password_proofs.user_id = users.id
      WHERE users.username = ?
    `).bind(username).first<LoginCandidateRow>();
    if (!row) return null;
    const user = authenticatedUser(row);
    const disabledAt = row.disabled_at === null ? null : new Date(row.disabled_at);
    return {
      legacy: { user, disabledAt, passwordHash: row.password_hash },
      proof: row.salt !== null && row.sealed_verifier !== null
        ? { user, disabledAt, salt: row.salt, sealed: JSON.parse(row.sealed_verifier) as SealedPasswordVerifier }
        : null,
    };
  }

  async findLegacyByUsername(username: string): Promise<LegacyPasswordUser | null> {
    const row = await this.database.prepare(`
      SELECT id, username, role, must_change_password, disabled_at, password_hash
      FROM users WHERE username = ?
    `).bind(username).first<{
      id: string; username: string; role: UserRole; must_change_password: number; disabled_at: number | null; password_hash: string;
    }>();
    return row ? {
      user: { id: row.id, username: row.username, role: row.role, mustChangePassword: row.must_change_password === 1 },
      disabledAt: row.disabled_at === null ? null : new Date(row.disabled_at),
      passwordHash: row.password_hash,
    } : null;
  }

  async save(userId: string, salt: string, sealed: SealedPasswordVerifier, now: Date): Promise<void> {
    await this.database.prepare(`
      INSERT INTO user_password_proofs (user_id, salt, sealed_verifier, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET salt = excluded.salt, sealed_verifier = excluded.sealed_verifier, updated_at = excluded.updated_at
    `).bind(userId, salt, JSON.stringify(sealed), now.getTime(), now.getTime()).run();
  }

  async saveIfMissing(userId: string, salt: string, sealed: SealedPasswordVerifier, now: Date): Promise<boolean> {
    const result = await this.database.prepare(`
      INSERT INTO user_password_proofs (user_id, salt, sealed_verifier, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO NOTHING
    `).bind(userId, salt, JSON.stringify(sealed), now.getTime(), now.getTime()).run();
    return result.meta.changes > 0;
  }

  async clearMustChangePassword(userId: string): Promise<void> {
    await this.database.prepare("UPDATE users SET must_change_password = 0 WHERE id = ?").bind(userId).run();
  }
}
