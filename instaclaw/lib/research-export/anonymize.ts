/**
 * EE26 Research Data Anonymization Utilities
 *
 * Two responsibilities:
 *   1. One-way hash agent identifiers (Bankr wallet → opaque agent_id)
 *   2. PII regex sweep on free-text fields (interests, goals, notes, etc.)
 *
 * Both run at export time. Raw wallet addresses and unfiltered free text
 * never leave InstaClaw infrastructure.
 *
 * See PRD section 4.10.3 for the privacy commitment.
 *
 * Design decisions:
 *
 * - Hash uses HMAC-SHA-256(wallet, salt) truncated to 16 hex chars (64 bits).
 *   64 bits is enough collision resistance for 1,000–10,000 agents while
 *   keeping the output short and human-scannable. HMAC (vs raw SHA-256)
 *   prevents length-extension attacks and is the standard primitive for
 *   keyed hashing.
 *
 * - Salt is read from env (EDGE_CITY_RESEARCH_SALT). Held only by InstaClaw,
 *   rotated post-village. New salt = new pseudonyms; old exports
 *   re-identifiable only with the OLD salt (which is destroyed on rotation).
 *
 * - PII sweep replaces matches with `<REDACTED:reason>` and logs the
 *   match (with row id, field name, regex name, but NOT the matched text)
 *   to a per-export review file. Per PRD: "regex sweep + manual spot-check
 *   on 1% sample".
 *
 * - Cross-table consistency: same wallet → same hashed agent_id every
 *   call within a single export run, since the salt is constant.
 *
 * Run tests: `npx tsx instaclaw/lib/research-export/__tests__/anonymize.test.ts`
 */

import * as crypto from "node:crypto";

// ─── Hashing ─────────────────────────────────────────────────────────

/**
 * Hash a Bankr wallet address into an opaque agent_id for research export.
 *
 * Returns a 16-character lowercase hex string. Deterministic for a given
 * (wallet, salt) pair. Cannot be reversed without the salt.
 *
 * @throws if wallet or salt is empty / not a string
 */
export function hashAgentId(wallet: string, salt: string): string {
  if (typeof wallet !== "string" || wallet.length === 0) {
    throw new Error("hashAgentId: wallet must be a non-empty string");
  }
  if (typeof salt !== "string" || salt.length === 0) {
    throw new Error("hashAgentId: salt must be a non-empty string");
  }
  // Normalize: lowercase, trimmed. Bankr wallets are case-insensitive 0x-hex.
  const normalized = wallet.trim().toLowerCase();
  return crypto.createHmac("sha256", salt).update(normalized).digest("hex").slice(0, 16);
}

/**
 * Validate that a salt looks like a real production salt — minimum entropy.
 * Catches `EDGE_CITY_RESEARCH_SALT=test` mistakes in prod.
 */
export function validateSalt(salt: string | undefined): asserts salt is string {
  if (!salt) {
    throw new Error(
      "EDGE_CITY_RESEARCH_SALT is not set. Generate one with " +
        "`openssl rand -hex 32` and set it as an env var. " +
        "This salt is held only by InstaClaw and rotated post-village."
    );
  }
  if (salt.length < 32) {
    throw new Error(
      `EDGE_CITY_RESEARCH_SALT is too short (${salt.length} chars; min 32). ` +
        "Use `openssl rand -hex 32` for a 64-char salt."
    );
  }
  if (/^(test|dev|local|staging|fake)/i.test(salt)) {
    throw new Error(
      `EDGE_CITY_RESEARCH_SALT looks like a placeholder ("${salt.slice(0, 10)}..."). ` +
        "Production salt must be cryptographically random."
    );
  }
}

// ─── PII regex sweep ─────────────────────────────────────────────────

export interface PiiRule {
  name: string;
  pattern: RegExp;
  /** Why we redact — appears in the redaction marker for spot-checks. */
  reason: "email" | "phone" | "wallet" | "ip" | "address" | "ssn";
}

/**
 * Default PII rules. Tuned for free-text "interests/goals/notes" fields
 * that are mostly tags but might contain accidental contact info.
 *
 * IMPORTANT: name redaction is NOT included in the default rules. Names
 * are too high-recall to regex (would shred legitimate text) and too
 * high-stakes to leave as-is. The strategy for names is:
 *   - At write time, agents are instructed not to write counterparty
 *     names into free-text fields (they go in structured columns only).
 *   - At export time, we run the 1% manual spot-check on a sample of
 *     redacted output specifically looking for missed names.
 *
 * Add `addressRule` if you have a specific known-bad address pattern in
 * your data. Default street-address regex is too noisy.
 */
