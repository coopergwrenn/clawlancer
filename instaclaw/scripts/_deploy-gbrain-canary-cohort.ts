/**
 * v107 canary deploy: enable gbrain on the 17 cohort VMs.
 *
 * Flow:
 *   1. Pre-flight probe: every cohort VM has gbrain prerequisites met
 *      (cv≥105, gbrain.service NOT already present, disk free > 5GB,
 *      memory free > 1GB, sudo passwordless, gateway healthy)
 *   2. Confirm proceed: print pre-flight report
 *   3. Save baseline snapshot via _monitor-gbrain-canary.ts --baseline
 *   4. UPDATE instaclaw_vms SET gbrain_enabled = true WHERE name IN (...)
 *   5. (Vercel must have deployed v107 already; reconciler picks up on next
 *      cron tick within 3 min)
 *   6. Print expected timeline + next-step commands
 *
 * Usage:
 *   cd instaclaw
 *   npx tsx scripts/_deploy-gbrain-canary-cohort.ts --preflight  # dry-run pre-flight only
 *   npx tsx scripts/_deploy-gbrain-canary-cohort.ts --enable     # do the enable (after preflight clean)
 *   npx tsx scripts/_deploy-gbrain-canary-cohort.ts --disable    # cohort rollback
 *
 * PRD: docs/prd/gbrain-fleet-rollout-canary-2026-05-19.md
 */

import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";

