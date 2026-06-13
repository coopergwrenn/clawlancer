/**
 * Failure-mode test for the DNS zone GC classification predicate (Rule 31).
 *
 * Proves the load-bearing safety invariant directly:
 *   - a RETIRED VM's record IS prunable
 *   - an ASSIGNED VM's record is NEVER prunable (incl. hibernating/suspended
 *     sleep states, which carry status='assigned')
 *   - a no-DB-row orphan IS prunable
 *
 * Run: npx tsx scripts/_test-dns-zone-gc.ts   (no network, no DB)
 */
import { isRecordPrunable, RETIRED_STATUSES } from "../app/api/cron/dns-zone-gc/route";

let pass = 0,
  fail = 0;
function check(label: string, got: boolean, want: boolean) {
  if (got === want) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${label}: got ${got}, want ${want}`);
  }
}

// ── PRUNABLE: retired statuses + no-db-row ──
check("terminated → prune", isRecordPrunable("terminated"), true);
check("failed → prune", isRecordPrunable("failed"), true);
check("frozen → prune", isRecordPrunable("frozen"), true);
check("destroyed → prune", isRecordPrunable("destroyed"), true);
check("no-db-row (undefined) → prune", isRecordPrunable(undefined), true);

// ── KEEP: assigned + sleep states + pre-retire active states ──
// The load-bearing "never delete a live VM's record" cases.
check("assigned → KEEP", isRecordPrunable("assigned"), false);
check("ready → KEEP", isRecordPrunable("ready"), false);
check("provisioning → KEEP", isRecordPrunable("provisioning"), false);
// hibernating/suspended VMs carry status='assigned' (health_status holds the
// sleep state), so they're kept by the 'assigned' case — but assert the
// intent explicitly so a future status-model change can't silently break it.
check("assigned (hibernating sleep) → KEEP", isRecordPrunable("assigned"), false);
check("assigned (suspended sleep) → KEEP", isRecordPrunable("assigned"), false);

// ── Guard: an unknown/new status defaults to KEEP (fail-safe — only the
// explicit retired set is ever pruned). ──
check("unknown status → KEEP (fail-safe)", isRecordPrunable("some_new_state"), false);
check("empty string → KEEP (fail-safe)", isRecordPrunable(""), false);

// ── Discrimination on a synthetic zone: retired pruned, assigned survives ──
const vmById = new Map<string, string>([
  ["live-1", "assigned"],
  ["live-2", "assigned"], // hibernating sleep → status=assigned
  ["dead-1", "terminated"],
  ["dead-2", "frozen"],
  ["dead-3", "failed"],
]);
const records = [
  "live-1.vm",
  "live-2.vm",
  "dead-1.vm",
  "dead-2.vm",
  "dead-3.vm",
  "orphan-norow.vm", // no entry in vmById → undefined → prune
];
const pruned = records.filter((r) => isRecordPrunable(vmById.get(r.replace(/\.vm$/, ""))));
const kept = records.filter((r) => !isRecordPrunable(vmById.get(r.replace(/\.vm$/, ""))));
check("synthetic: 4 pruned (3 retired + 1 orphan)", pruned.length === 4, true);
check("synthetic: 2 kept (both assigned)", kept.length === 2, true);
check("synthetic: live-1 survives", kept.includes("live-1.vm"), true);
check("synthetic: live-2 (sleep) survives", kept.includes("live-2.vm"), true);
check("synthetic: dead-1 pruned", pruned.includes("dead-1.vm"), true);

// Sanity: the retired set is exactly the four terminal statuses.
check("RETIRED_STATUSES size == 4", RETIRED_STATUSES.size === 4, true);

console.log(`\nDNS zone GC classification test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log("✓ retired records prune; assigned (incl. sleep) records never do");
