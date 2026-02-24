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

// Opus keyword signals
const OPUS_SIGNALS =
  /\b(important|critical|be thorough|think deeply|synthesize|cross-reference|from scratch|full[- ]?stack|end[- ]?to[- ]?end|redesign|architect|architecture)\b/i;

// Opus: multi-agent / subagent references
const OPUS_MULTI_AGENT =
  /\b(subagent|sub[- ]?agent|multi[- ]?agent)\b|\bcoordinate with .+agents?\b|\bother agents?\b/i;

// Opus: smart contract + deploy combination
const OPUS_SMART_CONTRACT_DEPLOY =
  /\bsmart contract\b[\s\S]*\bdeploy\b|\bdeploy\b[\s\S]*\bsmart contract\b/i;

// Action verbs for multi-action heuristic (3+ distinct = Opus)
const ACTION_VERB_PATTERN =
  /\b(build|create|write|implement|deploy|test|design|integrate|configure|migrate|optimize|develop|monitor|analyze|audit|refactor|rewrite|generate|establish|install|connect|debug|coordinate|research|set up)\b/gi;

// Building/creating verbs for complex build heuristic
const BUILD_VERB_PATTERN =
  /\b(build|create|develop|implement|set up|configure|deploy|architect|design)\b/i;

// Sonnet keyword signals (expanded)
const SONNET_SIGNALS =
  /\b(write code|write (?:a|me a) \w+|implement|debug|refactor|build (?:a|me a|me) \w+|create a \w+|analyze|evaluate|financial|competitive|audit|draft an email|compare|contrast|step[- ]?by[- ]?step|research|design|plan|rewrite|optimize|migrate|generate|develop|set up|configure)\b/i;

const MULTI_STEP_PATTERN = /\b(first\b.*\bthen\b|step \d|1\.|1\))/i;

const CODE_BLOCK_PATTERN = /```[\s\S]{10,}/;

const EXPLICIT_OPUS_PATTERN = /\buse opus\b/i;
const EXPLICIT_SONNET_PATTERN = /\buse sonnet\b/i;
const EXPLICIT_HAIKU_PATTERN = /\buse haiku\b/i;

/**
 * Count distinct action verbs in a message.
 * Used for multi-action complexity detection (3+ = Opus-worthy).
 */
function countDistinctActionVerbs(msg: string): number {
  const matches = msg.match(ACTION_VERB_PATTERN);
  if (!matches) return 0;
  const unique = new Set(matches.map((m) => m.toLowerCase()));
  return unique.size;
}

/**
 * Detect complex build requests: a building verb + 3+ listed components.
 * "Build me a dashboard with auth, DB, and notifications" → true
 */
function hasComplexBuild(msg: string): boolean {
  if (!BUILD_VERB_PATTERN.test(msg)) return false;
  const commaCount = (msg.match(/,/g) || []).length;
  return commaCount >= 2 && msg.length > 80;
}

/**
 * Build an Opus routing decision with budget-aware degradation.
 */
function opusDecision(ctx: RoutingContext, reason: string): RoutingDecision {
  if (ctx.tierBudget.opusRemaining > 0) {
    return { model: TIER_MODELS[3], tier: 3, reason };
  }
  if (ctx.tierBudget.sonnetRemaining > 0) {
    return { model: TIER_MODELS[2], tier: 2, reason: `${reason} but opus budget exhausted, downgraded to sonnet` };
  }
  return { model: TIER_MODELS[1], tier: 1, reason: `${reason} but all budgets exhausted` };
}

/**
 * Deterministic model routing — no LLM calls, no network.
 *
 * Layer 1: Static overrides (heartbeat, recurring, toggles, explicit requests, budget)
 * Layer 2: Content classification (regex/keyword + heuristics on last user message)
 * Default: Haiku (tier 1)
 */
export function routeModel(ctx: RoutingContext): RoutingDecision {
  const msg = ctx.userMessage;

  // ── Layer 1: Static overrides ──────────────────────────────

  if (ctx.isHeartbeat) {
    return { model: "minimax-m2.5", tier: 1, reason: "heartbeat" };
  }

  if (ctx.isRecurringTask) {
    return { model: TIER_MODELS[1], tier: 1, reason: "recurring task" };
  }

  if (EXPLICIT_OPUS_PATTERN.test(msg)) {
    if (ctx.tierBudget.opusRemaining > 0) {
      return { model: TIER_MODELS[3], tier: 3, reason: "explicit opus request" };
    }
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

  if (ctx.explicitModelRequest) {
    return respectExplicitModel(ctx);
  }

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

  // Opus: keyword signals
  if (OPUS_SIGNALS.test(msg)) {
    return opusDecision(ctx, "opus content signal");
  }

  // Opus: multi-agent / subagent references
  if (OPUS_MULTI_AGENT.test(msg)) {
    return opusDecision(ctx, "multi-agent signal");
  }

  // Opus: smart contract + deploy combination
  if (OPUS_SMART_CONTRACT_DEPLOY.test(msg)) {
    return opusDecision(ctx, "smart contract + deploy");
  }

  // Opus: 3+ distinct action verbs (complex multi-step task)
  if (countDistinctActionVerbs(msg) >= 3) {
    return opusDecision(ctx, "multi-action complexity (3+ verbs)");
  }

  // Opus: building verb + 3+ listed components
  if (hasComplexBuild(msg)) {
    return opusDecision(ctx, "complex build (3+ components)");
  }

  // Sonnet signals: code keywords, analysis, email drafting, research
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
