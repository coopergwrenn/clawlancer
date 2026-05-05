/**
 * Watchdog v2 — state machine + audit helpers
 *
 * Spec: instaclaw/docs/watchdog-v2-and-wake-reconciler-design.md
 *
 * Design principles internalized from this sprint's incidents:
 *   1. Conservative bias — false negative (miss broken VM for 15 more min)
 *      is vastly cheaper than false positive (restart healthy VM mid-convo).
 *   2. Time-based threshold + counter — never act on a single failure or
 *      a counter alone. Both must clear (Lesson 1: old watchdog had counter
 *      only, no time gate, restarted healthy VMs every ~6 min).
 *   3. Stateless cron — every state input lives in DB, not in-memory.
 *   4. Privacy-mode aware — query instaclaw_users.privacy_mode_until > NOW()
 *      directly; one source of truth (Cooper's edge-privacy migration
 *      20260501_privacy_mode.sql).
 *   5. Heartbeats are NOT user activity — use last_user_activity_at, not
 *      last_proxy_call_at (Lesson 6).
 *   6. ALWAYS log every action to instaclaw_watchdog_audit so we can audit
 *      what the watchdog did and why, especially in shadow mode.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

// ─── Constants ─────────────────────────────────────────────────────────────
// All thresholds tuned per Cooper's spec. Adjust here, not inline at call sites.

export const WATCHDOG_CONSECUTIVE_FAILURE_THRESHOLD = 3;
export const WATCHDOG_TIME_THRESHOLD_MS = 15 * 60_000;       // 15 min: time elapsed since first failure before restart eligible
export const WATCHDOG_COOLDOWN_MS = 20 * 60_000;             // 20 min: between restart attempts on same VM
export const WATCHDOG_QUARANTINE_RESTARTS_24H = 3;           // 24h rolling window restart attempts before quarantine
export const WATCHDOG_ACTIVE_USER_PROTECT_MS = 5 * 60_000;   // 5 min: don't disrupt active users
export const WATCHDOG_GLOBAL_ANOMALY_RATIO = 0.5;            // >50% of VMs failing → assume network anomaly, halt
export const WATCHDOG_PROBE_TIMEOUT_MS = 10_000;             // 10s HTTPS probe budget

// ─── Derived state (computed, NOT stored) ──────────────────────────────────

export type DerivedState =
  | "SLEEPING"          // health_status IN (hibernating, suspended, frozen) — not watchdog's job
  | "QUARANTINED"       // 3+ failed restarts in 24h — manual intervention required
  | "RESTART_COOLDOWN"  // last restart < 20 min ago
  | "HEALTHY"           // counter == 0
  | "DEGRADED"          // counter < 3 OR (counter ≥ 3 AND time elapsed < 15 min)
  | "UNHEALTHY";        // counter ≥ 3 AND time elapsed ≥ 15 min

export interface VMWatchdogInputs {
  health_status: string | null;
  watchdog_consecutive_failures: number | null;
  watchdog_first_failure_at: string | null;
  watchdog_last_restart_at: string | null;
  watchdog_restart_attempts_24h: number | null;
  watchdog_restart_attempts_24h_window_start: string | null;
  watchdog_quarantined_at: string | null;
}

export function deriveState(vm: VMWatchdogInputs, now = Date.now()): DerivedState {
  if (
    vm.health_status === "hibernating" ||
    vm.health_status === "suspended" ||
    vm.health_status === "frozen"
  ) {
    return "SLEEPING";
  }

  if (vm.watchdog_quarantined_at) return "QUARANTINED";

  const lastRestart = vm.watchdog_last_restart_at ? new Date(vm.watchdog_last_restart_at).getTime() : null;
  if (lastRestart && now - lastRestart < WATCHDOG_COOLDOWN_MS) return "RESTART_COOLDOWN";

  const failures = vm.watchdog_consecutive_failures ?? 0;
  if (failures === 0) return "HEALTHY";

  if (failures < WATCHDOG_CONSECUTIVE_FAILURE_THRESHOLD) return "DEGRADED";

  const firstFailure = vm.watchdog_first_failure_at ? new Date(vm.watchdog_first_failure_at).getTime() : null;
  if (!firstFailure || now - firstFailure < WATCHDOG_TIME_THRESHOLD_MS) return "DEGRADED";

  return "UNHEALTHY";
}

// ─── Privacy mode (Cooper's edge-privacy migration) ────────────────────────

/**
 * Reads instaclaw_users.privacy_mode_until — the column added by Cooper's
 * 20260501_privacy_mode.sql migration. There is exactly ONE source of truth
 * for privacy mode and this is it.
 *
 * Active when privacy_mode_until > NOW(). Same logic as the SSH-bridge
 * endpoint (app/api/internal/check-privacy-mode/route.ts).
 *
 * Returns false if the user can't be found OR there's an error — the
 * watchdog should never escalate restrictions due to a lookup failure.
 */