try {
  for (const f of [
    "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
    "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
  ]) {
    const env = readFileSync(f, "utf-8");
    for (const l of env.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  }
} catch {}

// The 17 canary VMs — frozen at plan-doc time (2026-05-19).
// Active subset (12) — last_user_activity_at set (behavior signal).
// Dormant subset (5) — paying Pro/Power, proxy alive, never messaged.
const CANARY_COHORT = [
  // Active
  "instaclaw-vm-602",
  "instaclaw-vm-517",
  "instaclaw-vm-320",
  "instaclaw-vm-295",
  "instaclaw-vm-073",
  "instaclaw-vm-733",
  "instaclaw-vm-880",
  "instaclaw-vm-855",
  "instaclaw-vm-872",
  "instaclaw-vm-634",
  "instaclaw-vm-561",
  "instaclaw-vm-912",
  // Dormant
  "instaclaw-vm-929",
  "instaclaw-vm-913",
  "instaclaw-vm-893",
  "instaclaw-vm-935",
  "instaclaw-vm-904",
] as const;

interface PreflightResult {
  name: string;
  ip: string;
  ok: boolean;
  failures: string[];
}

async function preflightOne(ip: string, name: string): Promise<PreflightResult> {
  const result: PreflightResult = { name, ip, ok: true, failures: [] };
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: ip, username: "openclaw",
      privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8"),
      readyTimeout: 12_000,
    });
    const cmd = `
export XDG_RUNTIME_DIR=/run/user/$(id -u)
# Disk
DISK_FREE_KB=$(df / | awk 'NR==2 {print $4}')
DISK_FREE_GB=$(( DISK_FREE_KB / 1024 / 1024 ))
echo "PROBE_DISK_FREE_GB=$DISK_FREE_GB"
# Memory
MEM_AVAIL_MB=$(awk '/^MemAvailable/ {print int($2/1024)}' /proc/meminfo)
echo "PROBE_MEM_AVAIL_MB=$MEM_AVAIL_MB"
# gbrain already present? (would conflict with fresh install)
GBRAIN_PRESENT=$(test -d ~/gbrain && echo 1 || echo 0)
echo "PROBE_GBRAIN_PRESENT=$GBRAIN_PRESENT"
GBRAIN_SVC=$(systemctl --user is-active gbrain.service 2>&1 | head -1)
echo "PROBE_GBRAIN_SVC=$GBRAIN_SVC"
# Sudo passwordless (needed for systemd drop-ins in install-gbrain.sh)
SUDO_OK=$(sudo -n true 2>&1 && echo 1 || echo 0)
echo "PROBE_SUDO_OK=$SUDO_OK"
# Gateway healthy (pre-condition: don't disrupt a broken gateway with gbrain install)
GW=$(systemctl --user is-active openclaw-gateway 2>&1 | head -1)
echo "PROBE_GW_STATE=$GW"
GW_HEALTH=$(curl -sf -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>/dev/null || echo 000)
echo "PROBE_GW_HEALTH=$GW_HEALTH"
# TasksMax (v86 minimum)
TASKSMAX=$(systemctl --user show openclaw-gateway --property=TasksMax --value 2>/dev/null)
echo "PROBE_TASKSMAX=$TASKSMAX"
# bun available (gbrain runs on bun)
BUN_VER=$(command -v bun >/dev/null 2>&1 && bun --version 2>/dev/null || echo missing)
echo "PROBE_BUN_VER=$BUN_VER"
`;
    const r = await Promise.race([
      ssh.execCommand(cmd),
      new Promise<any>((_, rej) => setTimeout(() => rej(new Error("timeout")), 15_000)),
    ]);
    const stdout: string = (r as any).stdout || "";
    const lines = stdout.split("\n");
    const get = (prefix: string): string => {
      const l = lines.find((line) => line.startsWith(prefix));
      return l ? l.slice(prefix.length).trim() : "";
    };

    const diskFreeGb = parseInt(get("PROBE_DISK_FREE_GB=") || "0", 10);
    const memAvailMb = parseInt(get("PROBE_MEM_AVAIL_MB=") || "0", 10);
    const gbrainPresent = get("PROBE_GBRAIN_PRESENT=") === "1";
    const gbrainSvc = get("PROBE_GBRAIN_SVC=");
    const sudoOk = get("PROBE_SUDO_OK=") === "1";
    const gwState = get("PROBE_GW_STATE=");
    const gwHealth = get("PROBE_GW_HEALTH=");
    const tasksMax = get("PROBE_TASKSMAX=");
    const bunVer = get("PROBE_BUN_VER=");

    if (diskFreeGb < 5) result.failures.push(`disk_free=${diskFreeGb}GB (<5)`);
    if (memAvailMb < 1024) result.failures.push(`mem_avail=${memAvailMb}MB (<1024)`);
    if (gbrainPresent) result.failures.push(`gbrain already present at ~/gbrain (svc=${gbrainSvc}) — fresh install expected`);
    if (!sudoOk) result.failures.push("sudo not passwordless");
    if (gwState !== "active") result.failures.push(`gateway_state=${gwState} (want active)`);
    if (gwHealth !== "200") result.failures.push(`gateway_health=${gwHealth} (want 200)`);
    if (tasksMax === "infinity" || tasksMax === "") {
      // OK — modern systemd default
    } else {
      const tasksNum = parseInt(tasksMax, 10);
      if (tasksNum > 0 && tasksNum < 120) result.failures.push(`TasksMax=${tasksMax} (v86 minimum is 120)`);
    }
    // bun missing is OK — install-gbrain.sh will install it
    void bunVer;

    if (result.failures.length === 0) {
      console.log(`✓ ${name.padEnd(20)} disk=${diskFreeGb}GB mem=${memAvailMb}MB gw=${gwState}/${gwHealth} tasksmax=${tasksMax} bun=${bunVer === "missing" ? "missing(ok)" : bunVer}`);
    } else {
      result.ok = false;
      console.log(`✗ ${name.padEnd(20)} FAILED: ${result.failures.join("; ")}`);
    }
  } catch (e: any) {
    result.ok = false;
    result.failures.push(`ssh error: ${String(e.message).slice(0, 80)}`);
    console.log(`✗ ${name.padEnd(20)} ssh error: ${String(e.message).slice(0, 80)}`);
  } finally {
    try { ssh.dispose(); } catch {}
  }
  return result;
}

async function getCohort() {
  const sb = createClient(
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data } = await sb.from("instaclaw_vms")
    .select("name, ip_address, tier, config_version, health_status, status, partner, gbrain_enabled")
    .in("name", [...CANARY_COHORT]);
  if (!data) throw new Error("no rows returned");
  return data;
}

