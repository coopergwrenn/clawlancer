/**
 * Reasoning Router — classifies user messages to select OpenAI Codex
 * `reasoning.effort` per request. Runs inside pi-ai's openai-codex-responses
 * provider, called before the HTTP body is built.
 *
 * Design doc: instaclaw/docs/prd/chatgpt-oauth-reasoning-routing-design-2026-05-20.md
 *
 * Sentinels (Rule 23 — required strings checked by manifest):
 *   "classifyMessage exports.classifyMessage"
 *   "REASONING_ROUTER_V1"
 *
 * Invariants:
 *   1. Pure function — no async, no network, no LLM calls. Pure regex + file reads.
 *   2. <5ms latency on a 1KB message (regex-bounded, no expensive ops).
 *   3. Router failure NEVER blocks a request — caller wraps in try/catch and
 *      falls through to OpenClaw's default effort if anything throws.
 *   4. Reads two state files (cheap stat + open):
 *        ~/.openclaw/.reasoning-preference          — user's dashboard pref
 *        ~/.openclaw/agents/main/sessions/.reasoning-override.json — NL override
 *   5. Append-only telemetry to ~/.openclaw/logs/reasoning-router.log (JSONL).
 *
 * Decision precedence (first match wins):
 *   1. User dashboard preference (non-"auto") — overrides everything
 *   2. Active per-session natural-language override (persisted, with TTL)
 *   3. In-message natural-language override (this turn only)
 *   4. Heuristic taxonomy (greeting/ack/research/analysis/creative/code/...)
 *   5. Default — "medium" (matches OpenAI's API default; quality-biased baseline)
 *
 * Effort levels:
 *   "low"     — sub-15s expected, used for greetings/acks/status checks
 *   "medium"  — sub-45s expected, default baseline (OpenAI API default)
 *   "high"    — sub-180s expected, used for analysis/creative/code/multi-part
 *   "xhigh"   — sub-600s expected, used for deep research / explicit override
 *
 * REASONING_ROUTER_V1
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// ── Paths ────────────────────────────────────────────────────────────────
const HOME = os.homedir();
const PREFERENCE_FILE = path.join(HOME, ".openclaw", ".reasoning-preference");
const OVERRIDE_FILE = path.join(HOME, ".openclaw", "agents", "main", "sessions", ".reasoning-override.json");
const LOG_FILE = path.join(HOME, ".openclaw", "logs", "reasoning-router.log");

// ── Effort spec ──────────────────────────────────────────────────────────
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const EXPECTED_DURATION_MS = {
  low: 15_000,
  medium: 45_000,
  high: 180_000,
  xhigh: 600_000,
};

// ── Heuristic taxonomy regexes ───────────────────────────────────────────
// Order of detection (first match wins):
//   1. EXPLICIT_OVERRIDE        — in-message natural-language override
//   2. SOCIAL                   — short greetings
//   3. ACKNOWLEDGMENT           — thanks/appreciation (length-independent)
//   4. STATUS_CHECK             — short status pokes
//   5. DEEP_RESEARCH            — explicit research/comprehensive signals
//   6. ANALYSIS                 — analyze/compare/recommend signals
//   7. CREATIVE                 — write/draft/compose + content type
//   8. CODE_TECHNICAL           — code fences, error/debug signals
//   9. MULTI_PART               — multiple actions, lists, enumerations
//  10. LONG_MESSAGE             — >30 words usually has substance
//  11. DEFAULT                  — medium (OpenAI's API default)

// Greeting words at start (followed by optional punctuation/end-of-string).
// Bounded length to avoid catching "hey can you analyze ..."
const SOCIAL_PATTERNS = [
  /^(yo+|hey+|hi+|hello+|sup|gm|gn|wassup|howdy|aloha|bonjour|good (morning|night|evening|afternoon))[\s!.,?\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{1FA00}-\u{1FAFF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}]*$/iu,
  /^(thx|ty|thanks|thank you|cheers|kudos|nice|cool|awesome|sweet|word|bet|fr)[\s!.,?\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{1FA00}-\u{1FAFF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}]*$/iu,
  /^(lol|haha|hahah+|lmao|ok|okay|kk|k|sure|yep|nope|yeah|nah|yup|mhm)[\s!.,?\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{1FA00}-\u{1FAFF}\u{2300}-\u{23FF}\u{FE0F}\u{200D}]*$/iu,
  /^appreciate (it|that|this|the help|your)[\s!.,?]*$/i,
];

// Pure emoji message (Unicode emoji blocks + whitespace/punctuation only).
const EMOJI_ONLY_PATTERN = /^[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}\u{1FA00}-\u{1FAFF}\u{2300}-\u{23FF}\s!.,?❤️🙏]*$/u;

// Acknowledgment phrases — fire regardless of message length. A user can
// write a long thank-you note that still needs minimal reasoning.
const ACKNOWLEDGMENT_PATTERNS = [
  /\b(wanted to (say|let you know)|just (saying|wanted to)|thanks for|appreciated|thank you for|kudos for|nice (job|work) on|hope you'?re? doing well|good (work|job))\b/i,
];

// Short status pokes — "did you get that?", "are you there?", lone "?".
const STATUS_CHECK_PATTERNS = [
  /\b(did you get|did that (work|land)|did it work|is that done|are you (there|alive|up)|you good|all good|still there|any update|where (we|you) at|status\?)\b/i,
  /^[?]+$/,
  /^(\?+|hello\?+|you there\?+)$/i,
];

// Deep-research signals — explicit asks for thorough/comprehensive output.
const DEEP_RESEARCH_PATTERNS = [
  /\b(do (a )?deep dive|deep dive (on|into)|comprehensive (overview|analysis|breakdown|guide)|thorough (analysis|review|investigation)|walk me through (everything|the whole)|step[- ]by[- ]step (through|guide))\b/i,
  /\b(research (the|all|every|this|how)|investigate (the|all|every|this|whether)|plan (a )?strategy for)\b/i,
  /\beverything (you know|there is|about)\b/i,
];

// Analysis/comparison/synthesis signals.
const ANALYSIS_PATTERNS = [
  /\b(analyz|compar|evaluat|asses|critique|interpret|synthes)/i, // word-stems
  /\b(recommend|suggest the best|pros and cons|trade ?offs?|rank|prioriti[sz]e|best (option|choice|approach|way))/i,
  /\bwhich\b.*\b(should|would|approach|option|path|way|strategy|one)\b/i,
  /\b(explain (why|how|the (reason|reasoning|logic)|what (caused|happened))|why (does|did|is|are|do))/i,
  /\b(what['']s the difference|what['']s better|how (do|does|did) .* (compare|differ))/i,
];

// Creative generation signals — verb + content type with flexible spacing.
// Allow up to ~40 chars between verb and content type (e.g. "draft a thank-you email").
const CREATIVE_PATTERNS = [
  /\b(write|draft|compose|generate|create|design|come up with)\b[^.!?\n]{0,40}\b(haiku|poem|song|essay|story|article|blog|tweet|email|letter|speech|pitch|copy|tagline|caption|name|title|joke|riddle|recipe|workout|message|note|reply|response|outline|summary)\b/i,
  /\b(brainstorm|ideate|conceptualize)\b[^.!?\n]{0,20}\b(ideas|names|options|titles|hooks|angles|approaches|concepts)\b/i,
];

// Code/technical signals — code fences, error mentions, debug verbs.
const CODE_TECHNICAL_PATTERNS = [
  /```/,
  /\b(stack ?trace|stacktrace|null pointer|null reference|undefined is not|segfault|sigsegv|sigterm|sigkill|panic:|exception:|traceback)\b/i,
  /\b(typescript|python|rust|golang|ruby|elixir|haskell|kotlin|swift)\b.*\b(fix|implement|write|build|debug|review|optimize|refactor)\b/i,
  /\b(debug|troubleshoot|why does (this|my) (code|function|script|query|migration)) (fail|crash|hang|error)/i,
  /\b(git (rebase|merge|cherry-pick|reset|reflog))\b/i,
];

// Multi-part task signals — multiple actions or lists.
const MULTI_PART_PATTERNS = [
  /\b(and then|then also|after that|once that's done)\b.*\b(and|then|also)\b/i,
  /;[^;]+;/, // multiple semicolons
  /\b1\.\s.*\b2\.\s/, // numbered list
  /(^- |^\* |^\d+\)\s)[^\n]*\n(- |\* |\d+\)\s)/m, // multiline bullet/numbered list
];

// Natural-language overrides — IN-MESSAGE (this turn only).
const EXPLICIT_OVERRIDE_PATTERNS = [
  // Persistent (set session override)
  { re: /\b(stay in deep mode|always (use )?deep thinking from now on|always (think|reason) deeply|deep (think |reasoning )mode from now on)\b/i, effort: "xhigh", persist: true },
  { re: /\b(be quick from now on|stay (quick|fast)|fast mode (on|from now)|always (be )?quick)\b/i, effort: "low", persist: true },
  { re: /\b(back to (normal|auto)|use auto( mode)?|reset (reasoning|thinking) mode|clear (reasoning|thinking) override)\b/i, effort: null, persist: "clear" },
  // Single-turn (this turn only)
  { re: /\b(think harder|use max(imum)? reasoning|really (analyze|think about) this|be thorough|think deep(ly)?|deep think this)\b/i, effort: "xhigh", persist: false },
  { re: /\b(maximum (effort|reasoning|thinking)|put in (max|maximum) effort|reason deeply)\b/i, effort: "xhigh", persist: false },
  { re: /\b(deep research|research mode|comprehensive answer|think (through this|about this) carefully)\b/i, effort: "xhigh", persist: false },
  { re: /\b(quick answer|don'?t overthink|tl;?dr|short version|brief reply|fast reply|quick response|just (a )?quick)\b/i, effort: "low", persist: false },
];

// ── Utilities ────────────────────────────────────────────────────────────

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch (_e) {
    return null;
  }
}

function writeFileSafe(p, content) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  } catch (_e) {
    /* ignore — telemetry/state writes must never fail the request */
  }
}

