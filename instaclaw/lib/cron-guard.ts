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
import { TIER_DISPLAY_LIMITS, getModelCostWeight } from "@/lib/credit-constants";

// --- Constants ---

/** Cron interval below this triggers a frequency warning (milliseconds). */
const FREQUENCY_WARN_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/** If any single cron projects > this fraction of daily limit, warn. */
const PROJECTION_WARN_FRACTION = 0.25; // 25%

/** If total cron usage exceeds this fraction of daily limit before first manual msg, pause. */
const CIRCUIT_BREAKER_FRACTION = 0.50; // 50%

/** Estimated API calls per cron execution (cron trigger + tool continuations). */
const CALLS_PER_CRON_EXECUTION = 2;

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
 * @param defaultModel - VM's default model (e.g. "claude-sonnet-4-6") for accurate cost projection
 */
export function evaluateCronJobs(
  jobs: CronJobReport[],
  tier: string,
  confirmedJobs: Set<string>,
  defaultModel: string = "minimax-m2.5",
): CronGuardResult {
  const dailyLimit = TIER_DISPLAY_LIMITS[tier] ?? 600;
  const costWeight = getModelCostWeight(defaultModel);
  const actions: CronGuardAction[] = [];
  const warnings: string[] = [];
  let totalProjectedDaily = 0;

  for (const job of jobs) {
    if (!job.enabled) {
      actions.push({ name: job.name, action: "ok", reason: "disabled by user" });
      continue;
    }

    const projectedDaily = projectDailyCredits(job.intervalMs, costWeight);
    totalProjectedDaily += projectedDaily;

    // Rule 1: Frequency warning for < 5 min intervals
    if (job.intervalMs > 0 && job.intervalMs < FREQUENCY_WARN_THRESHOLD_MS) {
      if (confirmedJobs.has(job.name)) {
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
 * @param costWeight - per-call cost weight for the VM's default model
 */
export function projectDailyCredits(intervalMs: number, costWeight: number = 0.2): number {
  if (intervalMs <= 0) return 0;
  const executionsPerDay = (24 * 60 * 60 * 1000) / intervalMs;
  return executionsPerDay * CALLS_PER_CRON_EXECUTION * costWeight;
}

/**
 * Check if the credit circuit breaker should fire.
 */
export function shouldFireCircuitBreaker(
  currentUsage: number,
  tier: string,
  firstManualAt: string | null,
  cronBreakerFired: boolean,
): boolean {
  if (cronBreakerFired) return false;
  if (firstManualAt) return false;

  const dailyLimit = TIER_DISPLAY_LIMITS[tier] ?? 600;
  return currentUsage > dailyLimit * CIRCUIT_BREAKER_FRACTION;
}

// --- HMAC token for confirmation links ---

/**
 * Generate an HMAC-based confirmation token for a cron job.
 * Used in clickable Telegram links so users can confirm suppressed crons.
 */
export function generateConfirmToken(vmId: string, jobName: string, secret: string): string {
  // Simple HMAC: base64(sha256(vmId:jobName:secret))[:32]
  const crypto = require("crypto");
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(`${vmId}:${jobName}`);
  return hmac.digest("base64url").slice(0, 32);
}

/**
 * Verify a confirmation token.
 */
export function verifyConfirmToken(
  vmId: string,
  jobName: string,
  token: string,
  secret: string,
): boolean {
  const expected = generateConfirmToken(vmId, jobName, secret);
  // Constant-time comparison
  const crypto = require("crypto");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(token),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

// --- Telegram notifications ---

/**
 * Send a frequency warning with upsell when a cron is suppressed.
 * Includes a clickable confirmation link.
 */
export async function sendFrequencyWarning(
  botToken: string,
  chatId: string,
  jobName: string,
  intervalMs: number,
  projectedDaily: number,
  tier: string,
  confirmUrl?: string,
): Promise<boolean> {
  const dailyLimit = TIER_DISPLAY_LIMITS[tier] ?? 600;
  const pct = Math.round((projectedDaily / dailyLimit) * 100);
  const nextTier = tier === "starter" ? "Pro" : tier === "pro" ? "Power" : null;
  const nextLimit = tier === "starter" ? 1000 : tier === "pro" ? 2500 : null;

  let msg =
    `Heads up! Your cron job "${jobName}" runs every ${formatInterval(intervalMs)}, ` +
    `which would use ~${Math.round(projectedDaily)} of your ${dailyLimit} daily credits (${pct}%).` +
    `\n\nI've paused it to protect your balance.`;

  if (confirmUrl) {
    msg += `\n\nTap here to enable it anyway:\n${confirmUrl}`;
  } else {
    msg += `\n\nReply "yes" to enable it anyway.`;
  }

  if (nextTier && nextLimit) {
    msg +=
      `\n\nWant more room? Upgrade to ${nextTier} (${nextLimit} credits/day):\nhttps://instaclaw.io/dashboard/billing`;
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
  const dailyLimit = TIER_DISPLAY_LIMITS[tier] ?? 600;
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
  const dailyLimit = TIER_DISPLAY_LIMITS[tier] ?? 600;
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
      supabase
        .from("instaclaw_vms")
        .update({ telegram_chat_id: chatId })
        .eq("id", vm.id)
        .then(() => {})
        .catch(() => {});
    }
  }

  if (!chatId) return null;
  return { botToken: vm.telegram_bot_token, chatId };
}
