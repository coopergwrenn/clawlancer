/**
 * Unit tests for model-router.ts
 *
 * Run: npx tsx instaclaw/lib/__tests__/model-router.test.ts
 *
 * Self-contained — no test framework required. Uses simple assertions
 * and exits with non-zero on failure.
 */

// Inline the types and functions to avoid @/ path alias issues in standalone execution.

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

const OPUS_SIGNALS =
  /\b(important|critical|be thorough|think deeply|synthesize|cross-reference|from scratch|full[- ]?stack|end[- ]?to[- ]?end|redesign|architect|architecture)\b/i;
const OPUS_MULTI_AGENT =
  /\b(subagent|sub[- ]?agent|multi[- ]?agent)\b|\bcoordinate with .+agents?\b|\bother agents?\b/i;
const OPUS_SMART_CONTRACT_DEPLOY =
  /\bsmart contract\b[\s\S]*\bdeploy\b|\bdeploy\b[\s\S]*\bsmart contract\b/i;
const ACTION_VERB_PATTERN =
  /\b(build|create|write|implement|deploy|test|design|integrate|configure|migrate|optimize|develop|monitor|analyze|audit|refactor|rewrite|generate|establish|install|connect|debug|coordinate|research|set up)\b/gi;
const BUILD_VERB_PATTERN =
  /\b(build|create|develop|implement|set up|configure|deploy|architect|design)\b/i;
const SONNET_SIGNALS =
  /\b(write code|write (?:a|me a) \w+|implement|debug|refactor|build (?:a|me a|me) \w+|create a \w+|analyze|evaluate|financial|competitive|audit|draft an email|compare|contrast|step[- ]?by[- ]?step|research|design|plan|rewrite|optimize|migrate|generate|develop|set up|configure)\b/i;
