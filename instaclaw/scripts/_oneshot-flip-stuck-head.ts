/**
 * One-shot: identify and flip "stuck head" VMs to unhealthy. Companion
 * to _oneshot-mark-dormant-unhealthy.ts but for a different cohort.
 *
 * Stuck-head pattern (caused 240s/tick burn after the eligibility revert):
 *   - status='assigned' AND health_status='healthy'  (passes cron filter)
 *   - config_version < 84                            (way behind)
 *   - updated_at older than 14 days                  (reconcile-fleet has been
 *                                                     erroring for weeks)
 *   - last_user_activity_at older than 7 days        (user not engaging)
 *
 * The combination of stale updated_at + stale last_user_activity_at is
 * the smoking gun: reconciler can't bump cv, AND no user is suffering
 * from the stale config because no user is using the VM.
 *
 * Usage:
 *   npx tsx scripts/_oneshot-flip-stuck-head.ts             # dry-run
 *   npx tsx scripts/_oneshot-flip-stuck-head.ts --apply
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
const CV_BEHIND_THRESHOLD = 84;
const RECONCILE_STALE_DAYS = 14;
const USER_INACTIVE_DAYS = 7;

async function main() {
  const reconcileCutoff = new Date(Date.now() - RECONCILE_STALE_DAYS * 86400_000).toISOString();
  const userCutoff = new Date(Date.now() - USER_INACTIVE_DAYS * 86400_000).toISOString();

  console.log(`\n=== oneshot-flip-stuck-head ${APPLY ? "(APPLY)" : "(DRY-RUN)"} ===`);
  console.log(`Criteria:`);
  console.log(`  status=assigned AND health_status=healthy`);
  console.log(`  config_version < ${CV_BEHIND_THRESHOLD}`);
  console.log(`  updated_at < ${reconcileCutoff} (reconcile stuck for >${RECONCILE_STALE_DAYS}d)`);
  console.log(`  last_user_activity_at < ${userCutoff} (user inactive >${USER_INACTIVE_DAYS}d)\n`);

  const { data: candidates, error } = await sb
    .from("instaclaw_vms")
    .select("id, name, config_version, ip_address, updated_at, last_user_activity_at, assigned_to")
    .eq("status", "assigned")
    .eq("provider", "linode")
    .eq("health_status", "healthy")
    .lt("config_version", CV_BEHIND_THRESHOLD)
    .lt("updated_at", reconcileCutoff)
    .order("updated_at", { ascending: true });

  if (error) {
    console.error("query failed:", error.message);
    process.exit(1);
  }

  // Filter on user-inactive separately because last_user_activity_at can be NULL
  // (no activity ever recorded). Treat NULL as "definitely inactive" by
  // comparing to userCutoff or treating null as eligible.
  const filtered = (candidates ?? []).filter((v) => {
    if (!v.last_user_activity_at) return true; // never had activity → abandoned
    return new Date(v.last_user_activity_at).toISOString() < userCutoff;
  });

  console.log(`Candidates matching all criteria: ${filtered.length}\n`);

  for (const v of filtered) {
    const updAge = ((Date.now() - new Date(v.updated_at).getTime()) / 86400_000).toFixed(1);
    const luaAge = v.last_user_activity_at
      ? ((Date.now() - new Date(v.last_user_activity_at).getTime()) / 86400_000).toFixed(1) + "d"
      : "(never)";
    console.log(
      `  ${(v.name ?? "(no name)").padEnd(22)}  cv=${String(v.config_version).padStart(3)}  upd=${updAge}d  user_activity=${luaAge}  ip=${v.ip_address}`,
    );
  }

  if (!APPLY) {
    console.log(`\nDRY-RUN — no changes made. Re-run with --apply to commit.`);
    return;
  }
  if (filtered.length === 0) {
    console.log(`\nNothing to apply.`);
    return;
  }

  console.log(`\nApplying UPDATE health_status='unhealthy' to ${filtered.length} VMs...`);
  const ids = filtered.map((v) => v.id);
  const { error: updErr, count } = await sb
    .from("instaclaw_vms")
    .update({ health_status: "unhealthy" }, { count: "exact" })
    .in("id", ids);
  if (updErr) {
    console.error("update failed:", updErr.message);
    process.exit(1);
  }
  console.log(`OK — flipped ${count ?? "?"} VMs to health_status='unhealthy'.`);
  console.log(`\nRecovery (per-VM): UPDATE instaclaw_vms SET health_status='healthy' WHERE id='<uuid>';`);
}

main().then(() => process.exit(0));
