/**
 * Cron Guard — smart cron job guardrails with built-in upsell moments.
 *
 * Protects users from accidentally burning credits while encouraging upgrades.
 * Every guardrail moment is also an upsell moment.
 *
 * Components:
 *   1. Frequency warning: crons < 5 min → suppress until user confirms via Telegram
 *   2. Credit projection warning: any cron > 25% of daily limit → warn with upsell
 *   3. No hard limits: users can create unlimited crons at any frequency
 *   4. Circuit breaker: > 50% daily credits from crons before first manual msg → pause all
 */

import { sendTelegramNotification, discoverTelegramChatId } from "@/lib/telegram";
import { logger } from "@/lib/logger";

// --- Constants ---

/** Cron interval below this triggers a frequency warning (milliseconds). */
const FREQUENCY_WARN_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/** If any single cron projects > this fraction of daily limit, warn. */
const PROJECTION_WARN_FRACTION = 0.25; // 25%

/** If total cron usage exceeds this fraction of daily limit before first manual msg, pause. */
const CIRCUIT_BREAKER_FRACTION = 0.50; // 50%

/** Estimated API calls per cron execution (cron trigger + tool continuations). */
const CALLS_PER_CRON_EXECUTION = 2;

/** Default cost weight (MiniMax = 0.2 credits per call). */
const DEFAULT_COST_WEIGHT = 0.2;

/** Tier display limits. */
const TIER_LIMITS: Record<string, number> = {
  starter: 600,
  pro: 1000,
  power: 2500,
  internal: 5000,
};

// --- Types ---

export interface CronJobReport {
  name: string;
  intervalMs: number;
  scheduleExpr?: string;
  enabled: boolean;
}

export interface CronGuardAction {
  name: string;
  action: "suppress" | "warn" | "ok";
  reason?: string;
  projectedDaily?: number;
}

export interface CronGuardResult {
  actions: CronGuardAction[];
  circuitBreakerActive: boolean;
  warnings: string[];
}

// --- Core evaluation ---

/**
 * Evaluate a set of cron jobs against the guardrail rules.
 * Returns actions for each job and any warnings to send.
 */
export function evaluateCronJobs(
  jobs: CronJobReport[],
  tier: string,
  confirmedJobs: Set<string>,
): CronGuardResult {
  const dailyLimit = TIER_LIMITS[tier] ?? 600;
  const actions: CronGuardAction[] = [];
  const warnings: string[] = [];
  let totalProjectedDaily = 0;

  for (const job of jobs) {
    if (!job.enabled) {
      actions.push({ name: job.name, action: "ok", reason: "disabled by user" });
      continue;
    }

    const projectedDaily = projectDailyCredits(job.intervalMs);
    totalProjectedDaily += projectedDaily;

    // Rule 1: Frequency warning for < 5 min intervals
    if (job.intervalMs > 0 && job.intervalMs < FREQUENCY_WARN_THRESHOLD_MS) {
      if (confirmedJobs.has(job.name)) {
        // User already confirmed — allow but still track
        actions.push({
          name: job.name,
          action: "ok",
          reason: "confirmed by user",
          projectedDaily,
        });
      } else {
        actions.push({
          name: job.name,
          action: "suppress",
          reason: `interval ${formatInterval(job.intervalMs)} is under 5 minutes`,
          projectedDaily,
        });
      }
      continue;
    }

    // Rule 2: Credit projection warning for > 25% of daily limit
    if (projectedDaily > dailyLimit * PROJECTION_WARN_FRACTION) {
      actions.push({
        name: job.name,
        action: "warn",
        reason: `projected ${Math.round(projectedDaily)} credits/day (${Math.round((projectedDaily / dailyLimit) * 100)}% of your ${dailyLimit} daily limit)`,
        projectedDaily,
      });
      continue;
    }

    actions.push({ name: job.name, action: "ok", projectedDaily });
  }

  // Aggregate warning if total projection is high
  if (totalProjectedDaily > dailyLimit * PROJECTION_WARN_FRACTION) {
    warnings.push(
      `Your cron jobs are projected to use ~${Math.round(totalProjectedDaily)} credits/day ` +
      `(${Math.round((totalProjectedDaily / dailyLimit) * 100)}% of your ${dailyLimit} daily limit).`
    );
  }

  return { actions, circuitBreakerActive: false, warnings };
}

/**
 * Project how many credits a cron job will consume per day.
 */
export function projectDailyCredits(intervalMs: number): number {
  if (intervalMs <= 0) return 0;
  const executionsPerDay = (24 * 60 * 60 * 1000) / intervalMs;
  return executionsPerDay * CALLS_PER_CRON_EXECUTION * DEFAULT_COST_WEIGHT;
}

/**
 * Check if the credit circuit breaker should fire.
 * Fires when: usage > 50% of daily limit AND no manual message yet today.
 */
export function shouldFireCircuitBreaker(
  currentUsage: number,
  tier: string,
  firstManualAt: string | null,
  cronBreakerFired: boolean,
): boolean {
  if (cronBreakerFired) return false; // Already fired today
  if (firstManualAt) return false; // User has sent a manual message

  const dailyLimit = TIER_LIMITS[tier] ?? 600;
  return currentUsage > dailyLimit * CIRCUIT_BREAKER_FRACTION;
}

