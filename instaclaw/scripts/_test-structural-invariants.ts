/**
 * Failure-mode test for the structural-invariants guardrail (Rule 31).
 *
 * Proves the check would have caught the actual incidents:
 *   - a zero-caller cleanup fn (the 2026-06-13 deleteVMDNSRecord DNS zone-cap bug)
 *   - an unbounded instaclaw_vms read driving absence-based destruction without
 *     fetchAllOrThrow (the 2026-06-10 reaper that deleted 13 paying VMs)
 * AND that it does NOT false-flag wired / count-asserted / bounded / allowlisted code.
 *
 * Run: npx tsx scripts/_test-structural-invariants.ts   (no network, no DB)
 */
import { scanForViolations, type FileEntry, type Allowlist } from "./_check-structural-invariants";

const EMPTY: Allowlist = { zeroCallerCleanup: [], unboundedDestructiveRead: [] };

let pass = 0,
  fail = 0;
function check(label: string, cond: boolean) {
  if (cond) pass++;
  else {
    fail++;
    console.error(`  ✗ ${label}`);
  }
}
const has = (vs: ReturnType<typeof scanForViolations>, scan: string, key: string) =>
  vs.some((v) => v.scan === scan && v.key === key);

// ── 1. zero-caller cleanup IS flagged (the DNS bug shape) ──
{
  const files: FileEntry[] = [
    { path: "lib/godaddy.ts", content: `export async function deleteVMDNSRecord(vmId: string) { /* ... */ }` },
    { path: "lib/other.ts", content: `export function helper() { return createVMDNSRecord(); }` },
  ];
  const v = scanForViolations(files, EMPTY);
  check("zero-caller cleanup flagged (deleteVMDNSRecord, no callers)", has(v, "zero-caller-cleanup", "deleteVMDNSRecord"));
}

// ── 2. WIRED cleanup is NOT flagged (post-fix state) ──
{
  const files: FileEntry[] = [
    { path: "lib/godaddy.ts", content: `export async function deleteVMDNSRecord(vmId: string) {}` },
    { path: "lib/vm-freeze-thaw.ts", content: `import { deleteVMDNSRecord } from "./godaddy";\nasync function freeze(vm) { await deleteVMDNSRecord(vm.id); }` },
  ];
  const v = scanForViolations(files, EMPTY);
  check("wired cleanup NOT flagged (has a caller)", !has(v, "zero-caller-cleanup", "deleteVMDNSRecord"));
}

// ── 3. allowlisted zero-caller is suppressed ──
{
  const files: FileEntry[] = [{ path: "lib/x.ts", content: `export async function deleteAllVmArchives(id: string) {}` }];
  const allow: Allowlist = { zeroCallerCleanup: [{ name: "deleteAllVmArchives", reason: "dead dup" }], unboundedDestructiveRead: [] };
  check("allowlisted zero-caller suppressed", scanForViolations(files, allow).length === 0);
  check("same fn flagged when NOT allowlisted", has(scanForViolations(files, EMPTY), "zero-caller-cleanup", "deleteAllVmArchives"));
}

// ── 4. unbounded reaper IS flagged (the 13-VM bug shape) ──
{
  const reaper = `
    const { data: dbVms } = await supabase.from("instaclaw_vms").select("id, provider_server_id");
    const known = new Set(dbVms.map(v => v.provider_server_id));
    for (const linode of liveLinodes) {
      if (!known.has(linode.id)) {
        await deleteLinodeInstance(linode.id);          // absence-based destruction
        await supabase.from("instaclaw_vms").update({ status: "terminated" }).eq("id", x);
      }
    }`;
  const v = scanForViolations([{ path: "app/api/cron/reaper/route.ts", content: reaper }], EMPTY);
  check("unbounded reaper flagged (read + Set + destroy, no fetchAllOrThrow)", has(v, "unbounded-destructive-read", "app/api/cron/reaper/route.ts"));
}

// ── 5. same reaper WITH fetchAllOrThrow is NOT flagged (the fix) ──
{
  const fixed = `
    import { fetchAllOrThrow } from "@/lib/complete-set";
    const dbVms = await fetchAllOrThrow(supabase, { table: "instaclaw_vms", columns: "id, provider_server_id" });
    const known = new Set(dbVms.map(v => v.provider_server_id));
    for (const linode of liveLinodes) {
      if (!known.has(linode.id)) { await deleteLinodeInstance(linode.id); }
    }`;
  check("reaper with fetchAllOrThrow NOT flagged", !has(scanForViolations([{ path: "app/api/cron/reaper/route.ts", content: fixed }], EMPTY), "unbounded-destructive-read", "app/api/cron/reaper/route.ts"));
}

// ── 6. BOUNDED read (.single) + destroy + set is NOT flagged ──
{
  const bounded = `
    const { data: vm } = await supabase.from("instaclaw_vms").select("*").eq("id", vmId).single();
    const seen = new Set();
    if (vm) await deleteLinodeInstance(vm.provider_server_id); // single-row, not absence-based`;
  check("bounded single-row read NOT flagged", !has(scanForViolations([{ path: "app/api/x/route.ts", content: bounded }], EMPTY), "unbounded-destructive-read", "app/api/x/route.ts"));
}

// ── 7. allowlisted unbounded-destructive file suppressed (health-check case) ──
{
  const f = `const { data } = await supabase.from("instaclaw_vms").select("id, status");\nconst s = new Set();\nawait supabase.from("instaclaw_vms").update({ status: "terminated" }).eq("id", x);`;
  const files = [{ path: "app/api/cron/health-check/route.ts", content: f }];
  const allow: Allowlist = { zeroCallerCleanup: [], unboundedDestructiveRead: [{ path: "app/api/cron/health-check/route.ts", reason: "verified per-VM-state-driven" }] };
  check("allowlisted unbounded-destructive suppressed", scanForViolations(files, allow).length === 0);
  check("same file flagged when NOT allowlisted", has(scanForViolations(files, EMPTY), "unbounded-destructive-read", "app/api/cron/health-check/route.ts"));
}

// ── 8. an unbounded read with NO destroy + NO set is NOT flagged (benign coverage-gap read) ──
{
  const benign = `const { data } = await supabase.from("instaclaw_vms").select("id, name").eq("status", "ready");\nfor (const vm of data) console.log(vm.name);`;
  check("benign unbounded read (no destroy/set) NOT flagged", scanForViolations([{ path: "app/api/list/route.ts", content: benign }], EMPTY).length === 0);
}

console.log(`\nstructural-invariants guardrail test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log("✓ guardrail catches both incident shapes (DNS zero-caller, reaper unbounded) and doesn't false-flag safe code");
