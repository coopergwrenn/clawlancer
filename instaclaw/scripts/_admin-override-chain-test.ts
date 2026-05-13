/**
 * Admin-override 7-step chain test (Cooper's spec, 2026-05-13).
 *
 * Proves the full privacy enforcement loop:
 *   privacy ON → operator blocked → admin override → privacy OFF →
 *   operator unblocked → audit row written.
 *
 * Run after the full fleet cutover. Target: vm-050.
 *
 * Steps:
 *   1. Enable privacy mode on vm-050's user (set privacy_mode_until = now + 1h)
 *   2. SSH through bridge, confirm blocked command IS BLOCKED
 *   3. POST /api/admin/privacy-override with reason "cutover verification test"
 *   4. Wait 30s (bridge cache TTL)
 *   5. SSH through bridge, confirm SAME command now WORKS
 *   6. Verify instaclaw_operator_audit_log has row with decision='admin_override'
 *   7. Restore privacy_mode_until to null (paranoia — admin override already did this)
 */
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";
import { connectSSH } from "../lib/ssh";

config({ path: resolve(process.cwd(), ".env.local") });
config({ path: resolve(process.cwd(), ".env.ssh-key") });

const TARGET_VM = "instaclaw-vm-050";
const BLOCKED_CMD = "cat /home/openclaw/.openclaw/workspace/MEMORY.md";
const TEST_REASON = "cutover verification test";

interface StepResult {
  step: number;
  name: string;
  pass: boolean;
  detail: string;
}

