/**
 * Unit tests for anonymize.ts
 *
 * Run: npx tsx instaclaw/lib/research-export/__tests__/anonymize.test.ts
 *
 * Self-contained, no test framework. Exits non-zero on first failure.
 */

import {
  hashAgentId,
  validateSalt,
  sweepString,
  sweepStringArray,
  DEFAULT_PII_RULES,
} from "../anonymize";

let failures = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${detail !== undefined ? "  →  " + JSON.stringify(detail) : ""}`);
    failures++;
  }
}

function shouldThrow(label: string, fn: () => unknown, matcher?: (e: unknown) => boolean): void {
  try {
    fn();
    check(label, false, "did not throw");
  } catch (e) {
    if (matcher && !matcher(e)) {
      check(label, false, `wrong error: ${(e as Error).message}`);
    } else {
      check(label, true);
    }
  }
}

const VALID_SALT = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

console.log("\n# hashAgentId");

check(
  "produces 16-char hex",
  /^[0-9a-f]{16}$/.test(hashAgentId("0xabcdef0123456789abcdef0123456789abcdef01", VALID_SALT))
);

check(
  "deterministic for same wallet+salt",
  hashAgentId("0xWALLET", VALID_SALT) === hashAgentId("0xWALLET", VALID_SALT)
);

check(
  "case-insensitive wallet input (Bankr is lowercase canonical)",
  hashAgentId("0xABCDEF", VALID_SALT) === hashAgentId("0xabcdef", VALID_SALT)
);

check(
  "trims whitespace",
  hashAgentId("  0xabc  ", VALID_SALT) === hashAgentId("0xabc", VALID_SALT)
);

check(
  "different wallets produce different ids",
  hashAgentId("0xWALLET_A", VALID_SALT) !== hashAgentId("0xWALLET_B", VALID_SALT)
);

check(
  "different salts produce different ids (the salt-rotation property)",
  hashAgentId("0xWALLET", VALID_SALT) !==
    hashAgentId("0xWALLET", VALID_SALT.replace(/0/g, "1"))
);

shouldThrow("rejects empty wallet", () => hashAgentId("", VALID_SALT));
shouldThrow("rejects empty salt", () => hashAgentId("0xabc", ""));
shouldThrow(
  "rejects non-string wallet",
  () => hashAgentId(null as unknown as string, VALID_SALT)
);

console.log("\n# validateSalt");

shouldThrow("rejects undefined", () => validateSalt(undefined));
shouldThrow("rejects empty", () => validateSalt(""));
shouldThrow("rejects too-short salt (<32 chars)", () => validateSalt("abcd"));
shouldThrow("rejects 'test' prefix placeholder", () =>
  validateSalt("test" + "x".repeat(60))
);
shouldThrow("rejects 'staging' prefix placeholder", () =>
  validateSalt("staging" + "x".repeat(60))
);

check(
  "accepts a 64-char random hex (typical openssl rand -hex 32 output)",
  (() => {
    try {
      validateSalt(VALID_SALT);
      return true;
    } catch {
      return false;
    }
  })()
);

console.log("\n# sweepString — emails");

const e1 = sweepString(
  "Contact me at alice@example.com or 0xabc",
  { rowId: "r1", column: "interests" }
);
check(
  "redacts email",
  e1.cleaned === "Contact me at <REDACTED:email> or 0xabc"
);
check("logs one redaction event for email", e1.events.length === 1);
check(
  "event has correct metadata",
  e1.events[0].column === "interests" &&
    e1.events[0].reason === "email" &&
    e1.events[0].rowId === "r1"
);

console.log("\n# sweepString — phone numbers");

const p1 = sweepString(
  "Call +1 (415) 555-1234 anytime",
  { rowId: "r2", column: "goals" }
);
check(
  "redacts US phone with country code",
  p1.cleaned.includes("<REDACTED:phone>") && !p1.cleaned.includes("415")
);

const p2 = sweepString(
  "International: +44 20 7946 0958",
  { rowId: "r3", column: "goals" }
);
check("redacts intl phone", p2.cleaned.includes("<REDACTED:phone>"));

console.log("\n# sweepString — wallets");

const w1 = sweepString(
  "My wallet is 0xAbCdEf0123456789aBcDef0123456789AbCdEf01 — DM me",
  { rowId: "r4", column: "notes" }
);
check("redacts EVM wallet", w1.cleaned.includes("<REDACTED:wallet>"));
check(
  "wallet redaction reason recorded correctly",
  w1.events.some((e) => e.reason === "wallet" && e.ruleName === "evm-wallet")
);

const w2 = sweepString(
  "Sol address: 7gT3uRBnFp9pV3pH6cV3qJZ5HQqKHQqKHQqKHQqK",
  { rowId: "r5", column: "notes" }
);
check("redacts Solana-shaped wallet", w2.cleaned.includes("<REDACTED:wallet>"));

console.log("\n# sweepString — IPv4 + SSN");

const ip = sweepString("Host at 192.168.1.1 fails", { rowId: "r6", column: "notes" });
check("redacts IPv4", ip.cleaned.includes("<REDACTED:ip>"));

const ssn = sweepString("Tax id 123-45-6789", { rowId: "r7", column: "notes" });
check("redacts SSN", ssn.cleaned.includes("<REDACTED:ssn>"));

console.log("\n# sweepString — clean text passes through");

const clean = sweepString(
  "Looking to chat about agents, governance, and biotech",
  { rowId: "r8", column: "interests" }
);
check(
  "no events on clean text",
  clean.events.length === 0 && clean.cleaned === "Looking to chat about agents, governance, and biotech"
);

console.log("\n# sweepString — multiple matches in one string");

const multi = sweepString(
  "DM alice@example.com or bob@example.com",
  { rowId: "r9", column: "notes" }
);
check(
  "redacts both emails",
  multi.cleaned === "DM <REDACTED:email> or <REDACTED:email>" &&
    multi.events.length === 2
);

console.log("\n# sweepStringArray");

const arr = sweepStringArray(
  ["AI agents", "alice@example.com is interested too", "biotech"],
  { rowId: "r10", column: "interests" }
);
check(
  "preserves clean array elements",
  arr.cleaned[0] === "AI agents" && arr.cleaned[2] === "biotech"
);
check(
  "redacts inside array element",
  arr.cleaned[1] === "<REDACTED:email> is interested too"
);
check(
  "event column annotated with array index",
  arr.events.length === 1 && arr.events[0].column === "interests[1]"
);

const emptyArr = sweepStringArray(null, { rowId: "r11", column: "interests" });
check("null array → empty", Array.isArray(emptyArr.cleaned) && emptyArr.cleaned.length === 0);

console.log("\n# event metadata never includes raw PII");

const sensitive = sweepString(
  "alice@example.com 0xabcdef0123456789abcdef0123456789abcdef01",
  { rowId: "r12", column: "notes" }
);
const eventJson = JSON.stringify(sensitive.events);
check(
  "no email substring in event metadata",
  !eventJson.includes("alice") && !eventJson.includes("@example.com")
);
check(
  "no wallet substring in event metadata",
  !eventJson.includes("0xabcdef")
);

console.log("\n# DEFAULT_PII_RULES sanity");

check("includes email rule", DEFAULT_PII_RULES.some((r) => r.name === "email"));
check("includes phone rule", DEFAULT_PII_RULES.some((r) => r.name.startsWith("phone")));
check("includes wallet rule", DEFAULT_PII_RULES.some((r) => r.name.includes("wallet")));

// ─── summary ─────────────────────────────────────────────────────────

if (failures > 0) {
  console.log(`\n❌ ${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log("\n✅ all tests passed");
  process.exit(0);
}
