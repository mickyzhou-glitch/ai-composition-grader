export const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;
export const LOGIN_USERNAME_FAILURE_LIMIT = 8;
export const LOGIN_IP_FAILURE_LIMIT = 20;
export const CHALLENGE_BURST_WINDOW_MS = 5 * 60_000;
export const CHALLENGE_IP_BURST_LIMIT = 40;
export const LOGIN_RATE_LIMIT_RETRY_AFTER_SECONDS = Math.ceil(LOGIN_FAILURE_WINDOW_MS / 1000);

export interface LoginAttemptGuard {
  isRateLimited(normalizedUsername: string, ipHash: string): Promise<boolean>;
  isChallengeFlooded(ipHash: string): Promise<boolean>;
  record(normalizedUsername: string, ipHash: string, succeeded: boolean): Promise<void>;
}

function countLeadingFailures(rows: Array<{ succeeded: number }>): number {
  let failures = 0;
  for (const row of rows) {
    if (row.succeeded === 1) break;
    failures += 1;
  }
  return failures;
}

export class D1LoginAttemptRepository implements LoginAttemptGuard {
  constructor(
    private readonly database: D1Database,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async isRateLimited(normalizedUsername: string, ipHash: string): Promise<boolean> {
    const cutoff = this.now() - LOGIN_FAILURE_WINDOW_MS;
    const [byUser, byIp] = await Promise.all([
      this.database.prepare(`
        SELECT succeeded FROM login_attempts
        WHERE normalized_username = ? AND attempted_at >= ?
        ORDER BY attempted_at DESC, id DESC
        LIMIT ?
      `).bind(normalizedUsername, cutoff, LOGIN_USERNAME_FAILURE_LIMIT).all<{ succeeded: number }>(),
      this.database.prepare(`
        SELECT succeeded FROM login_attempts
        WHERE ip_hash = ? AND attempted_at >= ?
        ORDER BY attempted_at DESC, id DESC
        LIMIT ?
      `).bind(ipHash, cutoff, LOGIN_IP_FAILURE_LIMIT).all<{ succeeded: number }>(),
    ]);
    return countLeadingFailures(byUser.results ?? []) >= LOGIN_USERNAME_FAILURE_LIMIT
      || countLeadingFailures(byIp.results ?? []) >= LOGIN_IP_FAILURE_LIMIT;
  }

  async isChallengeFlooded(ipHash: string): Promise<boolean> {
    const cutoff = this.now() - CHALLENGE_BURST_WINDOW_MS;
    const row = await this.database.prepare(`
      SELECT COUNT(*) AS count FROM login_challenges
      WHERE ip_hash = ? AND created_at >= ?
    `).bind(ipHash, cutoff).first<{ count: number }>();
    return (row?.count ?? 0) >= CHALLENGE_IP_BURST_LIMIT;
  }

  async record(normalizedUsername: string, ipHash: string, succeeded: boolean): Promise<void> {
    await this.database.prepare(`
      INSERT INTO login_attempts (normalized_username, ip_hash, succeeded, attempted_at)
      VALUES (?, ?, ?, ?)
    `).bind(normalizedUsername, ipHash, succeeded ? 1 : 0, this.now()).run();
  }
}