function unlinkSafe(p) {
  try {
    fs.unlinkSync(p);
  } catch (_e) {
    /* ignore */
  }
}

function normalizeEffort(e) {
  if (typeof e !== "string") return null;
  const lower = e.trim().toLowerCase();
  if (VALID_EFFORTS.has(lower)) return lower;
  return null;
}

function readPreference() {
  const raw = readFileSafe(PREFERENCE_FILE);
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === "auto") return null; // auto means "use router"
  return normalizeEffort(v);
}

function readSessionOverride(now) {
  const raw = readFileSafe(OVERRIDE_FILE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const effort = normalizeEffort(parsed.effort);
    const expiresAt = Number(parsed.expiresAt);
    if (!effort || !Number.isFinite(expiresAt)) return null;
    if (now > expiresAt) {
      // expired — clear file
      unlinkSafe(OVERRIDE_FILE);
      return null;
    }
    return { effort, setAt: parsed.setAt, expiresAt, phrase: parsed.phrase };
  } catch (_e) {
    // corrupt file — clear it
    unlinkSafe(OVERRIDE_FILE);
    return null;
  }
}

function writeSessionOverride(effort, phrase, now, ttlMs) {
  const data = {
    effort,
    setAt: now,
    expiresAt: now + ttlMs,
    phrase: phrase.slice(0, 120),
  };
  writeFileSafe(OVERRIDE_FILE, JSON.stringify(data));
}

