import type { CreateLoginChallengeInput, LoginChallengeRecord, LoginChallengeRepository } from "../auth/login-challenge-repository";

interface ChallengeRow {
  id: string;
  normalized_username: string;
  salt: string;
  nonce: string;
  ip_hash: string;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
}

function toRecord(row: ChallengeRow): LoginChallengeRecord {
  return {
    id: row.id,
    normalizedUsername: row.normalized_username,
    salt: row.salt,
    nonce: row.nonce,
    ipHash: row.ip_hash,
    expiresAt: new Date(row.expires_at),
    consumedAt: row.consumed_at === null ? null : new Date(row.consumed_at),
    createdAt: new Date(row.created_at),
  };
}

export class D1LoginChallengeRepository implements LoginChallengeRepository {
  constructor(
    private readonly database: D1Database,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {}

  async create(input: CreateLoginChallengeInput): Promise<LoginChallengeRecord> {
    const createdAt = this.now();
    const record = {
      id: this.createId(),
      normalizedUsername: input.normalizedUsername,
      salt: input.salt,
      nonce: input.nonce,
      ipHash: input.ipHash,
      expiresAt: new Date(createdAt.getTime() + input.ttlMs),
      createdAt,
    };
    await this.database.prepare(`
      INSERT INTO login_challenges (id, normalized_username, salt, nonce, ip_hash, expires_at, consumed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `).bind(
      record.id, record.normalizedUsername, record.salt, record.nonce, record.ipHash,
      record.expiresAt.getTime(), record.createdAt.getTime(),
    ).run();
    return { ...record, consumedAt: null };
  }

  async consumeIfActive(challengeId: string, ipHash: string): Promise<LoginChallengeRecord | null> {
    const consumedAt = this.now().getTime();
    const row = await this.database.prepare(`
      UPDATE login_challenges
      SET consumed_at = ?
      WHERE id = ? AND ip_hash = ? AND consumed_at IS NULL AND expires_at > ?
      RETURNING id, normalized_username, salt, nonce, ip_hash, expires_at, consumed_at, created_at
    `).bind(consumedAt, challengeId, ipHash, consumedAt).first<ChallengeRow>();
    return row ? toRecord(row) : null;
  }
}