async function preflight() {
  console.log(`Preflight probe across ${CANARY_COHORT.length} canary VMs (concurrency 5):\n`);
  const cohort = await getCohort();
  // Sanity: cohort size matches plan
  if (cohort.length !== CANARY_COHORT.length) {
    console.error(`WARNING: expected ${CANARY_COHORT.length} VMs, found ${cohort.length}. Names that didn't match:`);
    const found = new Set(cohort.map((c) => c.name));
    for (const n of CANARY_COHORT) if (!found.has(n)) console.error(`  - ${n}`);
  }
  // Sanity: every VM should be healthy+assigned+cv≥105+partner=null+gbrain_enabled is NULL or true
  for (const v of cohort) {
    const dbIssues: string[] = [];
    if (v.health_status !== "healthy") dbIssues.push(`health_status=${v.health_status}`);
    if (v.status !== "assigned") dbIssues.push(`status=${v.status}`);
    if (v.config_version < 105) dbIssues.push(`cv=${v.config_version}`);
    if (v.partner !== null) dbIssues.push(`partner=${v.partner}`);
    if (v.gbrain_enabled === false) dbIssues.push(`gbrain_enabled=false (explicitly disabled)`);
    if (dbIssues.length > 0) {
      console.log(`✗ ${v.name.padEnd(20)} DB ISSUES: ${dbIssues.join("; ")}`);
    }
  }

  // Parallel SSH probe (concurrency 5)
  const results: PreflightResult[] = [];
  for (let i = 0; i < cohort.length; i += 5) {
    const batch = cohort.slice(i, i + 5);
    const batchResults = await Promise.all(batch.map((v) => preflightOne(v.ip_address, v.name)));
    results.push(...batchResults);
  }

  const passed = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log("");
  console.log(`Preflight: ${passed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log("");
    console.log("BLOCKERS (must resolve before --enable):");
    for (const f of failed) {
      console.log(`  - ${f.name}: ${f.failures.join("; ")}`);
    }
    return { ok: false, results };
  }
  return { ok: true, results };
}

async function enable() {
  console.log("Running preflight first...\n");
  const { ok } = await preflight();
  if (!ok) {
    console.error("\n✗ Preflight failed. Resolve blockers before --enable.");
    process.exit(1);
  }

  console.log("\nPreflight clean. Proceeding to UPDATE...\n");
  const sb = createClient(
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { error, count } = await sb.from("instaclaw_vms")
    .update({ gbrain_enabled: true })
    .in("name", [...CANARY_COHORT])
    .select("name", { count: "exact", head: true });
  if (error) {
    console.error("UPDATE failed:", error);
    process.exit(1);
  }
  console.log(`✓ UPDATE succeeded. ${count} rows now have gbrain_enabled = true.`);

  console.log("");
  console.log("=== Expected timeline ===");
  console.log("  T+0min:   gbrain_enabled flipped in DB");
  console.log("  T+0-3min: next reconcile-fleet cron tick picks up the change");
  console.log("  T+3-10min: stepGbrain runs on each cohort VM (parallel batches of 3)");
  console.log("            install-gbrain.sh fresh-installs gbrain (~70-165s/VM)");
  console.log("  T+15-30min: stepDeployGbrainSoulProtocol + stepDeployGbrainSoulRouting");
  console.log("            apply AGENTS.md + SOUL.md content blocks");
  console.log("  T+30min:  all 17 VMs at v107 with gbrain active + markers present");
  console.log("");
  console.log("=== Next steps ===");
  console.log("  1. Wait ~5 min then run:");
  console.log("       npx tsx scripts/_monitor-gbrain-canary.ts --baseline");
  console.log("     (saves the pre-deploy state of the cohort for diff comparison)");
  console.log("  2. Wait ~15 min then run:");
  console.log("       npx tsx scripts/_monitor-gbrain-canary.ts");
  console.log("     (should show 17/17 gbrain active, markers present)");
  console.log("  3. Run every 6h for the next 48h. Any breach → investigate.");
  console.log("  4. After 48h clean: proceed to Phase 2 (broader 30-VM cohort).");
  console.log("  5. Rollback if needed: npx tsx scripts/_deploy-gbrain-canary-cohort.ts --disable");
}

async function disable() {
  const sb = createClient(
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { error, count } = await sb.from("instaclaw_vms")
    .update({ gbrain_enabled: false })
    .in("name", [...CANARY_COHORT])
    .select("name", { count: "exact", head: true });
  if (error) {
    console.error("UPDATE failed:", error);
    process.exit(1);
  }
  console.log(`✓ ${count} rows now have gbrain_enabled = false.`);
  console.log("");
  console.log("Reconciler will gate-skip these VMs on next cycle.");
  console.log("");
  console.log("Optional follow-up: stop gbrain.service on each VM to free resources.");
  console.log("  for vm in ${CANARY_COHORT[@]}; do");
  console.log("    ssh openclaw@<ip> 'systemctl --user stop gbrain.service && systemctl --user disable gbrain.service'");
  console.log("  done");
  console.log("");
  console.log("DO NOT wipe ~/.gbrain/brain.pglite — preserves data for re-enable later (Rule 22).");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--preflight")) {
    const { ok } = await preflight();
    process.exit(ok ? 0 : 1);
  } else if (args.includes("--enable")) {
    await enable();
  } else if (args.includes("--disable")) {
    await disable();
  } else {
    console.error("Usage: npx tsx scripts/_deploy-gbrain-canary-cohort.ts --preflight | --enable | --disable");
    process.exit(2);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
