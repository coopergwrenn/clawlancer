/**
 * Post-deploy verification of the throughput fix (5e949f0f + 55fce656 +
 * 3716bc43 + 84775ac0). Reports:
 *   1. Lock state (should be cycling through, not held forever)
 *   2. config_version histogram (should be shifting up)
 *   3. VMs that bumped cv in last 5/15/30 min (should be > 0)
 *   4. Cohort head — what the cron is picking now (should be HEALTHY only)
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
  const MV = 91;
  console.log(`\n=== throughput-fix verification — ${new Date().toISOString()} ===\n`);

  // 1. Lock state
  const { data: locks } = await sb
    .from("instaclaw_cron_locks")
    .select("*")
    .eq("name", "reconcile-fleet");
  console.log(`Lock rows: ${locks?.length ?? 0}`);
  for (const l of locks ?? []) {
    const ageMs = Date.now() - new Date(l.acquired_at).getTime();
    const expiresInMs = new Date(l.expires_at).getTime() - Date.now();
    console.log(`  acquired: ${l.acquired_at} (age ${(ageMs / 1000).toFixed(0)}s)`);
    console.log(`  expires:  ${l.expires_at} (in ${(expiresInMs / 1000).toFixed(0)}s)`);
  }

  // 2. cv histogram (assigned + healthy only — what cron actually sees)
  const { data: vms } = await sb
    .from("instaclaw_vms")
    .select("config_version, health_status")
    .eq("status", "assigned")
    .eq("provider", "linode")
    .eq("health_status", "healthy");
  if (!vms) return;
  const hist = new Map<number, number>();
  for (const v of vms) {
    const cv = v.config_version ?? 0;
    hist.set(cv, (hist.get(cv) ?? 0) + 1);
  }
  console.log(`\nconfig_version histogram (healthy assigned only):`);
  for (const cv of [...hist.keys()].sort((a, b) => a - b)) {
    const bar = "█".repeat(Math.min(50, hist.get(cv)!));
    const star = cv < MV ? " (stale)" : "";
    console.log(`  cv=${String(cv).padStart(3)}: ${String(hist.get(cv)).padStart(4)}${star}  ${bar}`);
  }
  const stale = vms.filter((v) => (v.config_version ?? 0) < MV).length;
  console.log(`\nHealthy stale (eligible for cron): ${stale}`);

  // 3. Recent bumps
  const windows = [5, 15, 30];
  for (const min of windows) {
    const cutoff = new Date(Date.now() - min * 60_000).toISOString();
    const { count } = await sb
      .from("instaclaw_vms")
      .select("id", { count: "exact", head: true })
      .eq("status", "assigned")
      .eq("provider", "linode")
      .eq("config_version", MV)
      .gte("updated_at", cutoff);
    console.log(`  cv=${MV} bumps in last ${min}min: ${count ?? 0}`);
  }

  // 4. Cohort head — what the cron is picking next
  const { data: head } = await sb
    .from("instaclaw_vms")
    .select("name, config_version, health_status, updated_at")
    .eq("status", "assigned")
    .eq("provider", "linode")
    .eq("health_status", "healthy")
    .lt("config_version", MV)
    .not("gateway_url", "is", null)
    .order("config_version", { ascending: true, nullsFirst: true })
    .limit(10);
  console.log(`\nCohort head (next 10 the cron picks, healthy only):`);
  for (const v of head ?? []) {
    const ageMin = ((Date.now() - new Date(v.updated_at).getTime()) / 60000).toFixed(1);
    console.log(`  cv=${String(v.config_version).padStart(3)}  ${v.name?.padEnd(20)}  upd ${ageMin}min ago`);
  }

  // 5. Most recent bumps to cv=91 — last 30 min, sorted desc
  const { data: recent } = await sb
    .from("instaclaw_vms")
    .select("name, config_version, health_status, updated_at")
    .eq("status", "assigned")
    .eq("provider", "linode")
    .eq("config_version", MV)
    .gte("updated_at", new Date(Date.now() - 30 * 60_000).toISOString())
    .order("updated_at", { ascending: false })
    .limit(15);
  console.log(`\nMost recent cv=${MV} bumps (last 30 min, n=${recent?.length ?? 0}):`);
  for (const v of recent ?? []) {
    const ageMin = ((Date.now() - new Date(v.updated_at).getTime()) / 60000).toFixed(1);
    console.log(`  ${v.updated_at}  ${v.name?.padEnd(20)}  ${ageMin}min ago`);
  }
}

main().then(() => process.exit(0));
