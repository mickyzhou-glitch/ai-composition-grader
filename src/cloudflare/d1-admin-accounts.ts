import type { AuthenticatedUser, UserRole } from "../auth/auth-types";
import type { SealedPasswordVerifier } from "../auth/password-proof";
import { LOGIN_FAILURE_WINDOW_MS, LOGIN_USERNAME_FAILURE_LIMIT } from "./d1-login-attempts";
import type { SecurityEventRecorder } from "./worker-auth-routes";

const ONLINE_WINDOW_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const SEVEN_DAYS_MS = 7 * DAY_MS;
const THIRTY_DAYS_MS = 30 * DAY_MS;
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/u;

export type AccountActivityLevel = "online" | "today" | "active_7d" | "active_30d" | "inactive" | "never";

export interface AdminSecurityEventView {
  id: number;
  userId: string | null;
  username: string | null;
  eventType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AdminAccountView {
  id: string;
  username: string;
  role: UserRole;
  isCurrentUser: boolean;
  enabled: boolean;
  disabledAt: string | null;
  mustChangePassword: boolean;
  proofMode: "modern" | "legacy";
  rateLimited: boolean;
  consecutiveFailures15m: number;
  activityLevel: AccountActivityLevel;
  createdAt: string;
  updatedAt: string;
  login: {
    activeSessions: number;
    lastSeenAt: string | null;
    lastLoginAt: string | null;
    succeeded7d: number;
    failed7d: number;
    lastFailedAt: string | null;
  };
  usage: {
    totalReviews: number;
    reviews7d: number;
    reviews30d: number;
    draftCount: number;
    analyzingCount: number;
    pendingReviewCount: number;
    reviewedCount: number;
    exportedCount: number;
    failedCount: number;
    rejectedCount: number;
    jobsSucceeded: number;
    jobsFailed: number;
    jobsSucceeded7d: number;
    jobsFailed7d: number;
    jobsActive: number;
    savedAssignmentsCount: number;
    standingRulesCount: number;
    essayOpinionsCount: number;
    lastReviewActivityAt: string | null;
    lastActiveAt: string | null;
  };
  recentEvents: AdminSecurityEventView[];
}

export interface AdminAccountsSummary {
  totalUsers: number;
  enabledUsers: number;
  disabledUsers: number;
  adminCount: number;
  teacherCount: number;
  onlineUsers: number;
  activeSessionsTotal: number;
  activeUsers7d: number;
  totalReviews: number;
  reviews7d: number;
  totalJobsSucceeded: number;
  totalJobsFailed: number;
  jobsSucceeded7d: number;
  jobsFailed7d: number;
  loginsSucceeded7d: number;
  loginsFailed7d: number;
  rateLimitedUsers: number;
}

export interface AdminAccountsOverview {
  currentUserId: string;
  generatedAt: string;
  summary: AdminAccountsSummary;
  accounts: AdminAccountView[];
  recentEvents: AdminSecurityEventView[];
}

export class AdminAccountError extends Error {
  constructor(
    readonly code:
      | "VALIDATION_ERROR"
      | "ACCOUNT_NOT_FOUND"
      | "USERNAME_TAKEN"
      | "SELF_ACTION_FORBIDDEN"
      | "LAST_ADMIN_REQUIRED",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AdminAccountError";
  }
}

function isoOrNull(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function maxTimestamp(...values: Array<number | null | undefined>): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      if (best === null || value > best) best = value;
    }
  }
  return best;
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function normalizeAccountUsername(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new AdminAccountError("VALIDATION_ERROR", "请输入 3 至 32 位用户名（仅限字母、数字、点、下划线或连字符）", 400);
  }
  const normalized = raw.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(normalized) || normalized === "anonymous") {
    throw new AdminAccountError("VALIDATION_ERROR", "用户名需为 3 至 32 位字母、数字、.、_ 或 -", 400);
  }
  return normalized;
}

export class D1SecurityEvents implements SecurityEventRecorder {
  constructor(private readonly database: D1Database) {}

  async record(
    userId: string,
    eventType: string,
    metadata: Record<string, unknown> = {},
    now = new Date(),
  ): Promise<void> {
    await this.database.prepare(`
      INSERT INTO security_events (user_id, event_type, metadata, created_at)
      VALUES (?, ?, ?, ?)
    `).bind(userId, eventType, JSON.stringify(metadata), now.getTime()).run();
  }
}

