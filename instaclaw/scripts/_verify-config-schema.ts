/**
 * P0.1 — Config Schema Verification
 *
 * SSHes into one healthy VM and tests every proposed config key from the
 * Memory Architecture Overhaul PRD. Records ACCEPTED/REJECTED/CRASH for each.
 *
 * Also runs discovery commands to find all valid config keys in the OpenClaw dist.
 *
 * Usage:
 *   npx tsx scripts/_verify-config-schema.ts
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { Client as SSH2Client } from "ssh2";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const NVM_PREAMBLE = 'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"';

function sshExec(conn: SSH2Client, cmd: string, timeout = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeout);
    conn.exec(cmd, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }
      let out = "";
      stream.on("data", (d: Buffer) => (out += d.toString()));
      stream.stderr.on("data", (d: Buffer) => (out += d.toString()));
      stream.on("close", () => { clearTimeout(timer); resolve(out.trim()); });
    });
  });
}

interface KeyTestResult {
  key: string;
  value: string;
  beforeGet: string;
  setOutput: string;
  afterGet: string;
  doctorOutput: string;
  verdict: "ACCEPTED" | "REJECTED" | "CRASH" | "UNKNOWN";
  notes: string;
}

async function testConfigKey(conn: SSH2Client, key: string, value: string): Promise<KeyTestResult> {
  const result: KeyTestResult = {
    key, value,
    beforeGet: "", setOutput: "", afterGet: "", doctorOutput: "",
    verdict: "UNKNOWN", notes: ""
  };

  try {
    // 1. Record current value
    result.beforeGet = await sshExec(conn, `${NVM_PREAMBLE} && openclaw config get ${key} 2>&1`);

    // 2. Attempt set
    result.setOutput = await sshExec(conn, `${NVM_PREAMBLE} && openclaw config set ${key} '${value}' 2>&1`);

    // 3. Check if it stuck
    result.afterGet = await sshExec(conn, `${NVM_PREAMBLE} && openclaw config get ${key} 2>&1`);

    // 4. Run doctor
    result.doctorOutput = await sshExec(conn, `${NVM_PREAMBLE} && openclaw doctor 2>&1`, 30000);

    // 5. Determine verdict
    const setLower = result.setOutput.toLowerCase();
    const doctorLower = result.doctorOutput.toLowerCase();

    if (setLower.includes("error") || setLower.includes("invalid") || setLower.includes("unknown")) {
      result.verdict = "REJECTED";
      result.notes = "config set reported error";
    } else if (doctorLower.includes("invalid") || doctorLower.includes("error")) {
      // Doctor found issues — might be pre-existing or from our key
      if (doctorLower.includes(key.toLowerCase()) || doctorLower.includes("schema")) {
        result.verdict = "REJECTED";
        result.notes = "doctor flagged schema issue";
      } else {
        // Doctor has issues but not related to our key
        result.verdict = "ACCEPTED";
        result.notes = "set succeeded; doctor has pre-existing warnings";
      }
    } else if (result.afterGet.includes(value) || result.afterGet === value) {
      result.verdict = "ACCEPTED";
      result.notes = "value persisted after set";
    } else if (result.afterGet === result.beforeGet) {
      result.verdict = "REJECTED";
      result.notes = "value did not change after set (silently rejected)";
    } else {
      result.verdict = "UNKNOWN";
      result.notes = "ambiguous result — manual review needed";
    }

    // 6. Revert: if beforeGet had a value, restore it. Otherwise try to unset.
    if (result.beforeGet && !result.beforeGet.includes("error") && !result.beforeGet.includes("undefined")) {
      await sshExec(conn, `${NVM_PREAMBLE} && openclaw config set ${key} '${result.beforeGet}' 2>&1 || true`);
    } else {
      // Try to unset by setting to empty or just leave it (config set may not support unset)
      await sshExec(conn, `${NVM_PREAMBLE} && openclaw config unset ${key} 2>&1 || openclaw config set ${key} '' 2>&1 || true`);
    }
  } catch (err: any) {
    result.verdict = "CRASH";
    result.notes = `Exception: ${err.message?.substring(0, 100)}`;
  }

  return result;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  P0.1 — Config Schema Verification                         ║");
  console.log("║  Memory Architecture Overhaul — Phase 0                     ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // Find one healthy assigned VM
  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, status, health_status")
    .eq("status", "assigned")
    .eq("health_status", "healthy")
    .not("assigned_to", "is", null)
    .order("name")
    .limit(1);

  if (error || !vms?.length) {
    console.error("No healthy assigned VM found:", error?.message);
    return;
  }

  const vm = vms[0];
  console.log(`Target VM: ${vm.name} (${vm.ip_address})\n`);

  const privateKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

  const conn = new SSH2Client();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SSH timeout")), 15000);
    conn.on("ready", () => { clearTimeout(timer); resolve(); });
    conn.on("error", (e) => { clearTimeout(timer); reject(e); });
    conn.connect({
      host: vm.ip_address,
      port: vm.ssh_port || 22,
      username: vm.ssh_user || "openclaw",
      privateKey,
      readyTimeout: 15000,
    });
  });

  console.log("SSH connected.\n");

  // ══════════════════════════════════════════════════════════
  // SECTION 1: OpenClaw version + baseline health
  // ══════════════════════════════════════════════════════════
  console.log("═══ SECTION 1: Baseline ═══\n");

  const version = await sshExec(conn, `${NVM_PREAMBLE} && openclaw --version 2>&1`);
  console.log(`OpenClaw version: ${version}`);

  const healthBefore = await sshExec(conn, 'curl -sf http://localhost:18789/health 2>&1 || echo "UNHEALTHY"');
  console.log(`Gateway health (before): ${healthBefore.substring(0, 200)}`);

  const doctorBefore = await sshExec(conn, `${NVM_PREAMBLE} && openclaw doctor 2>&1`, 30000);
  console.log(`\nDoctor (baseline):\n${doctorBefore}\n`);

  // ══════════════════════════════════════════════════════════
  // SECTION 2: Discovery — dump all valid config keys from dist
  // ══════════════════════════════════════════════════════════
  console.log("═══ SECTION 2: Discovery ═══\n");

  const discoveries: { label: string; cmd: string }[] = [
    { label: "openclaw config list", cmd: `${NVM_PREAMBLE} && openclaw config list 2>&1` },
    { label: "openclaw config --help", cmd: `${NVM_PREAMBLE} && openclaw config --help 2>&1` },
    { label: "openclaw cron --help", cmd: `${NVM_PREAMBLE} && openclaw cron --help 2>&1 || echo 'no cron subcommand'` },
    { label: "openclaw run --help (session flags)", cmd: `${NVM_PREAMBLE} && openclaw run --help 2>&1 | grep -i 'session\\|isolat' || echo 'no session flags found'` },
    { label: "openclaw run --help (full)", cmd: `${NVM_PREAMBLE} && openclaw run --help 2>&1` },
    { label: "dist: session.* keys", cmd: `grep -roh '"session\\.[a-zA-Z.]*"' ~/.nvm/versions/node/*/lib/node_modules/openclaw/dist/*.js 2>/dev/null | sort -u || echo 'none'` },
    { label: "dist: compaction.* keys", cmd: `grep -roh '"compaction\\.[a-zA-Z.]*"' ~/.nvm/versions/node/*/lib/node_modules/openclaw/dist/*.js 2>/dev/null | sort -u || echo 'none'` },
    { label: "dist: memoryFlush* keys", cmd: `grep -roh '"memoryFlush[a-zA-Z.]*"' ~/.nvm/versions/node/*/lib/node_modules/openclaw/dist/*.js 2>/dev/null | sort -u || echo 'none'` },
    { label: "dist: memorySearch* keys", cmd: `grep -roh '"memorySearch[a-zA-Z.]*"' ~/.nvm/versions/node/*/lib/node_modules/openclaw/dist/*.js 2>/dev/null | sort -u || echo 'none'` },
    { label: "dist: cron.* keys", cmd: `grep -roh '"cron\\.[a-zA-Z.]*"' ~/.nvm/versions/node/*/lib/node_modules/openclaw/dist/*.js 2>/dev/null | sort -u || echo 'none'` },
    { label: "dist: skills.load* keys", cmd: `grep -roh '"skills\\.load[a-zA-Z.]*"' ~/.nvm/versions/node/*/lib/node_modules/openclaw/dist/*.js 2>/dev/null | sort -u || echo 'none'` },
    { label: "dist: agents.defaults.* keys", cmd: `grep -roh '"agents\\.defaults\\.[a-zA-Z.]*"' ~/.nvm/versions/node/*/lib/node_modules/openclaw/dist/*.js 2>/dev/null | sort -u || echo 'none'` },
    { label: "dist: broader session grep", cmd: `grep -rn 'session.*maintenance\\|sessionMaint\\|session_maint\\|pruneAfter\\|maxSessionAge\\|maxSessions' ~/.nvm/versions/node/*/lib/node_modules/openclaw/dist/*.js 2>/dev/null | head -20 || echo 'none'` },
    { label: "dist: broader compaction grep", cmd: `grep -rn 'memoryFlush\\|memory_flush\\|flushBefore\\|preCompaction' ~/.nvm/versions/node/*/lib/node_modules/openclaw/dist/*.js 2>/dev/null | head -20 || echo 'none'` },
    { label: "dist: idle/reset grep", cmd: `grep -rn 'idleMinutes\\|session\\.reset\\|sessionReset\\|dailyReset' ~/.nvm/versions/node/*/lib/node_modules/openclaw/dist/*.js 2>/dev/null | head -20 || echo 'none'` },
  ];

  for (const d of discoveries) {
    console.log(`--- ${d.label} ---`);
    try {
      const out = await sshExec(conn, d.cmd, 30000);
      console.log(out.substring(0, 3000) || "(empty output)");
    } catch (e: any) {
      console.log(`ERROR: ${e.message}`);
    }
    console.log();
  }

  // ══════════════════════════════════════════════════════════
  // SECTION 3: Test each proposed config key
  // ══════════════════════════════════════════════════════════
  console.log("═══ SECTION 3: Config Key Testing ═══\n");

  const keysToTest: [string, string][] = [
    ["session.maintenance.enabled", "true"],
    ["session.maintenance.maxSessionAge", "7d"],
    ["session.maintenance.maxSessions", "50"],
    ["session.maintenance.cleanupInterval", "6h"],
    ["session.maintenance.archiveBeforeDelete", "true"],
    ["session.maintenance.preserveRecentHours", "24"],
    ["session.maintenance.indexRebuild", "true"],
    ["session.maintenance.maxIndexSize", "100000"],
    ["cron.sessionRetention", "24h"],
    ["agents.defaults.compaction.memoryFlush.enabled", "true"],
    ["agents.defaults.compaction.memoryFlush.softThresholdTokens", "4000"],
    ["agents.defaults.compaction.memoryFlush.systemPrompt", "Save important context to MEMORY.md"],
    ["agents.defaults.compaction.memoryFlush.prompt", "Save important context to MEMORY.md"],
    ["memorySearch.experimental.sessionMemory", "true"],
    ["skills.load.mode", "on_demand"],
    ["session.reset.daily", "04:00"],
    ["session.idleMinutes", "360"],
  ];

  const results: KeyTestResult[] = [];

  for (const [key, value] of keysToTest) {
    console.log(`Testing: ${key} = ${value}`);
    const result = await testConfigKey(conn, key, value);
    results.push(result);
    console.log(`  Verdict: ${result.verdict} — ${result.notes}`);
    console.log(`  Before:  ${result.beforeGet.substring(0, 100)}`);
    console.log(`  Set out: ${result.setOutput.substring(0, 100)}`);
    console.log(`  After:   ${result.afterGet.substring(0, 100)}`);
    console.log(`  Doctor:  ${result.doctorOutput.substring(0, 150)}`);
    console.log();
  }

  // ══════════════════════════════════════════════════════════
  // SECTION 4: Test --session isolated flag
  // ══════════════════════════════════════════════════════════
  console.log("═══ SECTION 4: --session isolated test ═══\n");

  // Count sessions before
  const sessionsBefore = await sshExec(conn, "ls ~/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | wc -l");
  console.log(`Sessions before: ${sessionsBefore}`);

  // List recent sessions
  const recentBefore = await sshExec(conn, "ls -lt ~/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | head -3");
  console.log(`Recent sessions (before):\n${recentBefore}\n`);

  // Test --session isolated
  console.log("Running: openclaw run --session isolated --message 'Phase 0 test'...");
  const isolatedResult = await sshExec(conn,
    `${NVM_PREAMBLE} && timeout 60 openclaw run --session isolated --message 'Phase 0 schema test - ignore this message. Reply with just OK.' 2>&1 || echo 'COMMAND_FAILED_OR_TIMEOUT'`,
    90000
  );
  console.log(`Result: ${isolatedResult.substring(0, 1000)}`);

  // Count sessions after
  const sessionsAfter = await sshExec(conn, "ls ~/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | wc -l");
  console.log(`\nSessions after: ${sessionsAfter}`);

  const recentAfter = await sshExec(conn, "ls -lt ~/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | head -5");
  console.log(`Recent sessions (after):\n${recentAfter}`);

  const isolatedVerdict = parseInt(sessionsAfter) > parseInt(sessionsBefore)
    ? "NEW_SESSION_CREATED"
    : parseInt(sessionsAfter) === parseInt(sessionsBefore)
    ? "NO_NEW_SESSION (may have reused existing or truly isolated)"
    : "SESSION_REMOVED (cleanup happened)";
  console.log(`\n--session isolated verdict: ${isolatedVerdict}`);

  // Also try without --session isolated for comparison
  console.log("\nAlso testing: openclaw run --help for all session-related flags...");
  const runHelp = await sshExec(conn, `${NVM_PREAMBLE} && openclaw run --help 2>&1`);
  console.log(runHelp.substring(0, 2000));

  // ══════════════════════════════════════════════════════════
  // SECTION 5: Post-test health check
  // ══════════════════════════════════════════════════════════
  console.log("\n═══ SECTION 5: Post-test Health ═══\n");

  const healthAfter = await sshExec(conn, 'curl -sf http://localhost:18789/health 2>&1 || echo "UNHEALTHY"');
  console.log(`Gateway health (after): ${healthAfter.substring(0, 200)}`);

  const doctorAfter = await sshExec(conn, `${NVM_PREAMBLE} && openclaw doctor 2>&1`, 30000);
  console.log(`Doctor (after):\n${doctorAfter}`);

  // ══════════════════════════════════════════════════════════
  // SECTION 6: Summary table
  // ══════════════════════════════════════════════════════════
  console.log("\n═══ FINAL SUMMARY ═══\n");
  console.log("┌─────────────────────────────────────────────────────────────┬──────────┐");
  console.log("│ Config Key                                                  │ Verdict  │");
  console.log("├─────────────────────────────────────────────────────────────┼──────────┤");
  for (const r of results) {
    const k = r.key.padEnd(60);
    const v = r.verdict.padEnd(8);
    console.log(`│ ${k}│ ${v} │`);
  }
  console.log("└─────────────────────────────────────────────────────────────┴──────────┘");

  const accepted = results.filter(r => r.verdict === "ACCEPTED").length;
  const rejected = results.filter(r => r.verdict === "REJECTED").length;
  const crashed = results.filter(r => r.verdict === "CRASH").length;
  const unknown = results.filter(r => r.verdict === "UNKNOWN").length;

  console.log(`\nAccepted: ${accepted}  Rejected: ${rejected}  Crash: ${crashed}  Unknown: ${unknown}`);
  console.log(`Gateway healthy after all tests: ${healthAfter.includes("UNHEALTHY") ? "NO" : "YES"}`);
  console.log(`--session isolated: ${isolatedVerdict}`);

  conn.end();
  console.log("\n=== Schema verification complete ===");
}

main().catch(console.error);
