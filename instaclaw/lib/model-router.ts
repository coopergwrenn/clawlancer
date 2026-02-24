/**
 * Intelligent model routing — picks the right model tier for each request.
 *
 * Pure-function module. No DB calls, no side effects, <1ms execution.
 * If this module throws, callers fall back to the VM's default model.
 */

import { TIER_MODELS, TIER_BUDGET_LIMITS } from "@/lib/models";

export interface RoutingContext {
  userMessage: string;
  messageCount: number;
  systemPrompt: string;
  isHeartbeat: boolean;
  isTaskExecution: boolean;
  isRecurringTask: boolean;
  toggles: { deepResearch?: boolean; webSearch?: boolean };
  tierBudget: { sonnetRemaining: number; opusRemaining: number };
  explicitModelRequest?: string;
}

export interface RoutingDecision {
  model: string;
  tier: 1 | 2 | 3;
  reason: string;
  retryOnFailure?: string;
}

/* ── Regex patterns for content classification ─────────────── */

const OPUS_SIGNALS = /\b(important|critical|be thorough|think deeply|synthesize|cross-reference)\b/i;

const SONNET_SIGNALS =
  /\b(write code|implement|debug|refactor|build a|create a script|analyze|evaluate|financial|competitive|audit|draft an email|write a response|write a report|compare|contrast|step[- ]?by[- ]?step)\b/i;

const MULTI_STEP_PATTERN = /\b(first\b.*\bthen\b|step \d|1\.|1\))/i;