export async function isPrivacyModeActive(
  supabase: SupabaseClient,
  userId: string | null,
  now = Date.now(),
): Promise<{ active: boolean; until: string | null }> {
  if (!userId) return { active: false, until: null };
  const { data: user, error } = await supabase
    .from("instaclaw_users")
    .select("privacy_mode_until")
    .eq("id", userId)
    .single();
  if (error || !user) return { active: false, until: null };
  const until = user.privacy_mode_until as string | null;
  if (!until) return { active: false, until: null };
  const active = new Date(until).getTime() > now;
  return { active, until: active ? until : null };
}

// ─── Audit trail ───────────────────────────────────────────────────────────
// Keep this enum in sync with the CHECK constraint in the migration.
//
// "probe_healthy" was REMOVED from the union on 2026-05-05 (the day before
// Consensus 2026 launch) after diagnosis showed it was 96% of all writes
// at 1.8K/hour with zero forensic value (no state transition, no action
// taken). The DB CHECK constraint still permits the value — historical
// rows pre-prune may have it — but no code path in this repo should
// emit a new one. If you find yourself wanting to re-add a no-op
// "probe was OK" audit row, read app/api/cron/watchdog/route.ts:212
// first; the rationale for never doing this again is in that comment.

export type WatchdogAction =
  | "probe_failed"
  | "restart_attempted"
  | "restart_succeeded"
  | "restart_failed"
  | "restart_skipped_active_user"
  | "restart_skipped_cooldown"
  | "restart_skipped_quarantined"
  | "restart_skipped_unowned"
  | "restart_skipped_global_anomaly"
  | "restart_skipped_billing_unverified"
  | "restart_skipped_shadow_mode"
  | "inspection_skipped_privacy_mode"
  | "reset_after_recovery"
  | "quarantined"
  | "wake_reconciler_attempted"
  | "wake_reconciler_succeeded"
  | "wake_reconciler_failed"
  | "wake_reconciler_skipped_not_paying"
  | "wake_reconciler_halted_ssh_failure";

export interface AuditRow {
  vm_id: string;
  user_id: string | null;
  action: WatchdogAction;
  prior_state: string;
  new_state: string;
  reason?: string;
  consecutive_failures?: number;
  meta?: Record<string, unknown>;
}

export async function writeAudit(supabase: SupabaseClient, row: AuditRow): Promise<void> {
  const { error } = await supabase.from("instaclaw_watchdog_audit").insert({
    vm_id: row.vm_id,
    user_id: row.user_id,
    action: row.action,
    prior_state: row.prior_state,
    new_state: row.new_state,
    reason: row.reason ?? null,
    consecutive_failures: row.consecutive_failures ?? null,
    meta: row.meta ?? {},
  });
  if (error) {
    // Never throw — audit-log failures are real but must not affect the
    // watchdog's primary action. Log to console + structured logger.
    console.error("watchdog: audit insert failed", { error: error.message, row });
  }
}

// ─── HTTPS probe (privacy-safe by default) ─────────────────────────────────

/**
 * Hit the VM's gateway /health endpoint over public HTTPS. NOT SSH.
 *
 * Why not SSH:
 *   1. Privacy-safe — no file-system access, no journalctl, no auth-profiles.
 *   2. Faster — no TCP handshake / key auth overhead.
 *   3. No SSH key dependency — works even if SSH access is broken but the
 *      gateway is still serving (rare but real failure mode).
 *
 * Returns:
 *   - { ok: true }  if HTTP 200 + JSON body that looks healthy
 *   - { ok: false } otherwise (timeout, non-200, parse failure, network)
 *
 * 10s timeout via AbortController so a stuck VM can't block the cron.
 */
export async function probeGatewayHealth(gatewayUrl: string): Promise<{ ok: boolean; httpCode?: number; reason?: string; latencyMs: number }> {
  const start = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WATCHDOG_PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(`${gatewayUrl.replace(/\/$/, "")}/health`, {
      signal: ac.signal,
      // Safety: never send caller credentials. /health is public.
      headers: { "User-Agent": "instaclaw-watchdog-v2" },
    });
    const latencyMs = Date.now() - start;
    if (!resp.ok) return { ok: false, httpCode: resp.status, reason: `http_${resp.status}`, latencyMs };
    // Don't require a specific JSON body shape — gateway versions differ.
    // 200 means systemd is up and the HTTP server is bound. That's enough.
    return { ok: true, httpCode: resp.status, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const reason = err instanceof Error
      ? (err.name === "AbortError" ? "timeout" : err.message.slice(0, 100))
      : String(err).slice(0, 100);
    return { ok: false, reason, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

// ─── 24-hour window helpers ────────────────────────────────────────────────
// Restart-attempt counter rolls over at the 24h mark — track the window start
// alongside the count so we can reset cleanly.

export function shouldResetRestartWindow(windowStart: string | null, now = Date.now()): boolean {
  if (!windowStart) return true;
  return now - new Date(windowStart).getTime() >= 24 * 60 * 60_000;
}
