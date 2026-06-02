/**
 * scripts/_canary-worldid-gate-vm050.ts
 *
 * Drive stepToolRouter directly against vm-050 to canary the WorldID gate.
 * Tests both directions of the state machine:
 *
 *   PHASE 1 — Cooper world_id_verified=false (current production state):
 *     Pre:  MCP wired (left over from hand-set during K.4 canary 2026-06-01)
 *     Run:  stepToolRouter
 *     Post: MCP absent (gate detected unverified, called unwireToolRouterMcp)
 *
 *   PHASE 2 — Cooper world_id_verified=true (canary flip in DB):
 *     Pre:  MCP absent (after PHASE 1)
 *     Run:  stepToolRouter
 *     Post: MCP wired (gate detected verified, called wireToolRouterMcp)
 *
 *   PHASE 3 — Cooper world_id_verified=false (restore):
 *     Pre:  MCP wired (after PHASE 2)
 *     Run:  stepToolRouter
 *     Post: MCP absent (gate detected unverified again, unwired)
 *
 *   Flip the DB back to world_id_verified=false at the end so vm-050 returns
 *   to its real production state (Cooper hasn't actually verified yet).
 *
 * Usage: npx tsx scripts/_canary-worldid-gate-vm050.ts
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

// Load .env.local + .env.ssh-key in order (CLAUDE.md Rule 18 pattern)
for (const f of [
  path.resolve(__dirname, "../.env.local"),
  path.resolve(__dirname, "../.env.ssh-key"),
]) {
  if (!fs.existsSync(f)) continue;
  const text = fs.readFileSync(f, "utf-8");
  for (const line of text.split("\n")) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

import { getSupabase } from "../lib/supabase";
import { connectSSH } from "../lib/ssh";
import { stepToolRouter } from "../lib/vm-reconcile";
import type { ReconcileResult } from "../lib/vm-reconcile";

const VM_NAME = "instaclaw-vm-050";
const COOPER_USER_ID = "4e0213b3-c9e8-4812-9385-827786900b66";

async function snapshotMcpState(ssh: any): Promise<{ command: string; arg0: string }> {
  const probe = await ssh.execCommand(
    `jq -r "{c: (.mcp.servers.toolrouter.command // \\"ABSENT\\"), a: (.mcp.servers.toolrouter.args[0] // \\"\\")}" ~/.openclaw/openclaw.json 2>/dev/null`,
  );
  try {
    const j = JSON.parse(probe.stdout || "{}");
    return { command: j.c ?? "ERR", arg0: j.a ?? "" };
  } catch {
    return { command: "PARSE_ERR", arg0: probe.stdout?.slice(0, 80) ?? "" };
  }
}

async function setVerified(supabase: ReturnType<typeof getSupabase>, value: boolean): Promise<void> {
  const { error } = await supabase
    .from("instaclaw_users")
    .update({
      world_id_verified: value,
      world_id_verified_at: value ? new Date().toISOString() : null,
    })
    .eq("id", COOPER_USER_ID);
  if (error) throw new Error(`DB update failed: ${error.message}`);
}

function emptyResult(): ReconcileResult {
  return {
    fixed: [],
    alreadyCorrect: [],
    errors: [],
    warnings: [],
    gatewayRestartNeeded: false,
    gatewayRestarted: false,
    gatewayHealthy: true,
    strictErrors: [],
    canaryHealthy: null,
    canarySkippedBudget: false,
    envPushSucceeded: true,
  };
}

function printResult(label: string, r: ReconcileResult): void {
  console.log(`\n  ${label}:`);
  if (r.fixed.length) console.log(`    fixed: ${r.fixed.join(" | ")}`);
  if (r.alreadyCorrect.length) console.log(`    alreadyCorrect: ${r.alreadyCorrect.join(" | ")}`);
  if (r.warnings.length) console.log(`    warnings: ${r.warnings.join(" | ")}`);
  if (r.errors.length) console.log(`    errors: ${r.errors.join(" | ")}`);
}

async function main(): Promise<void> {
  // Ensure TOOLROUTER_ENABLED for the canary; respect override
  if (process.env.TOOLROUTER_ENABLED === undefined) {
    process.env.TOOLROUTER_ENABLED = "true";
  }
  // The runtime-env loader treats TOOLROUTER_ENABLED=true the same as Vercel
  // production. The TOOLROUTER_API_KEY must already be in .env.local for shape check.
  if (!process.env.TOOLROUTER_API_KEY) {
    console.error("FATAL: TOOLROUTER_API_KEY not in .env.local — required for the canary");
    process.exit(2);
  }

  const supabase = getSupabase();

  // Resolve vm-050
  const { data: vm, error: vmErr } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, assigned_to, gateway_token, health_status, status")
    .eq("name", VM_NAME)
    .single();
  if (vmErr || !vm) throw new Error(`vm-050 lookup failed: ${vmErr?.message ?? "no row"}`);

  console.log(`Canary VM: ${vm.name} (${vm.ip_address}, ${vm.health_status})`);
  console.log(`Assigned to: ${vm.assigned_to}`);

  if (vm.assigned_to !== COOPER_USER_ID) {
    console.error(`FATAL: vm-050.assigned_to (${vm.assigned_to}) !== COOPER_USER_ID (${COOPER_USER_ID})`);
    console.error("This canary assumes Cooper owns vm-050. Aborting to avoid surprising another user.");
    process.exit(2);
  }

  // Snapshot Cooper's verify state for restoration
  const { data: userBefore } = await supabase
    .from("instaclaw_users")
    .select("world_id_verified, world_id_verified_at")
    .eq("id", COOPER_USER_ID)
    .single();
  console.log(`Cooper's current world_id_verified state: ${userBefore?.world_id_verified} (at ${userBefore?.world_id_verified_at})`);

  const ssh = await connectSSH(vm as any);
  let exitCode = 0;

  try {
    // ── PHASE 1: unverified → expect unwire ────────────────────────────
    console.log("\n────────────────────────────────────────────────────────");
    console.log("PHASE 1: world_id_verified=false → expect MCP unwire");
    console.log("────────────────────────────────────────────────────────");
    await setVerified(supabase, false);
    console.log("  set DB: world_id_verified=false");

    const beforeP1 = await snapshotMcpState(ssh);
    console.log(`  PRE  MCP: command=${beforeP1.command}, arg0=${beforeP1.arg0.slice(-50)}`);

    const r1 = emptyResult();
    await stepToolRouter(ssh, vm as any, r1, false, false);
    printResult("stepToolRouter result", r1);

    const afterP1 = await snapshotMcpState(ssh);
    console.log(`  POST MCP: command=${afterP1.command}, arg0=${afterP1.arg0.slice(-50)}`);

    if (afterP1.command !== "ABSENT") {
      console.error("  ✗ PHASE 1 FAIL: expected command=ABSENT after unwire, got command=" + afterP1.command);
      exitCode = 1;
    } else {
      console.log("  ✓ PHASE 1 PASS: MCP unwired on unverified user");
    }

    // ── PHASE 2: verified → expect wire ────────────────────────────────
    console.log("\n────────────────────────────────────────────────────────");
    console.log("PHASE 2: world_id_verified=true → expect MCP wire");
    console.log("────────────────────────────────────────────────────────");
    await setVerified(supabase, true);
    console.log("  set DB: world_id_verified=true (canary flip)");

    const beforeP2 = await snapshotMcpState(ssh);
    console.log(`  PRE  MCP: command=${beforeP2.command}, arg0=${beforeP2.arg0.slice(-50)}`);

    const r2 = emptyResult();
    await stepToolRouter(ssh, vm as any, r2, false, false);
    printResult("stepToolRouter result", r2);

    const afterP2 = await snapshotMcpState(ssh);
    console.log(`  POST MCP: command=${afterP2.command}, arg0=${afterP2.arg0.slice(-50)}`);

    if (afterP2.command !== "node" || !afterP2.arg0.endsWith("toolrouter-wrapper.mjs")) {
      console.error("  ✗ PHASE 2 FAIL: expected command=node + arg0 ending toolrouter-wrapper.mjs");
      exitCode = 1;
    } else {
      console.log("  ✓ PHASE 2 PASS: MCP wired on verified user");
    }

    // ── PHASE 3: unverified again → expect unwire ──────────────────────
    console.log("\n────────────────────────────────────────────────────────");
    console.log("PHASE 3: flip back to world_id_verified=false → expect unwire");
    console.log("────────────────────────────────────────────────────────");
    await setVerified(supabase, false);
    console.log("  set DB: world_id_verified=false");

    const beforeP3 = await snapshotMcpState(ssh);
    console.log(`  PRE  MCP: command=${beforeP3.command}, arg0=${beforeP3.arg0.slice(-50)}`);

    const r3 = emptyResult();
    await stepToolRouter(ssh, vm as any, r3, false, false);
    printResult("stepToolRouter result", r3);

    const afterP3 = await snapshotMcpState(ssh);
    console.log(`  POST MCP: command=${afterP3.command}, arg0=${afterP3.arg0.slice(-50)}`);

    if (afterP3.command !== "ABSENT") {
      console.error("  ✗ PHASE 3 FAIL: expected command=ABSENT after second unwire");
      exitCode = 1;
    } else {
      console.log("  ✓ PHASE 3 PASS: MCP re-unwired on deverification");
    }

    // ── Final: idempotency ─────────────────────────────────────────────
    console.log("\n────────────────────────────────────────────────────────");
    console.log("PHASE 4: run again on unverified+unwired state → expect already-correct");
    console.log("────────────────────────────────────────────────────────");
    const r4 = emptyResult();
    await stepToolRouter(ssh, vm as any, r4, false, false);
    printResult("stepToolRouter result", r4);
    if (r4.alreadyCorrect.length === 0 || r4.fixed.length > 0) {
      console.error("  ✗ PHASE 4 FAIL: expected alreadyCorrect (idempotent), got fixed");
      exitCode = 1;
    } else {
      console.log("  ✓ PHASE 4 PASS: idempotent no-op");
    }
  } finally {
    // ALWAYS restore Cooper's pre-test verify state, regardless of outcome.
    // Per Cooper 2026-06-02: he wants to verify for real, not via DB flip.
    const restoreTo = userBefore?.world_id_verified ?? false;
    await setVerified(supabase, restoreTo);
    console.log(`\n  RESTORED DB: world_id_verified=${restoreTo}`);
    try { ssh.dispose(); } catch { /* swallow */ }
  }

  console.log("\n────────────────────────────────────────────────────────");
  console.log(exitCode === 0 ? "ALL PHASES PASSED ✓" : "ONE OR MORE PHASES FAILED ✗");
  console.log("────────────────────────────────────────────────────────");
  process.exit(exitCode);
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.stack : String(e));
  process.exit(2);
});