const MULTI_STEP_PATTERN = /\b(first\b.*\bthen\b|step \d|1\.|1\))/i;
const CODE_BLOCK_PATTERN = /```[\s\S]{10,}/;
const EXPLICIT_OPUS_PATTERN = /\buse opus\b/i;
const EXPLICIT_SONNET_PATTERN = /\buse sonnet\b/i;
const EXPLICIT_HAIKU_PATTERN = /\buse haiku\b/i;

function countDistinctActionVerbs(msg: string): number {
  const matches = msg.match(ACTION_VERB_PATTERN);
  if (!matches) return 0;
  return new Set(matches.map((m) => m.toLowerCase())).size;
}

function hasComplexBuild(msg: string): boolean {
  if (!BUILD_VERB_PATTERN.test(msg)) return false;
  return (msg.match(/,/g) || []).length >= 2 && msg.length > 80;
}

function opusDecision(ctx: RoutingContext, reason: string): RoutingDecision {
  if (ctx.tierBudget.opusRemaining > 0) return { model: TIER_MODELS[3], tier: 3, reason };
  if (ctx.tierBudget.sonnetRemaining > 0) return { model: TIER_MODELS[2], tier: 2, reason: `${reason} but opus budget exhausted, downgraded to sonnet` };
  return { model: TIER_MODELS[1], tier: 1, reason: `${reason} but all budgets exhausted` };
}

function routeModel(ctx: RoutingContext): RoutingDecision {
  const msg = ctx.userMessage;
  if (ctx.isHeartbeat) return { model: "minimax-m2.5", tier: 1, reason: "heartbeat" };
  if (ctx.isRecurringTask) return { model: TIER_MODELS[1], tier: 1, reason: "recurring task" };
  if (EXPLICIT_OPUS_PATTERN.test(msg)) {
    if (ctx.tierBudget.opusRemaining > 0) return { model: TIER_MODELS[3], tier: 3, reason: "explicit opus request" };
    if (ctx.tierBudget.sonnetRemaining > 0) return { model: TIER_MODELS[2], tier: 2, reason: "opus requested but budget exhausted, downgraded to sonnet" };
    return { model: TIER_MODELS[1], tier: 1, reason: "opus requested but all budgets exhausted, downgraded to haiku" };
  }
  if (EXPLICIT_SONNET_PATTERN.test(msg)) {
    if (ctx.tierBudget.sonnetRemaining > 0) return { model: TIER_MODELS[2], tier: 2, reason: "explicit sonnet request" };
    return { model: TIER_MODELS[1], tier: 1, reason: "sonnet requested but budget exhausted, downgraded to haiku" };
  }
  if (EXPLICIT_HAIKU_PATTERN.test(msg)) return { model: TIER_MODELS[1], tier: 1, reason: "explicit haiku request" };
  if (ctx.explicitModelRequest) return respectExplicitModel(ctx);
  if (ctx.toggles.deepResearch) {
    if (ctx.tierBudget.sonnetRemaining > 0) return { model: TIER_MODELS[2], tier: 2, reason: "deep research toggle", retryOnFailure: ctx.tierBudget.opusRemaining > 0 ? TIER_MODELS[3] : undefined };
    return { model: TIER_MODELS[1], tier: 1, reason: "deep research toggle but sonnet budget exhausted" };
  }
  if (ctx.isTaskExecution) {
    if (ctx.tierBudget.sonnetRemaining > 0) return { model: TIER_MODELS[2], tier: 2, reason: "task execution", retryOnFailure: ctx.tierBudget.opusRemaining > 0 ? TIER_MODELS[3] : undefined };
    return { model: TIER_MODELS[1], tier: 1, reason: "task execution but sonnet budget exhausted" };
  }
  if (OPUS_SIGNALS.test(msg)) return opusDecision(ctx, "opus content signal");
  if (OPUS_MULTI_AGENT.test(msg)) return opusDecision(ctx, "multi-agent signal");
  if (OPUS_SMART_CONTRACT_DEPLOY.test(msg)) return opusDecision(ctx, "smart contract + deploy");
  if (countDistinctActionVerbs(msg) >= 3) return opusDecision(ctx, "multi-action complexity (3+ verbs)");
  if (hasComplexBuild(msg)) return opusDecision(ctx, "complex build (3+ components)");
  if (SONNET_SIGNALS.test(msg) || MULTI_STEP_PATTERN.test(msg) || CODE_BLOCK_PATTERN.test(msg)) {
    if (ctx.tierBudget.sonnetRemaining > 0) return { model: TIER_MODELS[2], tier: 2, reason: "sonnet content signal", retryOnFailure: ctx.tierBudget.opusRemaining > 0 ? TIER_MODELS[3] : undefined };
    return { model: TIER_MODELS[1], tier: 1, reason: "sonnet signal but budget exhausted" };
  }
  if (msg.length > 500) {
    if (ctx.tierBudget.sonnetRemaining > 0) return { model: TIER_MODELS[2], tier: 2, reason: "long message (>500 chars)", retryOnFailure: ctx.tierBudget.opusRemaining > 0 ? TIER_MODELS[3] : undefined };
    return { model: TIER_MODELS[1], tier: 1, reason: "long message but sonnet budget exhausted" };
  }
  return { model: TIER_MODELS[1], tier: 1, reason: "default/haiku" };
}

function respectExplicitModel(ctx: RoutingContext): RoutingDecision {
  const m = ctx.explicitModelRequest!.toLowerCase();
  if (m.includes("opus")) {
    if (ctx.tierBudget.opusRemaining > 0) return { model: ctx.explicitModelRequest!, tier: 3, reason: "explicit config model (opus)" };
    if (ctx.tierBudget.sonnetRemaining > 0) return { model: TIER_MODELS[2], tier: 2, reason: "explicit opus config but budget exhausted" };
    return { model: TIER_MODELS[1], tier: 1, reason: "explicit opus config but all budgets exhausted" };
  }
  if (m.includes("sonnet")) {
    if (ctx.tierBudget.sonnetRemaining > 0) return { model: ctx.explicitModelRequest!, tier: 2, reason: "explicit config model (sonnet)" };
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
  if (condition) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name}`); }
}

