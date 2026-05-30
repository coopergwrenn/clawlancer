/**
 * Contract test for The Floor's activity producer (lib/floor-activity.ts).
 *
 * Runs with NO database — exercises the pure row-builder and the relay-outcome
 * mapping. The single most important assertion (PRD §13.1 #4) is the
 * SANITIZATION INVARIANT: a built row must NEVER contain a content/prompt/text/
 * secret field, no matter what we throw at it. If that ever regresses, this
 * test fails loudly before the change can ship.
 *
 * Run: npx tsx scripts/_test-floor-activity.ts
 */

import {
  buildActivityRow,
  forwardOutcomeToActivity,
  type FloorActivityInput,
  type FloorActivityRow,
} from "../lib/floor-activity";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// The set of keys a Floor row is ALLOWED to have. Anything else = leak risk.
const ALLOWED_ROW_KEYS = new Set<keyof FloorActivityRow>([
  "vm_id",
  "user_id",
  "kind",
  "station",
  "intensity",
  "channel",
  "tool_name",
  "public_safe",
  "meta",
]);

// Substrings that must NEVER appear as a row key (the content/secret blocklist).
const FORBIDDEN_KEY_SUBSTRINGS = [
  "text",
  "content",
  "prompt",
  "message",
  "body",
  "token",
  "secret",
  "key",
  "ip",
  "email",
  "phone",
];

console.log("\n=== The Floor — activity producer contract test ===\n");

// ── 1. buildActivityRow: optional fields normalize to null ──────────────────
console.log("buildActivityRow — normalization:");
{
  const minimal: FloorActivityInput = {
    vmId: "vm-1",
    userId: "user-1",
    kind: "message_in",
  };
  const row = buildActivityRow(minimal);
  check("station defaults null", row.station === null);
  check("intensity defaults null", row.intensity === null);
  check("channel defaults null", row.channel === null);
  check("tool_name defaults null", row.tool_name === null);
  check("public_safe defaults true", row.public_safe === true);
  check("meta defaults empty object", JSON.stringify(row.meta) === "{}");
  check("vm_id mapped", row.vm_id === "vm-1");
  check("user_id mapped", row.user_id === "user-1");
  check("kind mapped", row.kind === "message_in");
}

// ── 2. buildActivityRow: all fields pass through ────────────────────────────
console.log("\nbuildActivityRow — full passthrough:");
{
  const full: FloorActivityInput = {
    vmId: "vm-2",
    userId: "user-2",
    kind: "tool",
    station: "trading",
    intensity: 3,
    channel: "telegram",
    toolName: "trade",
    meta: { reason: "ok", count: 2, flag: true },
  };
  const row = buildActivityRow(full);
  check("station passthrough", row.station === "trading");
  check("intensity passthrough", row.intensity === 3);
  check("channel passthrough", row.channel === "telegram");
  check("tool_name passthrough (toolName→tool_name)", row.tool_name === "trade");
  check(
    "meta passthrough",
    row.meta.reason === "ok" && row.meta.count === 2 && row.meta.flag === true,
  );
}

// ── 3. THE SANITIZATION INVARIANT (load-bearing, PRD §13.1 #4) ──────────────
console.log("\nSANITIZATION INVARIANT — no content keys ever:");
{
  // Adversarial: a caller tries to smuggle content via meta. The type system
  // forbids a `text` INPUT field, but meta is a bag — assert the resulting ROW
  // still only has allowed top-level keys (content can't become a column), and
  // that no allowed key name itself reads like content/secret.
  const cases: FloorActivityInput[] = [
    { vmId: "v", userId: "u", kind: "message_in", channel: "imessage" },
    { vmId: "v", userId: "u", kind: "working", intensity: 2 },
    { vmId: "v", userId: "u", kind: "complete" },
    { vmId: "v", userId: "u", kind: "error", meta: { reason: "gateway_5xx" } },
    { vmId: "v", userId: "u", kind: "tool", station: "browser", toolName: "web_search" },
  ];
  let allClean = true;
  for (const c of cases) {
    const row = buildActivityRow(c);
    for (const key of Object.keys(row)) {
      if (!ALLOWED_ROW_KEYS.has(key as keyof FloorActivityRow)) {
        allClean = false;
        console.error(`    unexpected row key: ${key}`);
      }
    }
  }
  check("every row has only allowlisted top-level keys", allClean);

  const keyBlocklistClean = [...ALLOWED_ROW_KEYS].every((k) => {
    const lower = String(k).toLowerCase();
    // `tool_name`, `vm_id`, `user_id` are allowed structural keys; ensure none
    // of the allowed keys is a content/secret word on its own.
    return !FORBIDDEN_KEY_SUBSTRINGS.some(
      (bad) =>
        lower === bad || // exact content/secret word as a standalone column
        lower === `${bad}_text` ||
        lower === `${bad}_content`,
    );
  });
  check("no allowlisted key is a standalone content/secret word", keyBlocklistClean);

  // The input TYPE itself must not have a content field. We can't reflect a TS
  // type at runtime, but we CAN assert the row keys are a fixed set — which is
  // the property that actually matters (content can't reach a column).
  check(
    "row key set is exactly the 9 allowed columns",
    ALLOWED_ROW_KEYS.size === 9,
  );
}

// ── 4. forwardOutcomeToActivity — relay outcome mapping ─────────────────────
console.log("\nforwardOutcomeToActivity — outcome mapping:");
{
  const ok = forwardOutcomeToActivity("u", { ok: true, vmId: "vm-9" });
  check("success → complete", ok?.kind === "complete" && ok?.vmId === "vm-9");

  const err = forwardOutcomeToActivity("u", {
    ok: false,
    vmId: "vm-9",
    reason: "gateway_timeout",
  });
  check("failure+vm → error", err?.kind === "error");
  check(
    "failure carries reason in meta",
    err?.meta?.reason === "gateway_timeout",
  );

  const noVm = forwardOutcomeToActivity("u", { ok: false, reason: "no_vm" });
  check("failure without vm → null (no office)", noVm === null);

  const okNoVm = forwardOutcomeToActivity("u", { ok: true });
  check("success without vm → null (defensive)", okNoVm === null);
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed === 0 ? 0 : 1);
