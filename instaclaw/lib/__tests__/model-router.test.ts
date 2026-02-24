/**
 * Unit tests for model-router.ts
 *
 * Run: npx tsx instaclaw/lib/__tests__/model-router.test.ts
 *
 * Self-contained — no test framework required. Uses simple assertions
 * and exits with non-zero on failure.
 */

// Inline the types and functions to avoid @/ path alias issues in standalone execution.
// In a real test framework with tsconfig paths, you'd import directly.

interface RoutingContext {
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

interface RoutingDecision {
  model: string;
  tier: 1 | 2 | 3;
  reason: string;
  retryOnFailure?: string;
}

// ── Copied from model-router.ts for standalone execution ──

const TIER_MODELS = {
  1: "claude-haiku-4-5-20251001",
  2: "claude-sonnet-4-5-20250929",
  3: "claude-opus-4-6",
} as const;

const OPUS_SIGNALS = /\b(important|critical|be thorough|think deeply|synthesize|cross-reference)\b/i;
const SONNET_SIGNALS =
  /\b(write code|implement|debug|refactor|build a|create a script|analyze|evaluate|financial|competitive|audit|draft an email|write a response|write a report|compare|contrast|step[- ]?by[- ]?step)\b/i;
const MULTI_STEP_PATTERN = /\b(first\b.*\bthen\b|step \d|1\.|1\))/i;
const CODE_BLOCK_PATTERN = /```[\s\S]{10,}/;
const EXPLICIT_OPUS_PATTERN = /\buse opus\b/i;
const EXPLICIT_SONNET_PATTERN = /\buse sonnet\b/i;
const EXPLICIT_HAIKU_PATTERN = /\buse haiku\b/i;

function routeModel(ctx: RoutingContext): RoutingDecision {
  const msg = ctx.userMessage;
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
        model: TIER_MODELS[2], tier: 2, reason: "deep research toggle",
        retryOnFailure: ctx.tierBudget.opusRemaining > 0 ? TIER_MODELS[3] : undefined,
      };
    }
    return { model: TIER_MODELS[1], tier: 1, reason: "deep research toggle but sonnet budget exhausted" };
  }
  if (ctx.isTaskExecution) {
    if (ctx.tierBudget.sonnetRemaining > 0) {
      return {
        model: TIER_MODELS[2], tier: 2, reason: "task execution",
        retryOnFailure: ctx.tierBudget.opusRemaining > 0 ? TIER_MODELS[3] : undefined,
      };
    }
    return { model: TIER_MODELS[1], tier: 1, reason: "task execution but sonnet budget exhausted" };
  }
  if (OPUS_SIGNALS.test(msg)) {
    if (ctx.tierBudget.opusRemaining > 0) {
      return { model: TIER_MODELS[3], tier: 3, reason: "opus content signal" };
    }
    if (ctx.tierBudget.sonnetRemaining > 0) {
      return { model: TIER_MODELS[2], tier: 2, reason: "opus signal but budget exhausted, downgraded to sonnet" };
    }
    return { model: TIER_MODELS[1], tier: 1, reason: "opus signal but all budgets exhausted" };
  }
  if (SONNET_SIGNALS.test(msg) || MULTI_STEP_PATTERN.test(msg) || CODE_BLOCK_PATTERN.test(msg)) {
    if (ctx.tierBudget.sonnetRemaining > 0) {
      return {
        model: TIER_MODELS[2], tier: 2, reason: "sonnet content signal",
        retryOnFailure: ctx.tierBudget.opusRemaining > 0 ? TIER_MODELS[3] : undefined,
      };
    }
    return { model: TIER_MODELS[1], tier: 1, reason: "sonnet signal but budget exhausted" };
  }
  if (msg.length > 500) {
    if (ctx.tierBudget.sonnetRemaining > 0) {
      return {
        model: TIER_MODELS[2], tier: 2, reason: "long message (>500 chars)",
        retryOnFailure: ctx.tierBudget.opusRemaining > 0 ? TIER_MODELS[3] : undefined,
      };
    }
    return { model: TIER_MODELS[1], tier: 1, reason: "long message but sonnet budget exhausted" };
  }
  return { model: TIER_MODELS[1], tier: 1, reason: "default/haiku" };
}

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

// ── Test helpers ─────────────────────────────────────────────

const DEFAULT_BUDGET = { sonnetRemaining: 30, opusRemaining: 5 };
const EXHAUSTED_BUDGET = { sonnetRemaining: 0, opusRemaining: 0 };

function makeCtx(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    userMessage: "hello",
    messageCount: 1,
    systemPrompt: "",
    isHeartbeat: false,
    isTaskExecution: false,
    isRecurringTask: false,
    toggles: {},
    tierBudget: DEFAULT_BUDGET,
    ...overrides,
  };
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${name}`);
  } else {
    failed++;
    console.error(`  FAIL: ${name}`);
  }
}

