/**
 * One-shot cleanup (2026-05-09): mark long-dormant suspended/hibernating VMs
 * as health_status='unhealthy' so they can never re-enter the reconcile-fleet
 * cron's eligibility set even if the filter logic regresses.
 *
 * Companion to commits 5e949f0f + 55fce656 which dropped suspended/hibernating
 * from cron eligibility. Those changes alone solve the throughput problem,
 * but they leave the dormant cohort in a 'suspended' state where a future
 * widening of the filter (or a different code path) could pull them back into
 * the queue. Marking them 'unhealthy' is defense in depth — operators must
 * explicitly flip them back to 'healthy' if they're ever revived.
 *
 * Criteria: status='assigned' AND health_status IN ('suspended','hibernating')
 * AND last_health_check < NOW() - INTERVAL '14 days'.
 *
 * 14d threshold rationale: a VM that hasn't been health-checked in 2 weeks is
 * either truly dormant (no user reactivation in sight) or so SSH-degraded
 * that the health-check cron stopped reaching it. Either way, it does not
 * belong in any auto-reconcile queue. Recoverable via manual UPDATE if a
 * paying user later wakes it.
 *
 * Usage:
 *   npx tsx scripts/_oneshot-mark-dormant-unhealthy.ts             # dry-run (default)
 *   npx tsx scripts/_oneshot-mark-dormant-unhealthy.ts --apply     # commit changes
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
]) {
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

const APPLY = process.argv.includes("--apply");
const DAYS_DORMANT = 14;

async function main() {
  const cutoff = new Date(Date.now() - DAYS_DORMANT * 24 * 60 * 60 * 1000).toISOString();

  console.log(`\n=== oneshot-mark-dormant-unhealthy ${APPLY ? "(APPLY)" : "(DRY-RUN)"} ===`);
  console.log(`Cutoff: last_health_check < ${cutoff}`);
  console.log(`Criteria: status=assigned AND health_status IN (suspended, hibernating) AND last_health_check older than ${DAYS_DORMANT}d\n`);

  const { data: candidates, error } = await sb
    .from("instaclaw_vms")
    .select("id, name, health_status, config_version, ip_address, last_health_check")
    .eq("status", "assigned")
    .in("health_status", ["suspended", "hibernating"])
    .lt("last_health_check", cutoff)
    .order("last_health_check", { ascending: true });

  if (error) {
    console.error("FAIL — query errored:", error.message);
    process.exit(1);
  }

  console.log(`Candidates: ${candidates?.length ?? 0}\n`);
  if (!candidates || candidates.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  for (const v of candidates) {
    const ageDays = (
      (Date.now() - new Date(v.last_health_check).getTime()) /
      86400000
    ).toFixed(1);
    console.log(
      `  ${(v.name ?? "(no name)").padEnd(20)}  cv=${String(v.config_version).padStart(3)}  ${v.health_status?.padEnd(11)}  last_hc=${ageDays}d  ip=${v.ip_address}`,
    );
  }

  if (!APPLY) {
    console.log(`\nDRY-RUN — no changes made. Re-run with --apply to commit.`);
    return;
  }

  console.log(`\nApplying UPDATE health_status='unhealthy' to ${candidates.length} VMs...`);

  const ids = candidates.map((v) => v.id);
  const { error: updErr, count } = await sb
    .from("instaclaw_vms")
    .update({ health_status: "unhealthy" }, { count: "exact" })
    .in("id", ids);

  if (updErr) {
    console.error("FAIL — update errored:", updErr.message);
    process.exit(1);
  }

  console.log(`OK — flipped ${count ?? "?"} VMs to health_status='unhealthy'.`);
  console.log(`\nRecovery if any of these wakes: UPDATE instaclaw_vms SET health_status='healthy' WHERE id='<uuid>';`);
}

main().then(() => process.exit(0));