export class D1AdminAccounts {
  constructor(private readonly database: D1Database) {}

  async overview(currentUserId: string, now = new Date()): Promise<AdminAccountsOverview> {
    const nowMs = now.getTime();
    const cutoff15m = nowMs - LOGIN_FAILURE_WINDOW_MS;
    const cutoff7d = nowMs - SEVEN_DAYS_MS;
    const cutoff30d = nowMs - THIRTY_DAYS_MS;

    const [
      userRows,
      sessionRows,
      attemptSummaryRows,
      recentAttemptRows,
      reviewRows,
      jobRows,
      assignmentRows,
      opinionRows,
      lastLoginEventRows,
      recentEventRows,
    ] = await Promise.all([
      this.database.prepare(`
        SELECT users.id, users.username, users.role, users.must_change_password,
               users.disabled_at, users.created_at, users.updated_at,
               CASE WHEN user_password_proofs.user_id IS NOT NULL THEN 1 ELSE 0 END AS has_proof
        FROM users
        LEFT JOIN user_password_proofs ON user_password_proofs.user_id = users.id
        ORDER BY users.created_at ASC, users.username ASC
      `).all<{
        id: string;
        username: string;
        role: UserRole;
        must_change_password: number;
        disabled_at: number | null;
        created_at: number;
        updated_at: number;
        has_proof: number;
      }>(),
      this.database.prepare(`
        SELECT user_id,
               SUM(CASE WHEN revoked_at IS NULL AND expires_at > ? THEN 1 ELSE 0 END) AS active_sessions,
               MAX(last_seen_at) AS last_seen_at,
               MAX(CASE WHEN revoked_at IS NULL AND expires_at > ? THEN last_seen_at ELSE NULL END) AS active_last_seen_at,
               MAX(created_at) AS last_session_created_at
        FROM sessions
        GROUP BY user_id
      `).bind(nowMs, nowMs).all<{
        user_id: string;
        active_sessions: number;
        last_seen_at: number | null;
        active_last_seen_at: number | null;
        last_session_created_at: number | null;
      }>(),
      this.database.prepare(`
        SELECT normalized_username,
               SUM(CASE WHEN succeeded = 1 THEN 1 ELSE 0 END) AS succeeded_7d,
               SUM(CASE WHEN succeeded = 0 THEN 1 ELSE 0 END) AS failed_7d,
               MAX(CASE WHEN succeeded = 1 THEN attempted_at ELSE NULL END) AS last_succeeded_at,
               MAX(CASE WHEN succeeded = 0 THEN attempted_at ELSE NULL END) AS last_failed_at
        FROM login_attempts
        WHERE attempted_at >= ?
        GROUP BY normalized_username
      `).bind(cutoff7d).all<{
        normalized_username: string;
        succeeded_7d: number;
        failed_7d: number;
        last_succeeded_at: number | null;
        last_failed_at: number | null;
      }>(),
      this.database.prepare(`
        SELECT normalized_username, succeeded
        FROM login_attempts
        WHERE attempted_at >= ?
        ORDER BY attempted_at DESC, id DESC
      `).bind(cutoff15m).all<{ normalized_username: string; succeeded: number }>(),
      this.database.prepare(`
        SELECT owner_id,
               COUNT(*) AS total_reviews,
               SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS reviews_7d,
               SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS reviews_30d,
               SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft_count,
               SUM(CASE WHEN status = 'analyzing' THEN 1 ELSE 0 END) AS analyzing_count,
               SUM(CASE WHEN status = 'ready_for_review' AND teacher_reviewed_at IS NULL THEN 1 ELSE 0 END) AS pending_review_count,
               SUM(CASE WHEN status = 'ready_for_review' AND teacher_reviewed_at IS NOT NULL THEN 1 ELSE 0 END) AS reviewed_count,
               SUM(CASE WHEN status = 'exported' THEN 1 ELSE 0 END) AS exported_count,
               SUM(CASE WHEN status IN ('failed', 'needs_better_images') THEN 1 ELSE 0 END) AS failed_count,
               SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
               MAX(updated_at) AS last_review_activity_at
        FROM reviews
        WHERE deleting_at IS NULL
        GROUP BY owner_id
      `).bind(cutoff7d, cutoff30d).all<{
        owner_id: string;
        total_reviews: number;
        reviews_7d: number;
        reviews_30d: number;
        draft_count: number;
        analyzing_count: number;
        pending_review_count: number;
        reviewed_count: number;
        exported_count: number;
        failed_count: number;
        rejected_count: number;
        last_review_activity_at: number | null;
      }>(),
      this.database.prepare(`
        SELECT owner_id,
               SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS jobs_succeeded,
               SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS jobs_failed,
               SUM(CASE WHEN status = 'succeeded' AND created_at >= ? THEN 1 ELSE 0 END) AS jobs_succeeded_7d,
               SUM(CASE WHEN status = 'failed' AND created_at >= ? THEN 1 ELSE 0 END) AS jobs_failed_7d,
               SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) AS jobs_active,
               MAX(COALESCE(finished_at, started_at, created_at)) AS last_job_at
        FROM analysis_jobs
        GROUP BY owner_id
      `).bind(cutoff7d, cutoff7d).all<{
        owner_id: string;
        jobs_succeeded: number;
        jobs_failed: number;
        jobs_succeeded_7d: number;
        jobs_failed_7d: number;
        jobs_active: number;
        last_job_at: number | null;
      }>(),
      this.database.prepare(`
        SELECT owner_id, COUNT(*) AS count
        FROM saved_assignments
        GROUP BY owner_id
      `).all<{ owner_id: string; count: number }>(),
      this.database.prepare(`
        SELECT owner_id,
               SUM(CASE WHEN scope = 'standing' THEN 1 ELSE 0 END) AS standing_count,
               SUM(CASE WHEN scope <> 'standing' THEN 1 ELSE 0 END) AS essay_count
        FROM grading_opinions
        GROUP BY owner_id
      `).all<{ owner_id: string; standing_count: number; essay_count: number }>(),
      this.database.prepare(`
        SELECT user_id,
               MAX(CASE WHEN event_type = 'login_succeeded' THEN created_at ELSE NULL END) AS last_login_event_at,
               MAX(created_at) AS last_event_at
        FROM security_events
        WHERE user_id IS NOT NULL
        GROUP BY user_id
      `).all<{ user_id: string; last_login_event_at: number | null; last_event_at: number | null }>(),
      this.database.prepare(`
        SELECT security_events.id, security_events.user_id, users.username,
               security_events.event_type, security_events.metadata, security_events.created_at
        FROM security_events
        LEFT JOIN users ON users.id = security_events.user_id
        ORDER BY security_events.created_at DESC, security_events.id DESC
        LIMIT 80
      `).all<{
        id: number;
        user_id: string | null;
        username: string | null;
        event_type: string;
        metadata: string;
        created_at: number;
      }>(),
    ]);

    const sessionsByUser = new Map((sessionRows.results ?? []).map((row) => [row.user_id, row]));
    const attemptsByUsername = new Map((attemptSummaryRows.results ?? []).map((row) => [row.normalized_username, row]));
    const reviewsByOwner = new Map((reviewRows.results ?? []).map((row) => [row.owner_id, row]));
    const jobsByOwner = new Map((jobRows.results ?? []).map((row) => [row.owner_id, row]));
    const assignmentsByOwner = new Map((assignmentRows.results ?? []).map((row) => [row.owner_id, row.count]));
    const opinionsByOwner = new Map((opinionRows.results ?? []).map((row) => [row.owner_id, row]));
    const loginEventsByUser = new Map((lastLoginEventRows.results ?? []).map((row) => [row.user_id, row]));

    const consecutiveFailures = new Map<string, { count: number; locked: boolean }>();
    for (const row of recentAttemptRows.results ?? []) {
      const state = consecutiveFailures.get(row.normalized_username) ?? { count: 0, locked: false };
      if (state.locked) continue;
      if (row.succeeded === 1) {
        state.locked = true;
      } else {
        state.count += 1;
      }
      consecutiveFailures.set(row.normalized_username, state);
    }

    const recentEvents: AdminSecurityEventView[] = (recentEventRows.results ?? []).map((row) => ({
      id: row.id,
      userId: row.user_id,
      username: row.username,
      eventType: row.event_type,
      metadata: parseMetadata(row.metadata),
      createdAt: new Date(row.created_at).toISOString(),
    }));
    const eventsByUser = new Map<string, AdminSecurityEventView[]>();
    for (const event of recentEvents) {
      if (!event.userId) continue;
      const list = eventsByUser.get(event.userId) ?? [];
      if (list.length < 6) list.push(event);
      eventsByUser.set(event.userId, list);
    }

    const accounts: AdminAccountView[] = (userRows.results ?? []).map((user) => {
      const normalizedUsername = user.username.trim().toLowerCase();
      const session = sessionsByUser.get(user.id);
      const attempt = attemptsByUsername.get(normalizedUsername);
      const failureStreak = consecutiveFailures.get(normalizedUsername)?.count ?? 0;
      const rateLimited = failureStreak >= LOGIN_USERNAME_FAILURE_LIMIT;
      const review = reviewsByOwner.get(user.id);
      const job = jobsByOwner.get(user.id);
      const opinion = opinionsByOwner.get(user.id);
      const loginEvent = loginEventsByUser.get(user.id);

      const activeSessions = Number(session?.active_sessions ?? 0);
      const lastSeenMs = session?.last_seen_at ?? null;
      const activeLastSeenMs = session?.active_last_seen_at ?? null;
      const lastLoginMs = maxTimestamp(
        loginEvent?.last_login_event_at,
        session?.last_session_created_at,
        attempt?.last_succeeded_at,
      );
      const lastReviewMs = review?.last_review_activity_at ?? null;
      const lastActiveMs = maxTimestamp(
        lastSeenMs,
        lastLoginMs,
        lastReviewMs,
        job?.last_job_at,
      );

      let activityLevel: AccountActivityLevel = "never";
      if (activeSessions > 0 && activeLastSeenMs !== null && activeLastSeenMs >= nowMs - ONLINE_WINDOW_MS) {
        activityLevel = "online";
      } else if (lastActiveMs !== null && lastActiveMs >= nowMs - DAY_MS) {
        activityLevel = "today";
      } else if (lastActiveMs !== null && lastActiveMs >= cutoff7d) {
        activityLevel = "active_7d";
      } else if (lastActiveMs !== null && lastActiveMs >= cutoff30d) {
        activityLevel = "active_30d";
      } else if (lastActiveMs !== null) {
        activityLevel = "inactive";
      }

      return {
        id: user.id,
        username: user.username,
        role: user.role,
        isCurrentUser: user.id === currentUserId,
        enabled: user.disabled_at === null,
        disabledAt: isoOrNull(user.disabled_at),
        mustChangePassword: user.must_change_password === 1,
        proofMode: user.has_proof === 1 ? "modern" : "legacy",
        rateLimited,
        consecutiveFailures15m: failureStreak,
        activityLevel,
        createdAt: new Date(user.created_at).toISOString(),
        updatedAt: new Date(user.updated_at).toISOString(),
        login: {
          activeSessions,
          lastSeenAt: isoOrNull(lastSeenMs),
          lastLoginAt: isoOrNull(lastLoginMs),
          succeeded7d: Number(attempt?.succeeded_7d ?? 0),
          failed7d: Number(attempt?.failed_7d ?? 0),
          lastFailedAt: isoOrNull(attempt?.last_failed_at),
        },
        usage: {
          totalReviews: Number(review?.total_reviews ?? 0),
          reviews7d: Number(review?.reviews_7d ?? 0),
          reviews30d: Number(review?.reviews_30d ?? 0),
          draftCount: Number(review?.draft_count ?? 0),
          analyzingCount: Number(review?.analyzing_count ?? 0),
          pendingReviewCount: Number(review?.pending_review_count ?? 0),
          reviewedCount: Number(review?.reviewed_count ?? 0),
          exportedCount: Number(review?.exported_count ?? 0),
          failedCount: Number(review?.failed_count ?? 0),
          rejectedCount: Number(review?.rejected_count ?? 0),
          jobsSucceeded: Number(job?.jobs_succeeded ?? 0),
          jobsFailed: Number(job?.jobs_failed ?? 0),
          jobsSucceeded7d: Number(job?.jobs_succeeded_7d ?? 0),
          jobsFailed7d: Number(job?.jobs_failed_7d ?? 0),
          jobsActive: Number(job?.jobs_active ?? 0),
          savedAssignmentsCount: Number(assignmentsByOwner.get(user.id) ?? 0),
          standingRulesCount: Number(opinion?.standing_count ?? 0),
          essayOpinionsCount: Number(opinion?.essay_count ?? 0),
          lastReviewActivityAt: isoOrNull(lastReviewMs),
          lastActiveAt: isoOrNull(lastActiveMs),
        },
        recentEvents: eventsByUser.get(user.id) ?? [],
      };
    });

    const summary: AdminAccountsSummary = {
      totalUsers: accounts.length,
      enabledUsers: accounts.filter((item) => item.enabled).length,
      disabledUsers: accounts.filter((item) => !item.enabled).length,
      adminCount: accounts.filter((item) => item.role === "admin").length,
      teacherCount: accounts.filter((item) => item.role === "teacher").length,
      onlineUsers: accounts.filter((item) => item.activityLevel === "online").length,
      activeSessionsTotal: accounts.reduce((sum, item) => sum + item.login.activeSessions, 0),
      activeUsers7d: accounts.filter((item) =>
        item.activityLevel === "online" || item.activityLevel === "today" || item.activityLevel === "active_7d"
      ).length,
      totalReviews: accounts.reduce((sum, item) => sum + item.usage.totalReviews, 0),
      reviews7d: accounts.reduce((sum, item) => sum + item.usage.reviews7d, 0),
      totalJobsSucceeded: accounts.reduce((sum, item) => sum + item.usage.jobsSucceeded, 0),
      totalJobsFailed: accounts.reduce((sum, item) => sum + item.usage.jobsFailed, 0),
      jobsSucceeded7d: accounts.reduce((sum, item) => sum + item.usage.jobsSucceeded7d, 0),
      jobsFailed7d: accounts.reduce((sum, item) => sum + item.usage.jobsFailed7d, 0),
      loginsSucceeded7d: (attemptSummaryRows.results ?? []).reduce((sum, row) => sum + Number(row.succeeded_7d ?? 0), 0),
      loginsFailed7d: (attemptSummaryRows.results ?? []).reduce((sum, row) => sum + Number(row.failed_7d ?? 0), 0),
      rateLimitedUsers: accounts.filter((item) => item.rateLimited).length,
    };

    return {
      currentUserId,
      generatedAt: now.toISOString(),
      summary,
      accounts,
      recentEvents: recentEvents.slice(0, 20),
    };
  }

