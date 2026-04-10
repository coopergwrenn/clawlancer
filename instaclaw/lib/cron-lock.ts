import { getSupabase } from "./supabase";
import { logger } from "./logger";
import { sendAdminAlertEmail } from "./email";

/**
 * Try to acquire a distributed cron lock.
 *
 * Race-safe pattern (no RPC needed):
 *   1. DELETE the row if expired (cleanup, idempotent)
 *   2. INSERT — fails with 23505 unique_violation if another holder owns it
 *
 * Two concurrent instances both calling this can never both succeed at step 2
 * because the PRIMARY KEY constraint is enforced atomically by Postgres.
 *
 * Returns true if the caller now holds the lock, false otherwise.
 *
 * Always pair with releaseCronLock() in a try/finally block.
 *
 * Error handling:
 *   - 23505 unique_violation = lock held by another instance → return false silently
 *   - 42P01 relation_does_not_exist = lock table missing → ERROR log + admin alert
 *   - All other errors → ERROR log + admin alert (network, permissions, etc.)
 */
export async function tryAcquireCronLock(
  name: string,
  ttlSeconds: number,
  holder = "vercel-cron"
): Promise<boolean> {
  const supabase = getSupabase();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  // Step 1: Clean up expired lock if present (only deletes if expired,
  // so this is safe to run even when an active lock exists).
  const deleteResult = await supabase
    .from("instaclaw_cron_locks")
    .delete()
    .eq("name", name)
    .lt("expires_at", now.toISOString());

  // If the DELETE itself fails with an unexpected error (e.g., table missing),
  // surface that loudly. The INSERT will likely fail too — handled below.
  if (deleteResult.error) {
    logger.error("cron-lock: DELETE failed (unexpected)", {
      name,
      code: deleteResult.error.code,
      error: deleteResult.error.message,
    });
  }

  // Step 2: Atomic insert. PK constraint makes this race-safe.
  const { error } = await supabase.from("instaclaw_cron_locks").insert({
    name,
    acquired_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    holder,
  });

  if (!error) return true;

  // 23505 = unique_violation = another instance holds the lock. Quiet skip.
  if (error.code === "23505") return false;

  // Anything else is a real problem. Log loudly and alert admin.
  await reportLockFailure(name, error.code, error.message);
  return false;
}

/**
 * Release a cron lock by name. Best-effort — no error if missing.
 *
 * Safe to call in a finally block even if acquisition failed.
 */
export async function releaseCronLock(name: string): Promise<void> {
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from("instaclaw_cron_locks")
      .delete()
      .eq("name", name);
    if (error) {
      logger.error("cron-lock: release failed", {
        name,
        code: error.code,
        error: error.message,
      });
    }
  } catch (err) {
    logger.error("cron-lock: release threw", {
      name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Surface a lock failure as both a structured log and an admin email.
 * Distinguishes the "table missing" case (42P01) from other errors so the
 * fix is obvious from the email subject.
 */
async function reportLockFailure(
  name: string,
  code: string | null | undefined,
  message: string
): Promise<void> {
  const isTableMissing = code === "42P01";

  logger.error("cron-lock: acquire failed (unexpected)", {
    name,
    code,
    error: message,
    tableMissing: isTableMissing,
  });

  const subject = isTableMissing
    ? `Cron Lock Table Missing — Migration Required (${name})`
    : `Cron Lock Acquire Failed (${name})`;

  const body = isTableMissing
    ? `tryAcquireCronLock("${name}") failed because the instaclaw_cron_locks table does not exist.\n\n` +
      `The migration 20260410_cron_locks.sql has NOT been applied.\n\n` +
      `Until this is fixed, the "${name}" cron will skip every run silently.\n\n` +
      `Code: ${code}\nMessage: ${message}`
    : `tryAcquireCronLock("${name}") failed with an unexpected database error.\n\n` +
      `Code: ${code}\nMessage: ${message}\n\n` +
      `The "${name}" cron is currently SKIPPING runs. Investigate Supabase health.`;

  // Don't await — if email fails, we don't want to compound the failure.
  // Errors during the email send are swallowed; logger.error above is the
  // durable record.
  sendAdminAlertEmail(subject, body).catch((err) => {
    logger.error("cron-lock: admin alert send failed", {
      name,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
