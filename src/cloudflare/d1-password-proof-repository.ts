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

function asProof(row: UserProofRow): UserPasswordProof {
  return {
    user: {
      id: row.id,
      username: row.username,
      role: row.role,
      mustChangePassword: row.must_change_password === 1,
    },
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
}