const CODE_BLOCK_PATTERN = /```[\s\S]{10,}/;

const EXPLICIT_OPUS_PATTERN = /\buse opus\b/i;
const EXPLICIT_SONNET_PATTERN = /\buse sonnet\b/i;
const EXPLICIT_HAIKU_PATTERN = /\buse haiku\b/i;

/**
 * Deterministic model routing — no LLM calls, no network.
 *
 * Layer 1: Static overrides (heartbeat, recurring, toggles, explicit requests, budget)
 * Layer 2: Content classification (regex/keyword on last user message)
 * Default: Haiku (tier 1)
 */
export function routeModel(ctx: RoutingContext): RoutingDecision {
  const msg = ctx.userMessage;

  // ── Layer 1: Static overrides ──────────────────────────────

  // Heartbeats always use MiniMax (keep existing behavior)
  if (ctx.isHeartbeat) {
    return { model: "minimax-m2.5", tier: 1, reason: "heartbeat" };
  }

  // Recurring tasks are cost-sensitive and repeatable
  if (ctx.isRecurringTask) {
    return { model: TIER_MODELS[1], tier: 1, reason: "recurring task" };
  }

  // Explicit user model request in message text
  if (EXPLICIT_OPUS_PATTERN.test(msg)) {
    if (ctx.tierBudget.opusRemaining > 0) {
      return { model: TIER_MODELS[3], tier: 3, reason: "explicit opus request" };
    }
    // Budget exhausted — downgrade
    if (ctx.tierBudget.sonnetRemaining > 0) {
      return { model: TIER_MODELS[2], tier: 2, reason: "opus requested but budget exhausted, downgraded to sonnet" };
    }
    return { model: TIER_MODELS[1], tier: 1, reason: "opus requested but all budgets exhausted, downgraded to haiku" };
  }

  if (EXPLICIT_SONNET_PATTERN.test(msg)) {
    if (ctx.tierBudget.sonnetRemaining > 0) {
      return { model: TIER_MODELS[2], tier: 2, reason: "explicit sonnet request" };
    }
    return { model: TIER_MODELS[1], tier: 1, reason: "sonnet requested but budget exhausted, downgraded to haiku" };
  }

  if (EXPLICIT_HAIKU_PATTERN.test(msg)) {
    return { model: TIER_MODELS[1], tier: 1, reason: "explicit haiku request" };
  }

  // If user/config set a specific model, respect it
  if (ctx.explicitModelRequest) {
    return respectExplicitModel(ctx);
  }

  // Deep Research toggle → Sonnet
  if (ctx.toggles.deepResearch) {
    if (ctx.tierBudget.sonnetRemaining > 0) {
      return {
        model: TIER_MODELS[2],
        tier: 2,
        reason: "deep research toggle",
        retryOnFailure: ctx.tierBudget.opusRemaining > 0 ? TIER_MODELS[3] : undefined,
      };
    }
    return { model: TIER_MODELS[1], tier: 1, reason: "deep research toggle but sonnet budget exhausted" };
  }

  // Task execution → Sonnet (tasks are multi-step by nature)
  if (ctx.isTaskExecution) {
    if (ctx.tierBudget.sonnetRemaining > 0) {
      return {
        model: TIER_MODELS[2],
        tier: 2,
        reason: "task execution",
        retryOnFailure: ctx.tierBudget.opusRemaining > 0 ? TIER_MODELS[3] : undefined,
      };
    }
    return { model: TIER_MODELS[1], tier: 1, reason: "task execution but sonnet budget exhausted" };
  }

  // ── Layer 2: Content classification ────────────────────────

  // Opus signals
  if (OPUS_SIGNALS.test(msg)) {
    if (ctx.tierBudget.opusRemaining > 0) {
      return { model: TIER_MODELS[3], tier: 3, reason: "opus content signal" };
    }
    if (ctx.tierBudget.sonnetRemaining > 0) {
      return { model: TIER_MODELS[2], tier: 2, reason: "opus signal but budget exhausted, downgraded to sonnet" };
    }
    return { model: TIER_MODELS[1], tier: 1, reason: "opus signal but all budgets exhausted" };
  }

  // Sonnet signals: code keywords, analysis, email drafting
  if (SONNET_SIGNALS.test(msg) || MULTI_STEP_PATTERN.test(msg) || CODE_BLOCK_PATTERN.test(msg)) {
    if (ctx.tierBudget.sonnetRemaining > 0) {
      return {
        model: TIER_MODELS[2],
        tier: 2,
        reason: "sonnet content signal",
        retryOnFailure: ctx.tierBudget.opusRemaining > 0 ? TIER_MODELS[3] : undefined,
      };
    }
    return { model: TIER_MODELS[1], tier: 1, reason: "sonnet signal but budget exhausted" };
  }

  // Long messages (>500 chars) likely need deeper processing
  if (msg.length > 500) {
    if (ctx.tierBudget.sonnetRemaining > 0) {
      return {
        model: TIER_MODELS[2],
        tier: 2,
        reason: "long message (>500 chars)",
        retryOnFailure: ctx.tierBudget.opusRemaining > 0 ? TIER_MODELS[3] : undefined,
      };
    }
    return { model: TIER_MODELS[1], tier: 1, reason: "long message but sonnet budget exhausted" };
  }

  // ── Default: Haiku ─────────────────────────────────────────

  return { model: TIER_MODELS[1], tier: 1, reason: "default/haiku" };
}

/**
 * When an explicit model was set via config, enforce budget constraints.
 */
function respectExplicitModel(ctx: RoutingContext): RoutingDecision {
  const m = ctx.explicitModelRequest!.toLowerCase();

  if (m.includes("opus")) {
    if (ctx.tierBudget.opusRemaining > 0) {
      return { model: ctx.explicitModelRequest!, tier: 3, reason: "explicit config model (opus)" };
    }
    if (ctx.tierBudget.sonnetRemaining > 0) {
      return { model: TIER_MODELS[2], tier: 2, reason: "explicit opus config but budget exhausted" };
    }
    return { model: TIER_MODELS[1], tier: 1, reason: "explicit opus config but all budgets exhausted" };
  }

  if (m.includes("sonnet")) {
    if (ctx.tierBudget.sonnetRemaining > 0) {
      return { model: ctx.explicitModelRequest!, tier: 2, reason: "explicit config model (sonnet)" };
    }
    return { model: TIER_MODELS[1], tier: 1, reason: "explicit sonnet config but budget exhausted" };
  }

  // Haiku, MiniMax, or unknown — pass through at tier 1
  return { model: ctx.explicitModelRequest!, tier: 1, reason: "explicit config model (tier 1)" };
}

/**
 * Extract the last user message text from an Anthropic messages array.
 * Handles both string content and content block arrays.
 */
export function extractLastUserMessage(
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      const content = messages[i].content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .filter((b) => b.type === "text" && b.text)
          .map((b) => b.text!)
          .join("");
      }
    }
  }
  return "";
}

/**
 * Compute remaining tier budget from current usage.
 */
export function computeTierBudget(
  tier: string,
  tierUsage: { tier_2_calls: number; tier_3_calls: number } | null
): { sonnetRemaining: number; opusRemaining: number } {
  const limits = TIER_BUDGET_LIMITS[tier as keyof typeof TIER_BUDGET_LIMITS] ?? TIER_BUDGET_LIMITS.starter;
  const used2 = tierUsage?.tier_2_calls ?? 0;
  const used3 = tierUsage?.tier_3_calls ?? 0;
  return {
    sonnetRemaining: Math.max(0, limits.sonnet - used2),
    opusRemaining: Math.max(0, limits.opus - used3),
  };
}