async function main() {
  const results: StepResult[] = [];
  const log = (step: number, name: string, pass: boolean, detail: string) => {
    results.push({ step, name, pass, detail });
    console.log(`Step ${step} [${pass ? "PASS" : "FAIL"}] ${name}`);
    console.log(`         ${detail}`);
  };

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  // Get vm-050
  const { data: vm } = await sb.from("instaclaw_vms").select("*").eq("name", TARGET_VM).single();
  if (!vm || !vm.assigned_to) {
    console.error(`${TARGET_VM} not found or unassigned`);
    process.exit(1);
  }
  const userId = vm.assigned_to as string;
  console.log(`Target VM: ${TARGET_VM} (${vm.ip_address})`);
  console.log(`Target user_id: ${userId}\n`);

  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    console.error("ADMIN_API_KEY missing from .env.local — cannot test admin override endpoint");
    process.exit(1);
  }

  const cleanup = async () => {
    // Always restore privacy_mode_until to null at end, even on failures
    await sb.from("instaclaw_users").update({ privacy_mode_until: null }).eq("id", userId);
  };

  try {
    // ─── Step 1: Enable privacy mode ─────────────────────────────────────
    const newUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { error: enableErr } = await sb
      .from("instaclaw_users")
      .update({ privacy_mode_until: newUntil })
      .eq("id", userId);
    if (enableErr) {
      log(1, "enable privacy mode (DB write)", false, `db error: ${enableErr.message}`);
      await cleanup();
      process.exit(1);
    }
    log(1, "enable privacy mode (DB write)", true, `privacy_mode_until = ${newUntil}`);

    // Wait 35s so the bridge cache expires and the next SSH fetches fresh state.
    console.log("waiting 35s for bridge cache to expire...");
    await new Promise((r) => setTimeout(r, 35_000));

    // ─── Step 2: SSH through bridge, verify blocked command is BLOCKED ─────
    let ssh = await connectSSH(vm);
    let r = await ssh.execCommand(BLOCKED_CMD);
    ssh.dispose();
    // Bridge reject pattern: "Maximum Privacy Mode is ON" in stderr, exit=1
    const wasBlocked = r.code !== 0 && /Maximum Privacy Mode is ON/.test(r.stderr);
    if (wasBlocked) {
      log(2, "blocked command IS blocked under privacy ON", true, `exit=${r.code}, bridge reject message present`);
    } else {
      log(2, "blocked command IS blocked under privacy ON", false, `exit=${r.code}, stdout=${r.stdout.slice(0, 100)}, stderr=${r.stderr.slice(0, 200)}`);
      await cleanup();
      process.exit(1);
    }

    // ─── Step 3: POST /api/admin/privacy-override ───────────────────────────
    const overrideRes = await fetch("https://instaclaw.io/api/admin/privacy-override", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Key": adminKey,
      },
      body: JSON.stringify({ user_id: userId, reason: TEST_REASON }),
    });
    const overrideBody = await overrideRes.json().catch(() => null);
    if (overrideRes.status !== 200 || !overrideBody?.ok) {
      log(3, "POST /api/admin/privacy-override", false, `status=${overrideRes.status}, body=${JSON.stringify(overrideBody)}`);
      await cleanup();
      process.exit(1);
    }
    log(3, "POST /api/admin/privacy-override", true, `200 OK, audit_logged=${overrideBody.audit_logged}`);

    // ─── Step 4: Wait 30s for bridge cache ────────────────────────────────
    console.log("waiting 30s for bridge cache to expire after override...");
    await new Promise((r) => setTimeout(r, 30_000));
    log(4, "wait 30s for bridge cache TTL", true, "elapsed");

    // ─── Step 5: SSH through bridge, verify SAME command now WORKS ───────
    ssh = await connectSSH(vm);
    r = await ssh.execCommand(BLOCKED_CMD);
    ssh.dispose();
    // Now privacy is OFF (override nulled privacy_mode_until); bridge takes
    // early-exit and runs the command. cat returns the file content with
    // exit=0 (or exit=1 if file doesn't exist; either way, NOT the bridge
    // reject message). We confirm by absence of the bridge reject pattern.
    const wasUnblocked = !/Maximum Privacy Mode is ON/.test(r.stderr);
    if (wasUnblocked) {
      log(5, "blocked command now WORKS after override", true, `exit=${r.code}, command passed through bridge (output ${r.stdout.length}b stdout, ${r.stderr.length}b stderr)`);
    } else {
      log(5, "blocked command now WORKS after override", false, `still blocked: exit=${r.code}, stderr=${r.stderr.slice(0, 200)}`);
      await cleanup();
      process.exit(1);
    }

    // ─── Step 6: Verify audit log row ─────────────────────────────────────
    const { data: auditRows } = await sb
      .from("instaclaw_operator_audit_log")
      .select("*")
      .eq("user_id", userId)
      .eq("decision", "admin_override")
      .order("created_at", { ascending: false })
      .limit(5);
    const matching = (auditRows ?? []).filter((row) => (row.reason as string) === TEST_REASON);
    if (matching.length > 0) {
      const recent = matching[0];
      log(6, "audit log row exists with decision='admin_override'", true, `id=${recent.id}, reason='${recent.reason}', created_at=${recent.created_at}`);
    } else {
      log(6, "audit log row exists with decision='admin_override'", false, `no row found matching user_id + decision='admin_override' + reason='${TEST_REASON}'. Recent admin_override rows: ${JSON.stringify(auditRows?.slice(0, 3) ?? [])}`);
      await cleanup();
      process.exit(1);
    }

    // ─── Step 7: Restore (paranoia) ───────────────────────────────────────
    await cleanup();
    log(7, "restore privacy_mode_until to null (cleanup)", true, "DB updated");

    // Summary
    console.log("\n" + "═".repeat(60));
    const pass = results.filter((r) => r.pass).length;
    const fail = results.filter((r) => !r.pass).length;
    console.log(`Chain test: ${pass}/${results.length} pass, ${fail} fail`);
    if (fail === 0) {
      console.log("✅ ALL STEPS PASS — full privacy enforcement loop verified end-to-end");
    } else {
      console.log("❌ FAILURES DETECTED — privacy enforcement loop is NOT fully working");
      process.exit(1);
    }
  } catch (e) {
    console.error("FATAL during chain test:", e);
    await cleanup();
    process.exit(1);
  }
}

main();