// --- Telegram notifications ---

/**
 * Send a frequency warning with upsell when a cron is suppressed.
 */
export async function sendFrequencyWarning(
  botToken: string,
  chatId: string,
  jobName: string,
  intervalMs: number,
  projectedDaily: number,
  tier: string,
): Promise<boolean> {
  const dailyLimit = TIER_LIMITS[tier] ?? 600;
  const pct = Math.round((projectedDaily / dailyLimit) * 100);
  const nextTier = tier === "starter" ? "Pro" : tier === "pro" ? "Power" : null;
  const nextLimit = tier === "starter" ? 1000 : tier === "pro" ? 2500 : null;

  let msg =
    `Heads up! Your cron job "${jobName}" runs every ${formatInterval(intervalMs)}, ` +
    `which would use ~${Math.round(projectedDaily)} of your ${dailyLimit} daily credits (${pct}%).\n\n` +
    `I've paused it to protect your balance. Reply "yes" to enable it anyway.`;

  if (nextTier && nextLimit) {
    msg +=
      `\n\nWant more room? Upgrade to ${nextTier} (${nextLimit} credits/day) at:\nhttps://instaclaw.io/dashboard/billing`;
  }

  return sendTelegramNotification(botToken, chatId, msg);
}

/**
 * Send a credit projection warning with upsell.
 */
export async function sendProjectionWarning(
  botToken: string,
  chatId: string,
  totalProjected: number,
  tier: string,
): Promise<boolean> {
  const dailyLimit = TIER_LIMITS[tier] ?? 600;
  const pct = Math.round((totalProjected / dailyLimit) * 100);
  const nextTier = tier === "starter" ? "Pro" : tier === "pro" ? "Power" : null;
  const nextLimit = tier === "starter" ? 1000 : tier === "pro" ? 2500 : null;

  let msg =
    `Your cron jobs are projected to use ~${Math.round(totalProjected)} credits/day ` +
    `(${pct}% of your ${dailyLimit} daily limit). You may run out before end of day.\n\n` +
    `Tip: Use longer intervals or fewer crons to stretch your credits.`;

  if (nextTier && nextLimit) {
    msg +=
      `\n\nNeed more? Upgrade to ${nextTier} (${nextLimit} credits/day) or grab a credit pack:\nhttps://instaclaw.io/dashboard/billing`;
  }

  return sendTelegramNotification(botToken, chatId, msg);
}

/**
 * Send circuit breaker notification — all crons paused.
 */
export async function sendCircuitBreakerAlert(
  botToken: string,
  chatId: string,
  currentUsage: number,
  tier: string,
): Promise<boolean> {
  const dailyLimit = TIER_LIMITS[tier] ?? 600;
  const pct = Math.round((currentUsage / dailyLimit) * 100);
  const nextTier = tier === "starter" ? "Pro" : tier === "pro" ? "Power" : null;
  const nextLimit = tier === "starter" ? 1000 : tier === "pro" ? 2500 : null;

  let msg =
    `Your cron jobs have used ${Math.round(currentUsage)} credits (${pct}% of your ${dailyLimit} daily limit) ` +
    `and you haven't sent any messages yet today.\n\n` +
    `I've paused all cron jobs to save your remaining credits. ` +
    `Just send me any message and I'll resume them automatically.\n\n` +
    `Want unlimited cron power?`;

  if (nextTier && nextLimit) {
    msg += ` Upgrade to ${nextTier} (${nextLimit} credits/day):\nhttps://instaclaw.io/dashboard/billing`;
  } else {
    msg += ` Grab a credit pack:\nhttps://instaclaw.io/dashboard/billing`;
  }

  return sendTelegramNotification(botToken, chatId, msg);
}

/**
 * Send notification that crons have been resumed after manual message.
 */
export async function sendCronResumedNotification(
  botToken: string,
  chatId: string,
): Promise<boolean> {
  return sendTelegramNotification(
    botToken,
    chatId,
    "Your cron jobs have been resumed. Happy automating!"
  );
}

// --- Helpers ---

function formatInterval(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

/**
 * Resolve Telegram chat_id for a VM, discovering it lazily if needed.
 * Returns { botToken, chatId } or null if notifications can't be sent.
 */
export async function resolveTelegramTarget(
  vm: { telegram_bot_token?: string | null; telegram_chat_id?: string | null; id: string },
  supabase: { from: (table: string) => any },
): Promise<{ botToken: string; chatId: string } | null> {
  if (!vm.telegram_bot_token) return null;

  let chatId = vm.telegram_chat_id;
  if (!chatId) {
    chatId = await discoverTelegramChatId(vm.telegram_bot_token);
    if (chatId) {
      // Cache it
      supabase
        .from("instaclaw_vms")
        .update({ telegram_chat_id: chatId })
        .eq("id", vm.id)
        .then(() => {});
    }
  }

  if (!chatId) return null;
  return { botToken: vm.telegram_bot_token, chatId };
}
