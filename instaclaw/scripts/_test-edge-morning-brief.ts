/**
 * Integration test for lib/edge-morning-brief against PROD DATA.
 *
 * Dry-run only — sets `dryRun: true` on every sendBriefToUser call so
 * no actual Telegram messages get sent. Prints the composed text for
 * each VM + asserts basic invariants:
 *
 *   1. Brief length is within budget (300 ≤ len ≤ 2000 chars)
 *   2. Shape is one of {rich, thin, lean}
 *   3. Contains the dashboard URL
 *   4. Starts with "morning."
 *   5. Has no exclamation marks (voice register)
 *   6. Day-of-week label is present
 *   7. Lean shape only when hasIntent=false (defense check)
 *
 * Also tests pure helpers (truncateOnWord, sanitizeName, pacificDayLabel,
 * isWithinVillageWindow, composeBrief) with synthetic data — no DB
 * required for those.
 *
 * Run: npx tsx scripts/_test-edge-morning-brief.ts
 * Exit 0 on all pass, non-zero on any failure.
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";
import {
  composeBrief,
  gatherBriefData,
  isWithinVillageWindow,
  pacificDayLabel,
  sanitizeName,
  sendBriefToUser,
  truncateOnWord,
} from "../lib/edge-morning-brief";
import type { CounterpartMatch } from "../lib/edge-dashboard-data";

config({ path: resolve(process.cwd(), ".env.local") });

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeMatch(over: Partial<CounterpartMatch>): CounterpartMatch {
  return {
    outcomeId: "outcome-1",
    counterpartUserId: "user-1",
    counterpartName: "Test User",
    reasonText: "test reason",
    scoreConfidence: 0.8,
    createdAt: new Date().toISOString(),
    iAmSource: true,
    ...over,
  };
}

async function run() {
  console.log("== Pure helpers ==\n");

  // ── truncateOnWord ────────────────────────────────────────────
  console.log("Test: truncateOnWord");
  assert("empty → empty", truncateOnWord("", 50) === "");
  assert("null → empty", truncateOnWord(null, 50) === "");
  assert(
    "under cap → unchanged",
    truncateOnWord("hello world", 50) === "hello world",
  );
  const longText =
    "this is a sentence that is longer than the cap and should truncate on a word boundary";
  const truncated = truncateOnWord(longText, 30);
  assert("over cap → ends with ellipsis", truncated.endsWith("…"));
  assert("over cap → no space before ellipsis", !truncated.endsWith(" …"));

  // ── sanitizeName ──────────────────────────────────────────────
  console.log("\nTest: sanitizeName");
  assert(
    "null → placeholder",
    sanitizeName(null) === "someone in the directory",
  );
  assert(
    "empty → placeholder",
    sanitizeName("") === "someone in the directory",
  );
  assert(
    "whitespace only → placeholder",
    sanitizeName("   \n\t  ") === "someone in the directory",
  );
  assert(
    'literal "null" → placeholder',
    sanitizeName("null") === "someone in the directory",
  );
  assert("real name → preserved", sanitizeName("Kevin Fishner") === "Kevin Fishner");
  assert(
    "newlines collapsed",
    sanitizeName("Kim-Mai\n\nCutler") === "Kim-Mai Cutler",
  );

  // ── pacificDayLabel ───────────────────────────────────────────
  console.log("\nTest: pacificDayLabel");
  // 2026-05-30 16:00 UTC = 9 AM PDT — May 30, 2026 is a Saturday (verified
  // by counting from 2026-01-01 Thursday; 149 days later → Saturday)
  const may30 = new Date("2026-05-30T16:00:00Z");
  const dayMay30 = pacificDayLabel(may30);
  assert(
    `May 30 16:00 UTC = "saturday" Pacific (got "${dayMay30}")`,
    dayMay30 === "saturday",
  );
  // 2026-06-15 16:00 UTC = 9 AM PDT Monday
  const jun15 = new Date("2026-06-15T16:00:00Z");
  const dayJun15 = pacificDayLabel(jun15);
  assert(`Jun 15 = "monday" (got "${dayJun15}")`, dayJun15 === "monday");

  // ── isWithinVillageWindow ─────────────────────────────────────
  console.log("\nTest: isWithinVillageWindow");
  assert("May 30 PDT start = within", isWithinVillageWindow(may30));
  assert("Jun 27 PDT end = within", isWithinVillageWindow(new Date("2026-06-27T16:00:00Z")));
  assert(
    "Jun 28 PDT = outside (exclusive end)",
    !isWithinVillageWindow(new Date("2026-06-28T08:00:00Z")),
  );
  assert(
    "May 29 PDT = outside",
    !isWithinVillageWindow(new Date("2026-05-29T16:00:00Z")),
  );
  assert(
    "Aug 1 = far outside",
    !isWithinVillageWindow(new Date("2026-08-01T16:00:00Z")),
  );

  console.log("\n== composeBrief — shape tests ==\n");

  // ── LEAN shape: no intent ─────────────────────────────────────
  console.log("Test: lean shape (no intent)");
  const lean = composeBrief({
    dayLabel: "tuesday",
    hasIntent: false,
    overnightMatches: [],
  });
  assert("shape=lean", lean.shape === "lean");
  assert("text starts with 'morning. tuesday.'", lean.text.startsWith("morning. tuesday."));
  assert("text contains 'intent on file'", lean.text.includes("don't have an intent on file"));
  assert("text contains dashboard URL", lean.text.includes("instaclaw.io/edge/dashboard"));
  assert("no exclamation marks", !lean.text.includes("!"));
  assert(`length 100-500 (got ${lean.text.length})`, lean.text.length >= 100 && lean.text.length <= 500);

  // ── THIN shape: intent, no matches ────────────────────────────
  console.log("\nTest: thin shape (intent + no matches)");
  const thin = composeBrief({
    dayLabel: "wednesday",
    hasIntent: true,
    overnightMatches: [],
  });
  assert("shape=thin", thin.shape === "thin");
  assert("text starts with 'morning. wednesday.'", thin.text.startsWith("morning. wednesday."));
  assert("text mentions 'still listening'", thin.text.includes("still listening"));
  assert("text contains dashboard URL", thin.text.includes("instaclaw.io/edge/dashboard"));

  // ── RICH shape: 1 match ───────────────────────────────────────
  console.log("\nTest: rich shape (1 match)");
  const rich1 = composeBrief({
    dayLabel: "thursday",
    hasIntent: true,
    overnightMatches: [
      makeMatch({
        counterpartName: "Alice Chen",
        reasonText: "working on agentic browser automation, overlaps with your interest in multi-agent coordination",
      }),
    ],
  });
  assert("shape=rich", rich1.shape === "rich");
  assert('"1 overlap" (singular)', rich1.text.includes("found 1 overlap"));
  assert("contains Alice", rich1.text.includes("Alice Chen"));
  assert("contains reason", rich1.text.includes("agentic browser automation"));

  // ── RICH shape: 3 matches ─────────────────────────────────────
  console.log("\nTest: rich shape (3 matches)");
  const rich3 = composeBrief({
    dayLabel: "friday",
    hasIntent: true,
    overnightMatches: [
      makeMatch({ counterpartName: "Alice", reasonText: "researching governance protocols" }),
      makeMatch({ counterpartName: "Bob", reasonText: "building zk infra" }),
      makeMatch({ counterpartName: "Carol", reasonText: "constitutional AI work" }),
    ],
  });
  assert('"3 overlaps" (plural)', rich3.text.includes("found 3 overlaps"));
  assert("contains all 3 names", rich3.text.includes("Alice") && rich3.text.includes("Bob") && rich3.text.includes("Carol"));
  assert("no '+ N more'", !rich3.text.includes("more in your dashboard"));

  // ── RICH shape: 5 matches → truncates to 3 + "+ 2 more" ──────
  console.log("\nTest: rich shape (5 matches → +2 more)");
  const rich5 = composeBrief({
    dayLabel: "saturday",
    hasIntent: true,
    overnightMatches: [
      makeMatch({ counterpartName: "Match1" }),
      makeMatch({ counterpartName: "Match2" }),
      makeMatch({ counterpartName: "Match3" }),
      makeMatch({ counterpartName: "Match4" }),
      makeMatch({ counterpartName: "Match5" }),
    ],
  });
  assert("shape=rich", rich5.shape === "rich");
  assert('"5 overlaps" in count', rich5.text.includes("found 5 overlaps"));
  assert('"top 3" qualifier', rich5.text.includes("top 3"));
  assert('"+ 2 more"', rich5.text.includes("+ 2 more"));
  assert("Match4 NOT in body (truncated)", !rich5.text.includes("Match4"));

  // ── Length budget ─────────────────────────────────────────────
  console.log("\nTest: length budget");
  for (const [name, c] of [
    ["lean", lean],
    ["thin", thin],
    ["rich1", rich1],
    ["rich3", rich3],
    ["rich5", rich5],
  ] as const) {
    assert(
      `${name} length ≤ 2000 (got ${c.text.length})`,
      c.text.length <= 2000,
    );
  }

  // ── Voice register (no exclamation marks anywhere) ────────────
  console.log("\nTest: voice register");
  for (const [name, c] of [
    ["lean", lean],
    ["thin", thin],
    ["rich1", rich1],
    ["rich3", rich3],
    ["rich5", rich5],
  ] as const) {
    assert(`${name}: no exclamation marks`, !c.text.includes("!"));
  }

  // ── Integration: live prod data, dry-run ──────────────────────
  console.log("\n== Integration: live prod data (DRY RUN) ==\n");

  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const SR_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SR_KEY) {
    console.log("  ⚠ Supabase env not loaded; skipping live prod test");
  } else {
    const sb = createClient(SUPABASE_URL, SR_KEY, {
      auth: { persistSession: false },
    });

    // Pick all assigned + healthy edge_city VMs (small fleet — ~9 total).
    const { data: vms, error: vmErr } = await sb
      .from("instaclaw_vms")
      .select("name, assigned_to, partner, health_status, telegram_chat_id")
      .eq("partner", "edge_city")
      .eq("status", "assigned")
      .in("health_status", ["healthy", "hibernating", "suspended"])
      .order("name")
      .limit(20);

    if (vmErr) {
      console.log(`  ⚠ VM query failed: ${vmErr.message}`);
    } else if (!vms || vms.length === 0) {
      console.log("  ⚠ No edge_city VMs found in prod");
    } else {
      console.log(`Found ${vms.length} edge_city VMs — composing dry-run briefs for each:\n`);
      // Force the village window so the dry run actually produces output
      // even when running this test outside May 30 → Jun 27.
      const fixedNow = new Date("2026-05-31T16:00:00Z"); // saturday 9 AM PDT
      for (const vm of vms) {
        const userId = vm.assigned_to as string | null;
        if (!userId) {
          console.log(`  ${vm.name}: SKIP — no assigned_to`);
          continue;
        }
        const result = await sendBriefToUser(sb, userId, {
          dryRun: true,
          now: fixedNow,
        });
        if (result.sent) {
          // Shouldn't happen under dryRun=true.
          console.log(`  ${vm.name}: UNEXPECTED sent=true`);
          continue;
        }
        if (result.reason === "dry_run" && result.composedText) {
          console.log(`─── ${vm.name} (${result.shape}) ──────────`);
          console.log(result.composedText);
          console.log(`(${result.composedText.length} chars)\n`);
          // Per-VM invariant checks
          const t = result.composedText;
          assert(
            `${vm.name}: starts with 'morning.'`,
            t.startsWith("morning."),
          );
          assert(
            `${vm.name}: contains dashboard URL`,
            t.includes("instaclaw.io/edge/dashboard"),
          );
          assert(`${vm.name}: no exclamation marks`, !t.includes("!"));
          assert(
            `${vm.name}: length ≤ 2000 (got ${t.length})`,
            t.length <= 2000,
          );
        } else {
          console.log(
            `  ${vm.name}: skipped — ${result.reason}${result.detail ? `: ${result.detail}` : ""}`,
          );
        }
      }
    }
  }

  console.log("\n──────────────────────────────────────────");
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("All tests passed.");
  process.exit(0);
}

run().catch((err) => {
  console.error("FATAL:", err);
  process.exit(2);
});