  async createAccount(input: {
    actor: Pick<AuthenticatedUser, "id" | "username">;
    username: string;
    role: UserRole;
    mustChangePassword: boolean;
    salt: string;
    sealed: SealedPasswordVerifier;
    now?: Date;
  }): Promise<{ id: string; username: string; role: UserRole; mustChangePassword: boolean }> {
    const username = normalizeAccountUsername(input.username);
    if (input.role !== "admin" && input.role !== "teacher") {
      throw new AdminAccountError("VALIDATION_ERROR", "账号角色无效", 400);
    }
    const existing = await this.database.prepare(
      "SELECT id FROM users WHERE lower(username) = ?",
    ).bind(username).first<{ id: string }>();
    if (existing) {
      throw new AdminAccountError("USERNAME_TAKEN", `用户名「${username}」已存在`, 409);
    }
    const nowMs = (input.now ?? new Date()).getTime();
    const userId = crypto.randomUUID();
    await this.database.batch([
      this.database.prepare(`
        INSERT INTO users (id, username, password_hash, role, must_change_password, disabled_at, created_at, updated_at)
        VALUES (?, ?, '!proof-only', ?, ?, NULL, ?, ?)
      `).bind(userId, username, input.role, input.mustChangePassword ? 1 : 0, nowMs, nowMs),
      this.database.prepare(`
        INSERT INTO user_password_proofs (user_id, salt, sealed_verifier, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(userId, input.salt, JSON.stringify(input.sealed), nowMs, nowMs),
      this.database.prepare(`
        INSERT INTO security_events (user_id, event_type, metadata, created_at)
        VALUES (?, 'account_created', ?, ?)
      `).bind(userId, JSON.stringify({ by: input.actor.username, role: input.role, mustChangePassword: input.mustChangePassword }), nowMs),
    ]);
    return {
      id: userId,
      username,
      role: input.role,
      mustChangePassword: input.mustChangePassword,
    };
  }

  async updateAccount(input: {
    actor: Pick<AuthenticatedUser, "id" | "username">;
    targetUserId: string;
    role?: UserRole;
    disabled?: boolean;
    now?: Date;
  }): Promise<void> {
    const target = await this.findTargetUser(input.targetUserId);
    const nextRole = input.role ?? target.role;
    const nextDisabled = input.disabled ?? (target.disabled_at !== null);
    if (nextRole !== "admin" && nextRole !== "teacher") {
      throw new AdminAccountError("VALIDATION_ERROR", "账号角色无效", 400);
    }
    if (target.id === input.actor.id) {
      if (nextDisabled) {
        throw new AdminAccountError("SELF_ACTION_FORBIDDEN", "不能停用当前正在登录的管理员账号", 400);
      }
      if (nextRole !== "admin") {
        throw new AdminAccountError("SELF_ACTION_FORBIDDEN", "不能取消当前登录账号的管理员权限", 400);
      }
    }
    const removingActiveAdmin = target.role === "admin"
      && target.disabled_at === null
      && (nextRole !== "admin" || nextDisabled);
    if (removingActiveAdmin) {
      const enabledAdmins = await this.countEnabledAdmins();
      if (enabledAdmins <= 1) {
        throw new AdminAccountError("LAST_ADMIN_REQUIRED", "系统至少需要保留一个启用中的管理员账号", 400);
      }
    }

    const nowMs = (input.now ?? new Date()).getTime();
    const nextDisabledAt = nextDisabled ? (target.disabled_at ?? nowMs) : null;
    const statements: D1PreparedStatement[] = [
      this.database.prepare(`
        UPDATE users SET role = ?, disabled_at = ?, updated_at = ? WHERE id = ?
      `).bind(nextRole, nextDisabledAt, nowMs, target.id),
    ];

    if (nextDisabled && target.disabled_at === null) {
      statements.push(
        this.database.prepare(`
          UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
        `).bind(nowMs, target.id),
        this.database.prepare(`
          INSERT INTO security_events (user_id, event_type, metadata, created_at)
          VALUES (?, 'account_disabled', ?, ?)
        `).bind(target.id, JSON.stringify({ by: input.actor.username }), nowMs),
      );
    } else if (!nextDisabled && target.disabled_at !== null) {
      statements.push(
        this.database.prepare(`
          INSERT INTO security_events (user_id, event_type, metadata, created_at)
          VALUES (?, 'account_enabled', ?, ?)
        `).bind(target.id, JSON.stringify({ by: input.actor.username }), nowMs),
      );
    }

    if (nextRole !== target.role) {
      statements.push(
        this.database.prepare(`
          INSERT INTO security_events (user_id, event_type, metadata, created_at)
          VALUES (?, 'role_updated', ?, ?)
        `).bind(target.id, JSON.stringify({ by: input.actor.username, from: target.role, to: nextRole }), nowMs),
      );
    }

    await this.database.batch(statements);
  }

  async resetPassword(input: {
    actor: Pick<AuthenticatedUser, "id" | "username">;
    targetUserId: string;
    salt: string;
    sealed: SealedPasswordVerifier;
    mustChangePassword: boolean;
    revokeSessions: boolean;
    keepTokenHash?: string | null;
    now?: Date;
  }): Promise<void> {
    const target = await this.findTargetUser(input.targetUserId);
    const nowMs = (input.now ?? new Date()).getTime();
    const normalizedUsername = target.username.trim().toLowerCase();
    const mustChange = target.id === input.actor.id ? false : input.mustChangePassword;

    const statements: D1PreparedStatement[] = [
      this.database.prepare(`
        UPDATE users SET password_hash = '!proof-only', must_change_password = ?, updated_at = ? WHERE id = ?
      `).bind(mustChange ? 1 : 0, nowMs, target.id),
      this.database.prepare(`
        INSERT INTO user_password_proofs (user_id, salt, sealed_verifier, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          salt = excluded.salt,
          sealed_verifier = excluded.sealed_verifier,
          updated_at = excluded.updated_at
      `).bind(target.id, input.salt, JSON.stringify(input.sealed), nowMs, nowMs),
      this.database.prepare(`
        DELETE FROM login_attempts WHERE normalized_username = ? AND succeeded = 0
      `).bind(normalizedUsername),
      this.database.prepare(`
        INSERT INTO security_events (user_id, event_type, metadata, created_at)
        VALUES (?, 'password_reset', ?, ?)
      `).bind(target.id, JSON.stringify({ by: input.actor.username, mustChangePassword: mustChange }), nowMs),
    ];

    if (input.revokeSessions) {
      if (target.id === input.actor.id && input.keepTokenHash) {
        statements.push(
          this.database.prepare(`
            UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND token_hash <> ?
          `).bind(nowMs, target.id, input.keepTokenHash),
        );
      } else {
        statements.push(
          this.database.prepare(`
            UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
          `).bind(nowMs, target.id),
        );
      }
    }

    await this.database.batch(statements);
  }

  async revokeSessions(input: {
    actor: Pick<AuthenticatedUser, "id" | "username">;
    targetUserId: string;
    keepTokenHash?: string | null;
    now?: Date;
  }): Promise<{ revokedCount: number }> {
    const target = await this.findTargetUser(input.targetUserId);
    const nowMs = (input.now ?? new Date()).getTime();
    const keepCurrent = target.id === input.actor.id && Boolean(input.keepTokenHash);
    const revokeResult = keepCurrent
      ? await this.database.prepare(`
          UPDATE sessions SET revoked_at = ?
          WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? AND token_hash <> ?
        `).bind(nowMs, target.id, nowMs, input.keepTokenHash).run()
      : await this.database.prepare(`
          UPDATE sessions SET revoked_at = ?
          WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
        `).bind(nowMs, target.id, nowMs).run();
    const revokedCount = Number(revokeResult.meta.changes ?? 0);
    await this.database.prepare(`
      INSERT INTO security_events (user_id, event_type, metadata, created_at)
      VALUES (?, 'sessions_revoked', ?, ?)
    `).bind(target.id, JSON.stringify({ by: input.actor.username, revokedCount, keptCurrent: keepCurrent }), nowMs).run();
    return { revokedCount };
  }

  async unlockLoginRateLimit(input: {
    actor: Pick<AuthenticatedUser, "id" | "username">;
    targetUserId: string;
    now?: Date;
  }): Promise<{ clearedCount: number }> {
    const target = await this.findTargetUser(input.targetUserId);
    const nowMs = (input.now ?? new Date()).getTime();
    const normalizedUsername = target.username.trim().toLowerCase();
    const result = await this.database.prepare(`
      DELETE FROM login_attempts WHERE normalized_username = ? AND succeeded = 0
    `).bind(normalizedUsername).run();
    const clearedCount = Number(result.meta.changes ?? 0);
    await this.database.prepare(`
      INSERT INTO security_events (user_id, event_type, metadata, created_at)
      VALUES (?, 'login_unlocked', ?, ?)
    `).bind(target.id, JSON.stringify({ by: input.actor.username, clearedCount }), nowMs).run();
    return { clearedCount };
  }

  private async findTargetUser(userId: string): Promise<{
    id: string;
    username: string;
    role: UserRole;
    disabled_at: number | null;
  }> {
    const row = await this.database.prepare(
      "SELECT id, username, role, disabled_at FROM users WHERE id = ?",
    ).bind(userId).first<{ id: string; username: string; role: UserRole; disabled_at: number | null }>();
    if (!row) {
      throw new AdminAccountError("ACCOUNT_NOT_FOUND", "账号不存在", 404);
    }
    return row;
  }

  private async countEnabledAdmins(): Promise<number> {
    const row = await this.database.prepare(
      "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled_at IS NULL",
    ).first<{ count: number }>();
    return Number(row?.count ?? 0);
  }
}