function assertEq(actual: unknown, expected: unknown, name: string) {
  if (actual === expected) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// ══════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════

console.log("\n=== Layer 1: Static Overrides ===\n");

// Heartbeat
{ const d = routeModel(makeCtx({ isHeartbeat: true }));
  assertEq(d.model, "minimax-m2.5", "heartbeat → MiniMax");
  assertEq(d.tier, 1, "heartbeat → tier 1"); }

// Recurring task
{ const d = routeModel(makeCtx({ isRecurringTask: true }));
  assertEq(d.model, TIER_MODELS[1], "recurring → Haiku");
  assertEq(d.reason, "recurring task", "recurring → correct reason"); }

// Explicit "use opus" in message
{ const d = routeModel(makeCtx({ userMessage: "Please use opus for this" }));
  assertEq(d.tier, 3, "explicit 'use opus' → tier 3");
  assertEq(d.model, TIER_MODELS[3], "explicit 'use opus' → Opus model"); }

// Explicit "use opus" but budget exhausted
{ const d = routeModel(makeCtx({ userMessage: "use opus please", tierBudget: { sonnetRemaining: 10, opusRemaining: 0 } }));
  assertEq(d.tier, 2, "explicit opus, budget exhausted → downgrade to tier 2"); }

// Explicit "use opus" all budgets exhausted
{ const d = routeModel(makeCtx({ userMessage: "use opus for this", tierBudget: EXHAUSTED_BUDGET }));
  assertEq(d.tier, 1, "explicit opus, all exhausted → tier 1"); }

// Explicit "use sonnet"
{ const d = routeModel(makeCtx({ userMessage: "use sonnet to help" }));
  assertEq(d.tier, 2, "explicit 'use sonnet' → tier 2"); }

// Explicit "use sonnet" budget exhausted
{ const d = routeModel(makeCtx({ userMessage: "use sonnet", tierBudget: { sonnetRemaining: 0, opusRemaining: 5 } }));
  assertEq(d.tier, 1, "explicit sonnet exhausted → tier 1"); }

// Explicit "use haiku"
{ const d = routeModel(makeCtx({ userMessage: "just use haiku for this" }));
  assertEq(d.tier, 1, "explicit 'use haiku' → tier 1"); }

// Deep Research toggle
{ const d = routeModel(makeCtx({ toggles: { deepResearch: true } }));
  assertEq(d.tier, 2, "deep research toggle → tier 2");
  assert(d.retryOnFailure === TIER_MODELS[3], "deep research has Opus retry"); }

// Deep Research toggle but sonnet exhausted
{ const d = routeModel(makeCtx({ toggles: { deepResearch: true }, tierBudget: { sonnetRemaining: 0, opusRemaining: 5 } }));
  assertEq(d.tier, 1, "deep research, sonnet exhausted → tier 1"); }

// Task execution
{ const d = routeModel(makeCtx({ isTaskExecution: true }));
  assertEq(d.tier, 2, "task execution → tier 2");
  assertEq(d.reason, "task execution", "task execution → correct reason"); }

// Task execution but sonnet exhausted
{ const d = routeModel(makeCtx({ isTaskExecution: true, tierBudget: { sonnetRemaining: 0, opusRemaining: 5 } }));
  assertEq(d.tier, 1, "task execution, sonnet exhausted → tier 1"); }

// Explicit config model
{ const d = routeModel(makeCtx({ explicitModelRequest: "claude-opus-4-6" }));
  assertEq(d.tier, 3, "explicit config opus → tier 3"); }

// Explicit config sonnet, budget exhausted
{ const d = routeModel(makeCtx({ explicitModelRequest: "claude-sonnet-4-5-20250929", tierBudget: EXHAUSTED_BUDGET }));
  assertEq(d.tier, 1, "explicit config sonnet, exhausted → tier 1"); }

console.log("\n=== Layer 2: Opus Signals (Original) ===\n");

{ const d = routeModel(makeCtx({ userMessage: "This is critical, be thorough" }));
  assertEq(d.tier, 3, "'critical' → Opus"); }

{ const d = routeModel(makeCtx({ userMessage: "synthesize all sources" }));
  assertEq(d.tier, 3, "'synthesize' → Opus"); }

{ const d = routeModel(makeCtx({ userMessage: "cross-reference the reports" }));
  assertEq(d.tier, 3, "'cross-reference' → Opus"); }

// Opus signals but budget exhausted → downgrade
{ const d = routeModel(makeCtx({ userMessage: "This is critical information", tierBudget: { sonnetRemaining: 10, opusRemaining: 0 } }));
  assertEq(d.tier, 2, "opus signal, opus exhausted → downgrade to Sonnet"); }

console.log("\n=== Layer 2: Opus Signals (New Keywords) ===\n");

{ const d = routeModel(makeCtx({ userMessage: "Rebuild the auth system from scratch" }));
  assertEq(d.tier, 3, "'from scratch' → Opus"); }

{ const d = routeModel(makeCtx({ userMessage: "Build a full-stack application" }));
  assertEq(d.tier, 3, "'full-stack' → Opus"); }

{ const d = routeModel(makeCtx({ userMessage: "Full stack deployment needed" }));
  assertEq(d.tier, 3, "'full stack' (with space) → Opus"); }

{ const d = routeModel(makeCtx({ userMessage: "I need an end-to-end solution" }));
  assertEq(d.tier, 3, "'end-to-end' → Opus"); }

{ const d = routeModel(makeCtx({ userMessage: "Redesign the entire notification system" }));
  assertEq(d.tier, 3, "'redesign' → Opus"); }

{ const d = routeModel(makeCtx({ userMessage: "Architect a new microservices platform" }));
  assertEq(d.tier, 3, "'architect' → Opus"); }

{ const d = routeModel(makeCtx({ userMessage: "Propose a new architecture for the backend" }));
  assertEq(d.tier, 3, "'architecture' → Opus"); }

console.log("\n=== Layer 2: Opus Multi-Agent ===\n");

{ const d = routeModel(makeCtx({ userMessage: "Create a subagent to monitor prices" }));
  assertEq(d.tier, 3, "'subagent' → Opus"); }

{ const d = routeModel(makeCtx({ userMessage: "Build a multi-agent workflow" }));
  assertEq(d.tier, 3, "'multi-agent' → Opus"); }

{ const d = routeModel(makeCtx({ userMessage: "Coordinate with 3 other agents to finish this" }));
  assertEq(d.tier, 3, "'coordinate with...agents' → Opus"); }

{ const d = routeModel(makeCtx({ userMessage: "Tell the other agents to start" }));
  assertEq(d.tier, 3, "'other agents' → Opus"); }

console.log("\n=== Layer 2: Opus Smart Contract + Deploy ===\n");

{ const d = routeModel(makeCtx({ userMessage: "Write a smart contract and deploy it to mainnet" }));
  assertEq(d.tier, 3, "'smart contract...deploy' → Opus"); }

{ const d = routeModel(makeCtx({ userMessage: "Deploy the smart contract we wrote yesterday" }));
  assertEq(d.tier, 3, "'deploy...smart contract' (reverse order) → Opus"); }

console.log("\n=== Layer 2: Opus Multi-Action (3+ Verbs) ===\n");

{ const d = routeModel(makeCtx({ userMessage: "Write the API, test it thoroughly, and deploy to production" }));
  assertEq(d.tier, 3, "write + test + deploy → Opus (3 verbs)"); }

{ const d = routeModel(makeCtx({ userMessage: "Research competitors, analyze the data, and design a strategy" }));
  assertEq(d.tier, 3, "research + analyze + design → Opus (3 verbs)"); }

{ const d = routeModel(makeCtx({ userMessage: "Build the frontend and integrate the API" }));
  assert(d.tier < 3, "build + integrate → NOT Opus (only 2 verbs, not 3)"); }

console.log("\n=== Layer 2: Opus Complex Build (3+ Components) ===\n");

{ const d = routeModel(makeCtx({ userMessage: "Build me a full Next.js dashboard with authentication, database integration, and real-time notifications" }));
  assertEq(d.tier, 3, "build + 3 listed components → Opus"); }

{ const d = routeModel(makeCtx({ userMessage: "Create a platform with user management, payment processing, and analytics dashboards for tracking" }));
  assertEq(d.tier, 3, "create + 3 listed components → Opus"); }

console.log("\n=== Layer 2: Sonnet Signals (Original) ===\n");

{ const d = routeModel(makeCtx({ userMessage: "write code for a REST API" }));
  assertEq(d.tier, 2, "'write code' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "can you implement this feature?" }));
  assertEq(d.tier, 2, "'implement' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "debug this function" }));
  assertEq(d.tier, 2, "'debug' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "refactor the auth module" }));
  assertEq(d.tier, 2, "'refactor' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "analyze this quarterly report" }));
  assertEq(d.tier, 2, "'analyze' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "evaluate the options" }));
  assertEq(d.tier, 2, "'evaluate' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "draft an email to the team" }));
  assertEq(d.tier, 2, "'draft an email' → Sonnet"); }

console.log("\n=== Layer 2: Sonnet Signals (New Keywords) ===\n");

{ const d = routeModel(makeCtx({ userMessage: "Research the latest trends in AI" }));
  assertEq(d.tier, 2, "'research' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "Write me a Python script for data analysis" }));
  assertEq(d.tier, 2, "'write me a [noun]' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "Write a detailed report on our competitors" }));
  assertEq(d.tier, 2, "'write a [noun]' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "Build me a landing page" }));
  assertEq(d.tier, 2, "'build me [noun]' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "Create a dashboard for user analytics" }));
  assertEq(d.tier, 2, "'create a [noun]' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "Design the new onboarding flow" }));
  assertEq(d.tier, 2, "'design' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "Plan the sprint for next week" }));
  assertEq(d.tier, 2, "'plan' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "Rewrite the authentication middleware" }));
  assertEq(d.tier, 2, "'rewrite' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "Optimize the database queries" }));
  assertEq(d.tier, 2, "'optimize' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "Migrate the old API to v2" }));
  assertEq(d.tier, 2, "'migrate' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "Generate a CSV export of all users" }));
  assertEq(d.tier, 2, "'generate' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "Develop a notification service" }));
  assertEq(d.tier, 2, "'develop' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "Set up the CI/CD pipeline" }));
  assertEq(d.tier, 2, "'set up' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "Configure the Nginx reverse proxy" }));
  assertEq(d.tier, 2, "'configure' → Sonnet"); }

console.log("\n=== Layer 2: Multi-Step Patterns + Code Blocks ===\n");

{ const d = routeModel(makeCtx({ userMessage: "first search Google then summarize results" }));
  assertEq(d.tier, 2, "'first...then' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "step 1: do this. step 2: do that" }));
  assertEq(d.tier, 2, "'step 1' → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "fix this code:\n```javascript\nfunction hello() { return 'world'; }\n```" }));
  assertEq(d.tier, 2, "code block → Sonnet"); }

// Long message
{ const d = routeModel(makeCtx({ userMessage: "a".repeat(501) }));
  assertEq(d.tier, 2, "long message (>500 chars) → Sonnet"); }

{ const d = routeModel(makeCtx({ userMessage: "a".repeat(501), tierBudget: { sonnetRemaining: 0, opusRemaining: 5 } }));
  assertEq(d.tier, 1, "long message, sonnet exhausted → Haiku"); }

// Sonnet retryOnFailure
{ const d = routeModel(makeCtx({ userMessage: "write code for login" }));
  assert(d.retryOnFailure === TIER_MODELS[3], "sonnet signal has Opus retry when budget available"); }

{ const d = routeModel(makeCtx({ userMessage: "write code for login", tierBudget: { sonnetRemaining: 10, opusRemaining: 0 } }));
  assert(d.retryOnFailure === undefined, "sonnet signal, no Opus retry when opus exhausted"); }

console.log("\n=== Default: Haiku ===\n");

{ const d = routeModel(makeCtx({ userMessage: "hello" }));
  assertEq(d.tier, 1, "'hello' → Haiku");
  assertEq(d.reason, "default/haiku", "default reason"); }

{ const d = routeModel(makeCtx({ userMessage: "what time is it?" }));
  assertEq(d.tier, 1, "simple question → Haiku"); }

{ const d = routeModel(makeCtx({ userMessage: "thanks!" }));
  assertEq(d.tier, 1, "'thanks!' → Haiku"); }

// Ensure "search" does NOT match "research"
{ const d = routeModel(makeCtx({ userMessage: "Search the web for news about AI" }));
  assertEq(d.tier, 1, "'search' (not 'research') → Haiku"); }

console.log("\n=== Priority / Override Order ===\n");

{ const d = routeModel(makeCtx({ isHeartbeat: true, isTaskExecution: true, toggles: { deepResearch: true }, userMessage: "This is critical, write code now" }));
  assertEq(d.model, "minimax-m2.5", "heartbeat overrides all other signals"); }

{ const d = routeModel(makeCtx({ isRecurringTask: true, userMessage: "This is critical, analyze deeply" }));
  assertEq(d.tier, 1, "recurring overrides content signals"); }

{ const d = routeModel(makeCtx({ userMessage: "use opus for this research", toggles: { deepResearch: true } }));
  assertEq(d.tier, 3, "explicit 'use opus' overrides deep research toggle"); }

console.log("\n=== Budget Exhaustion Edge Cases ===\n");

{ const d = routeModel(makeCtx({ userMessage: "This is critical, write code, analyze deeply", tierBudget: EXHAUSTED_BUDGET }));
  assertEq(d.tier, 1, "all budgets exhausted → always Haiku for content signals"); }

{ const d = routeModel(makeCtx({ userMessage: "think deeply about this", tierBudget: { sonnetRemaining: 0, opusRemaining: 5 } }));
  assertEq(d.tier, 3, "opus signal, sonnet gone but opus available → Opus"); }

// Multi-agent signal with opus budget exhausted → downgrade to Sonnet
{ const d = routeModel(makeCtx({ userMessage: "Create a subagent to watch stocks", tierBudget: { sonnetRemaining: 10, opusRemaining: 0 } }));
  assertEq(d.tier, 2, "multi-agent opus exhausted → downgrade to Sonnet"); }

// Complex build with all budgets exhausted → Haiku
{ const d = routeModel(makeCtx({ userMessage: "Build me a full system with authentication, payments, analytics, and notifications for our platform", tierBudget: EXHAUSTED_BUDGET }));
  assertEq(d.tier, 1, "complex build, all budgets exhausted → Haiku"); }

console.log("\n=== Part 2 Audit Messages (15/15) ===\n");

const auditMessages: [string, number][] = [
  ["What's the weather like today?", 1],
  ["Read my MEMORY.md and tell me what you know about me", 1],
  ["What time is it?", 1],
  ["Summarize this article for me", 1],
  ["What's in my workspace?", 1],
  ["Research the top 5 competitors in the AI agent space and give me a detailed competitive analysis", 2],
  ["Write me a Python script that scrapes product prices from Amazon and stores them in a database", 2],
  ["Draft an email to my investors with our Q1 metrics and growth projections", 2],
  ["Analyze NVIDIA's stock performance over the last 6 months and give me a technical breakdown", 2],
  ["Search the web for recent news about World Foundation and summarize the key developments", 1],
  ["Build me a full Next.js dashboard with authentication, database integration, and real-time notifications", 3],
  ["Create a subagent that monitors my competitors daily and sends me a weekly report with actionable insights", 3],
  ["Write a smart contract for USDC escrow with dispute resolution, test it, and deploy to mainnet", 3],
  ["Redesign my entire agent's skill system from scratch. Audit what's working, what's not, and propose a new architecture", 3],
  ["I need you to coordinate with 3 other agents to complete this research project", 3],
];

for (const [msg, expected] of auditMessages) {
  const d = routeModel(makeCtx({ userMessage: msg }));
  const short = msg.length > 60 ? msg.slice(0, 60) + "..." : msg;
  assertEq(d.tier, expected, `audit: "${short}" → tier ${expected}`);
}

// ── Summary ──

console.log(`\n${"=".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"=".repeat(50)}\n`);

if (failed > 0) process.exit(1);
