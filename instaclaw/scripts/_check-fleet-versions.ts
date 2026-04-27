/**
 * Check fleet config_version distribution. Identifies VMs lagging
 * behind the current manifest (VM_MANIFEST.version) that the
 * reconcile-fleet cron should catch up.
 *
 * IMPORTANT: reconcile-fleet only operates on health_status="healthy"
 * VMs. Suspended/hibernating VMs are intentionally skipped — they
 * get reconciled when the user becomes active again.
 */
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
import { VM_MANIFEST } from "../lib/vm-manifest";

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

(async () => {
  console.log(`Current VM_MANIFEST.version: v${VM_MANIFEST.version}\n`);

  const { data: vms } = await s.from("instaclaw_vms")
    .select("id, name, status, health_status, config_version, assigned_to")
    .eq("status", "assigned");

  const dist = new Map<number, number>();
  const lagging: { name: string; cfg: number; health: string }[] = [];
  const laggingHealthy: { name: string; cfg: number }[] = [];
  for (const v of vms ?? []) {
    const cfg = v.config_version ?? 0;
    dist.set(cfg, (dist.get(cfg) ?? 0) + 1);
    if (cfg < VM_MANIFEST.version) {
      lagging.push({ name: v.name!, cfg, health: v.health_status ?? "?" });
      if (v.health_status === "healthy") {
        laggingHealthy.push({ name: v.name!, cfg });
      }
    }
  }

  console.log("=== assigned VM config_version distribution ===");
  for (const [cfg, count] of [...dist.entries()].sort((a, b) => a[0] - b[0])) {
    const flag = cfg < VM_MANIFEST.version ? " ← LAGGING" : cfg === VM_MANIFEST.version ? " ✓" : "";
    console.log(`  v${cfg.toString().padStart(2)}: ${count}${flag}`);
  }
  console.log(`\nTotal assigned: ${vms?.length ?? 0}`);
  console.log(`Lagging (< v${VM_MANIFEST.version}): ${lagging.length}`);
  console.log(`  …of which healthy (would be picked up by reconcile-fleet): ${laggingHealthy.length}`);

  const healthDist = new Map<string, number>();
  for (const l of lagging) healthDist.set(l.health, (healthDist.get(l.health) ?? 0) + 1);
  console.log("\nLagging VMs by health_status:");
  for (const [h, c] of healthDist) console.log(`  ${h}: ${c}`);

  if (laggingHealthy.length > 0) {
    console.log("\n=== HEALTHY but LAGGING (real reconcile candidates) ===");
    for (const l of laggingHealthy) console.log(`  ${l.name} v${l.cfg}`);
  }

  const { data: ready } = await s.from("instaclaw_vms")
    .select("name, config_version")
    .eq("status", "ready");
  const readyDist = new Map<number, number>();
  for (const v of ready ?? []) {
    readyDist.set(v.config_version ?? 0, (readyDist.get(v.config_version ?? 0) ?? 0) + 1);
  }
  console.log("\n=== ready pool config_version distribution ===");
  for (const [cfg, count] of [...readyDist.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  v${cfg.toString().padStart(2)}: ${count}`);
  }
})();
