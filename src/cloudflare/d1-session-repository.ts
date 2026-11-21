const SESSION_TOUCH_INTERVAL_MS = 60_000;

export class D1SessionRepository {
  constructor(
    private readonly database: D1Database,
    private readonly scheduleBackground?: (task: Promise<unknown>) => void,
  ) {}

  async create(input: { id: string; userId: string; tokenHash: string; expiresAt: Date; now: Date }): Promise<void> {
    await this.database.prepare(`
      INSERT INTO sessions (id, user_id, token_hash, last_seen_at, expires_at, created_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).bind(
      input.id, input.userId, input.tokenHash, input.now.getTime(), input.expiresAt.getTime(), input.now.getTime(),
    ).run();
  }

  async findActiveByTokenHash(
    tokenHash: string,
    now: Date,
  ): Promise<{ user: { id: string; username: string; role: "admin" | "teacher"; mustChangePassword: boolean }; expiresAt: Date } | null> {
    const nowMs = now.getTime();
    const row = await this.database.prepare(`
      SELECT users.id, users.username, users.role, users.must_change_password,
             sessions.id AS session_id, sessions.last_seen_at, sessions.expires_at
      FROM sessions INNER JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.revoked_at IS NULL AND sessions.expires_at > ? AND users.disabled_at IS NULL
    `).bind(tokenHash, nowMs).first<{
      id: string;
      username: string;
      role: "admin" | "teacher";
      must_change_password: number;
      session_id?: string;
      last_seen_at?: number;
      expires_at: number;
    }>();
    if (!row) return null;
    if (row.session_id && typeof row.last_seen_at === "number" && nowMs - row.last_seen_at >= SESSION_TOUCH_INTERVAL_MS) {
      const touch = this.database.prepare(
        "UPDATE sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL",
      ).bind(nowMs, row.session_id).run().catch(() => undefined);
      if (this.scheduleBackground) {
        this.scheduleBackground(touch);
      } else {
        await touch;
      }
    }
    return {
      user: {
        id: row.id,
        username: row.username,
        role: row.role,
        mustChangePassword: row.must_change_password === 1,
      },
      expiresAt: new Date(row.expires_at),
    };
  }

  async revokeByTokenHash(tokenHash: string, now: Date): Promise<void> {
    await this.database.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").bind(now.getTime(), tokenHash).run();
  }
}
