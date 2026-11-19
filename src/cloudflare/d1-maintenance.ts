export const EMPTY_DRAFT_TTL_MS = 24 * 60 * 60_000;
export const EXPIRED_SESSION_RETENTION_MS = 24 * 60 * 60_000;
export const CONSUMED_CHALLENGE_RETENTION_MS = 60 * 60_000;

export interface CloudMaintenanceResult {
  emptyDraftsDeleted: number;
  loginChallengesDeleted: number;
  sessionsDeleted: number;
}

/**
 * Periodic D1 housekeeping:
 * - Removes empty drafts untouched for >= 24h (never touching reviews with images, OCR, reports, or active jobs).
 * - Removes expired or stale consumed login challenges.
 * - Removes expired or long-revoked sessions.
 */
export async function runCloudMaintenance(
  database: D1Database,
  now = Date.now(),
): Promise<CloudMaintenanceResult> {
  const draftCutoff = now - EMPTY_DRAFT_TTL_MS;
  const consumedChallengeCutoff = now - CONSUMED_CHALLENGE_RETENTION_MS;
  const sessionCutoff = now - EXPIRED_SESSION_RETENTION_MS;

  const [drafts, challenges, sessions] = await database.batch([
    database.prepare(`
      DELETE FROM reviews
      WHERE status = 'draft'
        AND deleting_at IS NULL
        AND report IS NULL
        AND ocr_checkpoint IS NULL
        AND created_at <= ?
        AND updated_at <= ?
        AND NOT EXISTS (SELECT 1 FROM review_images WHERE review_images.review_id = reviews.id)
        AND NOT EXISTS (
          SELECT 1 FROM analysis_jobs
          WHERE analysis_jobs.review_id = reviews.id AND analysis_jobs.status IN ('queued', 'running')
        )
    `).bind(draftCutoff, draftCutoff),
    database.prepare(`
      DELETE FROM login_challenges
      WHERE expires_at <= ? OR (consumed_at IS NOT NULL AND consumed_at <= ?)
    `).bind(now, consumedChallengeCutoff),
    database.prepare(`
      DELETE FROM sessions
      WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)
    `).bind(sessionCutoff, sessionCutoff),
  ]);

  return {
    emptyDraftsDeleted: drafts?.meta.changes ?? 0,
    loginChallengesDeleted: challenges?.meta.changes ?? 0,
    sessionsDeleted: sessions?.meta.changes ?? 0,
  };
}