function assertEq(actual: unknown, expected: unknown, name: string) {
  const pass = actual === expected;
  if (pass) {
    passed++;
    console.log(`  PASS: ${name}`);
  } else {
    failed++;
    console.error(`  FAIL: ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── Tests ────────────────────────────────────────────────────

console.log("\n=== Layer 1: Static Overrides ===\n");

// Heartbeat
{
  const d = routeModel(makeCtx({ isHeartbeat: true }));
  assertEq(d.model, "minimax-m2.5", "heartbeat → MiniMax");
  assertEq(d.tier, 1, "heartbeat → tier 1");
}

// Recurring task
{
  const d = routeModel(makeCtx({ isRecurringTask: true }));
  assertEq(d.model, TIER_MODELS[1], "recurring → Haiku");
  assertEq(d.reason, "recurring task", "recurring → correct reason");
}

// Explicit "use opus" in message
{
  const d = routeModel(makeCtx({ userMessage: "Please use opus for this" }));
  assertEq(d.tier, 3, "explicit 'use opus' → tier 3");
  assertEq(d.model, TIER_MODELS[3], "explicit 'use opus' → Opus model");
}

// Explicit "use opus" but budget exhausted
{
  const d = routeModel(makeCtx({
    userMessage: "use opus please",
    tierBudget: { sonnetRemaining: 10, opusRemaining: 0 },
  }));
  assertEq(d.tier, 2, "explicit opus, budget exhausted → downgrade to tier 2");
}

// Explicit "use opus" all budgets exhausted
{
  const d = routeModel(makeCtx({
    userMessage: "use opus for this",
    tierBudget: EXHAUSTED_BUDGET,
  }));
  assertEq(d.tier, 1, "explicit opus, all exhausted → tier 1");
}

// Explicit "use sonnet"
{
  const d = routeModel(makeCtx({ userMessage: "use sonnet to help" }));
  assertEq(d.tier, 2, "explicit 'use sonnet' → tier 2");
}

// Explicit "use sonnet" budget exhausted
{
  const d = routeModel(makeCtx({
    userMessage: "use sonnet",
    tierBudget: { sonnetRemaining: 0, opusRemaining: 5 },
  }));
  assertEq(d.tier, 1, "explicit sonnet exhausted → tier 1");
}

// Explicit "use haiku"
{
  const d = routeModel(makeCtx({ userMessage: "just use haiku for this" }));
  assertEq(d.tier, 1, "explicit 'use haiku' → tier 1");
}

// Deep Research toggle
{
  const d = routeModel(makeCtx({ toggles: { deepResearch: true } }));
  assertEq(d.tier, 2, "deep research toggle → tier 2");
  assert(d.retryOnFailure === TIER_MODELS[3], "deep research has Opus retry");
}

// Deep Research toggle but sonnet exhausted
{
  const d = routeModel(makeCtx({
    toggles: { deepResearch: true },
    tierBudget: { sonnetRemaining: 0, opusRemaining: 5 },
  }));
  assertEq(d.tier, 1, "deep research, sonnet exhausted → tier 1");
}

// Task execution
{
  const d = routeModel(makeCtx({ isTaskExecution: true }));
  assertEq(d.tier, 2, "task execution → tier 2");
  assertEq(d.reason, "task execution", "task execution → correct reason");
}

// Task execution but sonnet exhausted
{
  const d = routeModel(makeCtx({
    isTaskExecution: true,
    tierBudget: { sonnetRemaining: 0, opusRemaining: 5 },
  }));
  assertEq(d.tier, 1, "task execution, sonnet exhausted → tier 1");
}

// Explicit config model
{
  const d = routeModel(makeCtx({
    explicitModelRequest: "claude-opus-4-6",
  }));
  assertEq(d.tier, 3, "explicit config opus → tier 3");
}

// Explicit config sonnet, budget exhausted
{
  const d = routeModel(makeCtx({
    explicitModelRequest: "claude-sonnet-4-5-20250929",
    tierBudget: { sonnetRemaining: 0, opusRemaining: 0 },
  }));
  assertEq(d.tier, 1, "explicit config sonnet, exhausted → tier 1");
}

console.log("\n=== Layer 2: Content Classification ===\n");

// Opus signals
{
  const d = routeModel(makeCtx({ userMessage: "This is critical, be thorough" }));
  assertEq(d.tier, 3, "'critical' → Opus");
}

{
  const d = routeModel(makeCtx({ userMessage: "synthesize all sources" }));
  assertEq(d.tier, 3, "'synthesize' → Opus");
}

{
  const d = routeModel(makeCtx({ userMessage: "cross-reference the reports" }));
  assertEq(d.tier, 3, "'cross-reference' → Opus");
}

// Opus signals but budget exhausted → downgrade
{
  const d = routeModel(makeCtx({
    userMessage: "This is critical information",
    tierBudget: { sonnetRemaining: 10, opusRemaining: 0 },
  }));
  assertEq(d.tier, 2, "opus signal, opus exhausted → downgrade to Sonnet");
}

// Sonnet signals: code
{
  const d = routeModel(makeCtx({ userMessage: "write code for a REST API" }));
  assertEq(d.tier, 2, "'write code' → Sonnet");
}

{
  const d = routeModel(makeCtx({ userMessage: "can you implement this feature?" }));
  assertEq(d.tier, 2, "'implement' → Sonnet");
}

{
  const d = routeModel(makeCtx({ userMessage: "debug this function" }));
  assertEq(d.tier, 2, "'debug' → Sonnet");
}

{
  const d = routeModel(makeCtx({ userMessage: "refactor the auth module" }));
  assertEq(d.tier, 2, "'refactor' → Sonnet");
}

// Sonnet signals: analysis
{
  const d = routeModel(makeCtx({ userMessage: "analyze this quarterly report" }));
  assertEq(d.tier, 2, "'analyze' → Sonnet");
}

{
  const d = routeModel(makeCtx({ userMessage: "evaluate the options" }));
  assertEq(d.tier, 2, "'evaluate' → Sonnet");
}

{
  const d = routeModel(makeCtx({ userMessage: "draft an email to the team" }));
  assertEq(d.tier, 2, "'draft an email' → Sonnet");
}

// Multi-step patterns
{
  const d = routeModel(makeCtx({ userMessage: "first search Google then summarize results" }));
  assertEq(d.tier, 2, "'first...then' → Sonnet");
}

{
  const d = routeModel(makeCtx({ userMessage: "step 1: do this. step 2: do that" }));
  assertEq(d.tier, 2, "'step 1' → Sonnet");
}

// Code blocks
{
  const d = routeModel(makeCtx({
    userMessage: "fix this code:\n```javascript\nfunction hello() { return 'world'; }\n```",
  }));
  assertEq(d.tier, 2, "code block → Sonnet");
}

// Long message
{
  const longMsg = "a".repeat(501);
  const d = routeModel(makeCtx({ userMessage: longMsg }));
  assertEq(d.tier, 2, "long message (>500 chars) → Sonnet");
}

// Long message with sonnet exhausted
{
  const longMsg = "a".repeat(501);
  const d = routeModel(makeCtx({
    userMessage: longMsg,
    tierBudget: { sonnetRemaining: 0, opusRemaining: 5 },
  }));
  assertEq(d.tier, 1, "long message, sonnet exhausted → Haiku");
}

// Sonnet with retryOnFailure
{
  const d = routeModel(makeCtx({ userMessage: "write code for login" }));
  assert(d.retryOnFailure === TIER_MODELS[3], "sonnet signal has Opus retry when budget available");
}

// Sonnet retryOnFailure absent when opus exhausted
{
  const d = routeModel(makeCtx({
    userMessage: "write code for login",
    tierBudget: { sonnetRemaining: 10, opusRemaining: 0 },
  }));
  assert(d.retryOnFailure === undefined, "sonnet signal, no Opus retry when opus exhausted");
}

console.log("\n=== Default: Haiku ===\n");

// Simple messages → Haiku
{
  const d = routeModel(makeCtx({ userMessage: "hello" }));
  assertEq(d.tier, 1, "'hello' → Haiku");
  assertEq(d.reason, "default/haiku", "default reason");
}

{
  const d = routeModel(makeCtx({ userMessage: "what time is it?" }));
  assertEq(d.tier, 1, "simple question → Haiku");
}

{
  const d = routeModel(makeCtx({ userMessage: "thanks!" }));
  assertEq(d.tier, 1, "'thanks!' → Haiku");
}

console.log("\n=== Priority / Override Order ===\n");

// Heartbeat overrides everything
{
  const d = routeModel(makeCtx({
    isHeartbeat: true,
    isTaskExecution: true,
    toggles: { deepResearch: true },
    userMessage: "This is critical, write code now",
  }));
  assertEq(d.model, "minimax-m2.5", "heartbeat overrides all other signals");
}

// Recurring overrides content signals
{
  const d = routeModel(makeCtx({
    isRecurringTask: true,
    userMessage: "This is critical, analyze deeply",
  }));
  assertEq(d.tier, 1, "recurring overrides content signals");
}

// Explicit "use opus" overrides deep research toggle
{
  const d = routeModel(makeCtx({
    userMessage: "use opus for this research",
    toggles: { deepResearch: true },
  }));
  assertEq(d.tier, 3, "explicit 'use opus' overrides deep research toggle");
}

console.log("\n=== Budget Exhaustion Edge Cases ===\n");

// All budgets gone, complex message
{
  const d = routeModel(makeCtx({
    userMessage: "This is critical, write code, analyze deeply",
    tierBudget: EXHAUSTED_BUDGET,
  }));
  assertEq(d.tier, 1, "all budgets exhausted → always Haiku for content signals");
}

// Sonnet gone, opus available, opus signal
{
  const d = routeModel(makeCtx({
    userMessage: "think deeply about this",
    tierBudget: { sonnetRemaining: 0, opusRemaining: 5 },
  }));
  assertEq(d.tier, 3, "opus signal, sonnet gone but opus available → Opus");
}

// ── Summary ──

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(40)}\n`);

if (failed > 0) {
  process.exit(1);
}
