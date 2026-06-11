/**
 * Failure-mode tests for lib/higgsfield-balance.ts (build order §5, Rule 31).
 * Pure functions (parseAnchor, extractBalance via a re-implementation check is
 * not possible — extractBalance isn't exported; we test through the exported
 * surface) + a READ-ONLY World-B inference against the live DB.
 *
 * Usage: npx tsx scripts/_test-higgsfield-balance.ts
 */
import { readFileSync } from "fs";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
}
// Map the service key into the name lib/supabase expects, before import.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://qvrnuyzfqjrsjljcqbub.supabase.co";

import { parseAnchor, inferBalanceFromLedger } from "../lib/higgsfield-balance";

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

async function main() {
  console.log("— parseAnchor —");
  check("valid", JSON.stringify(parseAnchor("56@2026-06-11T23:00:00Z")) === JSON.stringify({ credits: 56, at: "2026-06-11T23:00:00.000Z" }));
  check("decimal credits", parseAnchor("134.14@2026-06-08T00:00:00Z")?.credits === 134.14);
  check("undefined → null", parseAnchor(undefined) === null);
  check("empty → null", parseAnchor("") === null);
  check("no @ → null", parseAnchor("56-2026") === null);
  check("bad number → null", parseAnchor("abc@2026-06-11T00:00:00Z") === null);
  check("negative → null", parseAnchor("-5@2026-06-11T00:00:00Z") === null);
  check("bad date → null", parseAnchor("56@not-a-date") === null);
  check("@ first char → null", parseAnchor("@2026-06-11T00:00:00Z") === null);

  console.log("— World B inference (read-only, live DB) —");
  // Anchor at June 1: burn = ALL June settled hf_cost_credits. The 2026-06-11
  // reconciliation pinned the recorded June total at 195 (23 settled rows,
  // INCLUDING the evening A/B/C/D arms — verified by full-listing diff after
  // an initial double-count scare). Settled rows are terminal and the sweeper
  // only releases pending→failed (never deletes), so this floor is monotonic:
  const anchor = { credits: 1000, at: "2026-06-01T00:00:00.000Z" };
  const inf = await inferBalanceFromLedger(anchor);
  check("burn > 0", inf.burnSinceAnchor > 0, `burn=${inf.burnSinceAnchor}`);
  check("burn ≥ 195 (recorded June floor, monotonic)", inf.burnSinceAnchor >= 195, `burn=${inf.burnSinceAnchor}`);
  check("balance = anchor − burn", inf.balanceCredits === anchor.credits - inf.burnSinceAnchor);
  // Forward-window anchor → zero burn:
  const future = { credits: 500, at: new Date(Date.now() + 86400_000).toISOString() };
  const inf2 = await inferBalanceFromLedger(future);
  check("future anchor → burn 0", inf2.burnSinceAnchor === 0, `burn=${inf2.burnSinceAnchor}`);
  check("future anchor → balance == anchor", inf2.balanceCredits === 500);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
