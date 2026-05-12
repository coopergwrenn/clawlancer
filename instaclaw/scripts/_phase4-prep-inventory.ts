/**
 * Phase 4 inventory probe: edge_city VMs + lying-DB intersection + readiness.
 *
 * Read-only. Used as input data for docs/prd/gbrain-fleet-rollout-2026-05-12.md.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

(async () => {
  console.log("══ Edge City VMs (partner='edge_city') ══\n");
  const { data: edge } = await sb.from("instaclaw_vms")
    .select("name,ip_address,tier,assigned_to,config_version,health_status,health_fail_count,status,created_at")
    .eq("partner", "edge_city")
    .eq("status", "assigned")
    .order("created_at", { ascending: true });
  console.log(`Total assigned edge_city VMs: ${(edge ?? []).length}\n`);
  const userIds = Array.from(new Set((edge ?? []).map((v: any) => v.assigned_to).filter(Boolean)));
  const { data: users } = await sb.from("instaclaw_users").select("id,email").in("id", userIds);
  const emailById = new Map((users ?? []).map((u: any) => [u.id, u.email]));
  console.log(`${"vm".padEnd(22)} ${"tier".padEnd(8)} ${"cv".padStart(3)} ${"health".padEnd(13)} ${"hf".padStart(2)} ${"created".padEnd(11)} owner`);
  for (const v of (edge ?? []) as any[]) {
    const created = (v.created_at ?? "").slice(0, 10);
    const owner = emailById.get(v.assigned_to) ?? "<?>";
    console.log(`${v.name.padEnd(22)} ${(v.tier ?? "?").padEnd(8)} ${String(v.config_version).padStart(3)} ${(v.health_status ?? "?").padEnd(13)} ${String(v.health_fail_count).padStart(2)} ${created.padEnd(11)} ${owner}`);
  }
  console.log("");

  // Tier distribution
  const tierCount: Record<string, number> = {};
  for (const v of (edge ?? []) as any[]) tierCount[v.tier ?? "?"] = (tierCount[v.tier ?? "?"] ?? 0) + 1;
  console.log(`Tier distribution: ${JSON.stringify(tierCount)}`);
  const healthCount: Record<string, number> = {};
  for (const v of (edge ?? []) as any[]) healthCount[v.health_status ?? "?"] = (healthCount[v.health_status ?? "?"] ?? 0) + 1;
  console.log(`Health distribution: ${JSON.stringify(healthCount)}`);
  const cvCount: Record<string, number> = {};
  for (const v of (edge ?? []) as any[]) cvCount[String(v.config_version)] = (cvCount[String(v.config_version)] ?? 0) + 1;
  console.log(`config_version distribution: ${JSON.stringify(cvCount)}`);
  console.log("");

  // Already gbrained — vm-050 + vm-576
  const { data: gbrained } = await sb.from("instaclaw_vms")
    .select("name,partner,config_version,health_status")
    .in("name", ["instaclaw-vm-050", "instaclaw-vm-576"]);
  console.log("Already gbrained (Phase 1 canary):");
  for (const v of (gbrained ?? []) as any[]) {
    console.log(`  ${v.name}: partner=${v.partner ?? "-"} cv=${v.config_version} health=${v.health_status}`);
  }
  console.log("");

  // Quick lying-DB intersection: edge_city VMs at cv >= 88 (where the v87 prctl + v86 TasksMax should be present).
  // (Full empirical check needs SSH per VM; here just flag candidates.)
  const lyingCandidates = (edge ?? []).filter((v: any) => v.config_version >= 88 && v.health_status === "healthy");
  console.log(`edge_city VMs at cv≥88 (candidates for lying-DB probe before Phase 4): ${lyingCandidates.length}`);

  // Pool — how many edge_city VMs are in the ready pool (not yet assigned)
  const { data: pool } = await sb.from("instaclaw_vms")
    .select("name,partner,health_status").eq("status", "ready");
  const edgePool = (pool ?? []).filter((v: any) => v.partner === "edge_city");
  console.log(`Ready-pool VMs total: ${(pool ?? []).length}, of which partner=edge_city: ${edgePool.length}`);
  console.log("(Note: ready-pool VMs are typically NOT partner-tagged until assignment; they inherit the partner of the user who claims them.)");
  console.log("");

  // Fleet totals for context
  const { count: assignedTotal } = await sb.from("instaclaw_vms")
    .select("id", { count: "exact", head: true }).eq("status", "assigned");
  const { count: edgeTotal } = await sb.from("instaclaw_vms")
    .select("id", { count: "exact", head: true }).eq("status", "assigned").eq("partner", "edge_city");
  const { count: consensusTotal } = await sb.from("instaclaw_vms")
    .select("id", { count: "exact", head: true }).eq("status", "assigned").eq("partner", "consensus_2026");
  console.log("Fleet context:");
  console.log(`  total assigned VMs: ${assignedTotal ?? 0}`);
  console.log(`  edge_city assigned: ${edgeTotal ?? 0}`);
  console.log(`  consensus_2026 assigned: ${consensusTotal ?? 0}`);
  console.log("");

  // Disk health sample is too expensive without SSH — flag for follow-up
  console.log("Open data points (require SSH probe):");
  console.log("  - Disk free per edge_city VM (gbrain needs ~500MB)");
  console.log("  - Bun already installed? (affects install time)");
  console.log("  - lying-DB rate on edge_city specifically");
})();