// Ordering matters: more specific rules run first, since each rule replaces
// matches with `<REDACTED:reason>` and a later greedy rule could otherwise
// chew up parts of a wallet / SSN / IP / email and leave the specific rule
// nothing to match. Phone (the greediest) runs last.
export const DEFAULT_PII_RULES: PiiRule[] = [
  // Bankr wallets / EVM addresses (0x + 40 hex). Most specific shape.
  {
    name: "evm-wallet",
    pattern: /\b0x[a-fA-F0-9]{40}\b/g,
    reason: "wallet",
  },
  // Solana wallets (base58, 32-44 chars, surrounded by word boundaries)
  {
    name: "solana-wallet",
    pattern: /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g,
    reason: "wallet",
  },
  // Emails: any RFC-ish pattern
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    reason: "email",
  },
  // US SSN-shaped numbers — must run before phone since SSN uses `-` separators
  {
    name: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    reason: "ssn",
  },
  // IPv4 addresses — must run before phone since phone allows dots
  {
    name: "ipv4",
    pattern: /\b(?:25[0-5]|2[0-4]\d|[01]?\d\d?)(?:\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)){3}\b/g,
    reason: "ip",
  },
  // Phone: international and US formats. Permissive on separators.
  // Runs LAST because it's the greediest — any leftover digit-with-separators
  // pattern that wasn't matched by a more specific rule above gets redacted here.
  {
    name: "phone-intl",
    pattern: /\+?\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{2,4}[\s.-]?\d{2,4}(?:[\s.-]?\d{2,4})?/g,
    reason: "phone",
  },
];

export interface RedactionEvent {
  /** Identifier for the row (e.g., signal_id) — for the review log. */
  rowId: string | null;
  /** Which column was being scanned. */
  column: string;
  /** Which rule matched. */
  ruleName: string;
  /** Reason category (becomes part of the redaction marker). */
  reason: PiiRule["reason"];
  /**
   * Position in the input string where the match started. Useful for
   * spot-check sampling. NOT the matched text itself — we never log raw PII.
   */
  matchOffset: number;
  /** Length of the redacted span (also for spot-check sampling). */
  matchLength: number;
}

export interface SweepResult<T> {
  /** The cleaned value with `<REDACTED:reason>` markers. */
  cleaned: T;
  /** Events that occurred during the sweep — log to review file. */
  events: RedactionEvent[];
}

/**
 * Run the PII sweep on a single string. Returns the redacted string
 * plus a list of redaction events.
 */
export function sweepString(
  input: string,
  ctx: { rowId: string | null; column: string },
  rules: PiiRule[] = DEFAULT_PII_RULES
): SweepResult<string> {
  if (typeof input !== "string") {
    return { cleaned: input, events: [] };
  }

  const events: RedactionEvent[] = [];
  let cleaned = input;

  for (const rule of rules) {
    // Re-execute the regex against the CURRENT cleaned string so events
    // record offsets in the post-redaction text. Reset lastIndex for each
    // rule (important for /g regexes).
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    cleaned = cleaned.replace(re, (match, offset: number) => {
      events.push({
        rowId: ctx.rowId,
        column: ctx.column,
        ruleName: rule.name,
        reason: rule.reason,
        matchOffset: offset,
        matchLength: match.length,
      });
      return `<REDACTED:${rule.reason}>`;
    });
  }

  return { cleaned, events };
}

/**
 * Run the PII sweep on an array of strings. Returns the array with each
 * element redacted, plus the union of all redaction events.
 *
 * Used for TEXT[] columns (interests, goals, looking_for).
 */
export function sweepStringArray(
  input: string[] | null | undefined,
  ctx: { rowId: string | null; column: string },
  rules: PiiRule[] = DEFAULT_PII_RULES
): SweepResult<string[]> {
  if (!Array.isArray(input)) {
    return { cleaned: input ?? [], events: [] };
  }
  const allEvents: RedactionEvent[] = [];
  const cleaned = input.map((item, i) => {
    const r = sweepString(item, { rowId: ctx.rowId, column: `${ctx.column}[${i}]` }, rules);
    allEvents.push(...r.events);
    return r.cleaned;
  });
  return { cleaned, events: allEvents };
}
