export class D1SessionRepository {
  constructor(private readonly database: D1Database) {}

  async create(input: { id: string; userId: string; tokenHash: string; expiresAt: Date; now: Date }): Promise<void> {
    await this.database.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, last_seen_at, expires_at, created_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).bind(
      input.id, input.userId, input.tokenHash, input.now.getTime(), input.expiresAt.getTime(), input.now.getTime(),
    ).run();
  }
}