function clearSessionOverride() {
  unlinkSafe(OVERRIDE_FILE);
}

function logDecision(record) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + "\n");
  } catch (_e) {
    /* ignore */
  }
}

function effortToDecision(effort, reason) {
  return {
    effort,
    expectedDurationMs: EXPECTED_DURATION_MS[effort],
    reason,
  };
}

// ── Override detection (in-message NL) ───────────────────────────────────

function detectExplicitOverride(message) {
  for (const pat of EXPLICIT_OVERRIDE_PATTERNS) {
    const m = message.match(pat.re);
    if (m) {
      return {
        effort: pat.effort, // null means "clear override"
        persist: pat.persist,
        phrase: m[0],
      };
    }
  }
  return null;
}

// ── Heuristic classifier ─────────────────────────────────────────────────

function heuristicClassify(message) {
  const trimmed = message.trim();
  const length = trimmed.length;
  const wordCount = trimmed.split(/\s+/).filter((w) => w.length > 0).length;
  const lower = trimmed.toLowerCase();

  // 1. Pure emoji
  if (length > 0 && EMOJI_ONLY_PATTERN.test(trimmed)) {
    return effortToDecision("low", "emoji-only");
  }

  // 2. Short greetings/acks
  if (length < 25) {
    for (const re of SOCIAL_PATTERNS) {
      if (re.test(trimmed)) return effortToDecision("low", "social/greeting");
    }
  }

  // 3. Acknowledgment phrases (length-independent — a long thank-you needs low effort)
  for (const re of ACKNOWLEDGMENT_PATTERNS) {
    if (re.test(lower)) return effortToDecision("low", "acknowledgment");
  }

  // 4. Status checks
  if (length < 80) {
    for (const re of STATUS_CHECK_PATTERNS) {
      if (re.test(trimmed)) return effortToDecision("low", "status-check");
    }
  }

  // 5. Deep research signals — promote to xhigh
  for (const re of DEEP_RESEARCH_PATTERNS) {
    if (re.test(lower)) return effortToDecision("xhigh", "deep-research");
  }

  // 6. Analysis/comparison/recommendation
  for (const re of ANALYSIS_PATTERNS) {
    if (re.test(lower)) return effortToDecision("high", "analysis");
  }

  // 7. Creative generation
  for (const re of CREATIVE_PATTERNS) {
    if (re.test(lower)) return effortToDecision("high", "creative");
  }

  // 8. Code/technical
  for (const re of CODE_TECHNICAL_PATTERNS) {
    if (re.test(message)) return effortToDecision("high", "code-technical");
  }

  // 9. Multi-part task
  for (const re of MULTI_PART_PATTERNS) {
    if (re.test(message)) return effortToDecision("high", "multi-part");
  }

  // 10. Long message — usually has substance
  if (wordCount > 30) {
    return effortToDecision("high", "long-message");
  }

  // 11. Default — medium (OpenAI's API default; quality-biased baseline)
  return effortToDecision("medium", "default");
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Classify a user message → effort decision.
 *
 * @param {string} messageText — the latest user message
 * @param {object} [options]
 * @param {string} [options.modelId] — e.g. "openai-codex/gpt-5.5" (for logging)
 * @param {string} [options.sessionId] — for logging
 * @returns {{effort:string, expectedDurationMs:number, reason:string}}
 */
function classifyMessage(messageText, options = {}) {
  const now = Date.now();
  const safeMsg = typeof messageText === "string" ? messageText : "";

  // 1. Dashboard preference (highest priority)
  const userPref = readPreference();
  if (userPref) {
    const dec = effortToDecision(userPref, `user-preference:${userPref}`);
    logDecision({
      ts: now,
      sessionId: options.sessionId,
      modelId: options.modelId,
      msgLen: safeMsg.length,
      ...dec,
      userPref,
      sessionOverride: null,
    });
    return dec;
  }

  // 2. In-message explicit override — may also mutate session-override state
  const override = detectExplicitOverride(safeMsg);
  if (override) {
    if (override.persist === "clear") {
      clearSessionOverride();
      // Fall through to heuristic for this turn
    } else if (override.persist === true) {
      // Persistent: set session override (1 hour TTL)
      writeSessionOverride(override.effort, override.phrase, now, 60 * 60 * 1000);
      const dec = effortToDecision(override.effort, `nl-override-persist:${override.phrase}`);
      logDecision({
        ts: now,
        sessionId: options.sessionId,
        modelId: options.modelId,
        msgLen: safeMsg.length,
        ...dec,
        userPref: null,
        sessionOverride: { effort: override.effort, persisted: true },
      });
      return dec;
    } else {
      // Single-turn override
      const dec = effortToDecision(override.effort, `nl-override:${override.phrase}`);
      logDecision({
        ts: now,
        sessionId: options.sessionId,
        modelId: options.modelId,
        msgLen: safeMsg.length,
        ...dec,
        userPref: null,
        sessionOverride: null,
      });
      return dec;
    }
  }

  // 3. Session override (set previously via persistent NL override)
  const sessOverride = readSessionOverride(now);
  if (sessOverride) {
    const dec = effortToDecision(sessOverride.effort, `session-override:${sessOverride.phrase || "?"}`);
    logDecision({
      ts: now,
      sessionId: options.sessionId,
      modelId: options.modelId,
      msgLen: safeMsg.length,
      ...dec,
      userPref: null,
      sessionOverride: sessOverride,
    });
    return dec;
  }

  // 4. Heuristic classification
  const dec = heuristicClassify(safeMsg);
  logDecision({
    ts: now,
    sessionId: options.sessionId,
    modelId: options.modelId,
    msgLen: safeMsg.length,
    ...dec,
    userPref: null,
    sessionOverride: null,
  });
  return dec;
}

/**
 * Extract the latest user message from pi-ai's `context.input` array.
 * Returns "" if none found.
 */
function extractLatestUserMessage(input) {
  if (!Array.isArray(input)) return "";
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (!item || typeof item !== "object") continue;
    if (item.role !== "user") continue;
    const c = item.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const texts = [];
      for (const block of c) {
        if (block && typeof block === "object") {
          if (typeof block.text === "string") texts.push(block.text);
          else if (typeof block.input_text === "string") texts.push(block.input_text);
        } else if (typeof block === "string") {
          texts.push(block);
        }
      }
      return texts.join(" ");
    }
    return "";
  }
  return "";
}

// classifyMessage exports.classifyMessage  ← sentinel string for Rule 23
module.exports = {
  classifyMessage,
  extractLatestUserMessage,
  // Exposed for tests
  _heuristicClassify: heuristicClassify,
  _detectExplicitOverride: detectExplicitOverride,
  EXPECTED_DURATION_MS,
  VALID_EFFORTS,
  // Override files (for tests to clear between runs)
  _PREFERENCE_FILE: PREFERENCE_FILE,
  _OVERRIDE_FILE: OVERRIDE_FILE,
};
