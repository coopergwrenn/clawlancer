/**
 * Coverage query for the new reconcile-failure tracking (per CLAUDE.md
 * Rule 27 — every fleet-wide resource needs a 10-second visibility query).
 *
 * Surfaces:
 *   1. Quarantine count (VMs auto-excluded from reconcile-fleet eligibility)
 *   2. Top failing VMs (sorted by consecutive failures desc)
 *   3. Distribution of consecutive_failures across the fleet
 *   4. Most common error patterns (top 5 reconcile_last_error strings)
 *
 * Run any time: `npx tsx scripts/_coverage-reconcile-failures.ts`
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  console.log(`\n=== reconcile-failure coverage — ${new Date().toISOString()} ===\n`);

  // 1. Quarantine count
  const { count: quarantinedCount } = await sb
    .from("instaclaw_vms")
    .select("id", { count: "exact", head: true })
    .not("reconcile_quarantined_at", "is", null);
  console.log(`Quarantined VMs (excluded from reconcile-fleet eligibility): ${quarantinedCount ?? 0}`);

  // 2. Total assigned + healthy + with current failure streak
  const { count: failingCount } = await sb
    .from("instaclaw_vms")
    .select("id", { count: "exact", head: true })
    .gt("reconcile_consecutive_failures", 0);
  console.log(`VMs currently in failure streak (counter > 0):            ${failingCount ?? 0}`);

  // 3. Top failing VMs
  const { data: top } = await sb
    .from("instaclaw_vms")
    .select("name, config_version, reconcile_consecutive_failures, reconcile_first_failure_at, reconcile_quarantined_at, reconcile_last_error")
    .gt("reconcile_consecutive_failures", 0)
    .order("reconcile_consecutive_failures", { ascending: false })
    .limit(20);
  if (top && top.length > 0) {
    console.log(`\nTop ${top.length} VMs by consecutive failures:`);
    for (const v of top) {
      const firstAge = v.reconcile_first_failure_at
        ? `${((Date.now() - new Date(v.reconcile_first_failure_at).getTime()) / 3600000).toFixed(1)}h`
        : "?";
      const quar = v.reconcile_quarantined_at ? " [QUARANTINED]" : "";
      const errSnip = (v.reconcile_last_error ?? "(no error captured)").slice(0, 100).replace(/\n/g, " ");
      console.log(`  ${(v.name ?? "(no name)").padEnd(22)} cv=${String(v.config_version).padStart(3)} streak=${String(v.reconcile_consecutive_failures).padStart(4)} since=${firstAge}${quar}`);
      console.log(`     err: ${errSnip}`);
    }
  }

  // 4. Distribution buckets
  console.log(`\nFailure-streak distribution:`);
  const buckets = [
    { name: "1-2 failures", min: 1, max: 2 },
    { name: "3-5 failures", min: 3, max: 5 },
    { name: "6-9 failures", min: 6, max: 9 },
    { name: "10+ (quarantine)", min: 10, max: 999_999 },
  ];
  for (const b of buckets) {
    const { count } = await sb
      .from("instaclaw_vms")
      .select("id", { count: "exact", head: true })
      .gte("reconcile_consecutive_failures", b.min)
      .lte("reconcile_consecutive_failures", b.max);
    console.log(`  ${b.name.padEnd(20)} ${count ?? 0}`);
  }

  // 5. Most common error patterns (rough — group by first 80 chars)
  if (top && top.length > 0) {
    const errCounts = new Map<string, number>();
    for (const v of top) {
      const key = (v.reconcile_last_error ?? "").slice(0, 80);
      errCounts.set(key, (errCounts.get(key) ?? 0) + 1);
    }
    console.log(`\nTop error-prefix patterns:`);
    [...errCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([err, n]) => console.log(`  (${String(n).padStart(3)}) ${err}`));
  }

  if ((quarantinedCount ?? 0) === 0 && (failingCount ?? 0) === 0) {
    console.log(`\n✓ No reconcile failures tracked. Either fleet is fully healthy OR the migration / counter logic just shipped and counters haven't accumulated yet.`);
  }
}

main().then(() => process.exit(0));
