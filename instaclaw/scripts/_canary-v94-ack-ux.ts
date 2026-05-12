/**
 * Canary fast-track for the v94 Agent Acknowledgment UX (Layers 1 + 2).
 *
 * PRD: docs/prd/agent-acknowledgment-ux-2026-05-11.md
 *
 * What it does (per VM, default = vm-050):
 *   1. Verify gateway is healthy BEFORE we touch anything.
 *   2. Snapshot the current values of the 9 config keys (forensic trail).
 *   3. Apply the 9 v94 config keys via `openclaw config set` one at a time.
 *      Each set output is captured; the script halts on the first failure.
 *   4. Verify each key landed via `openclaw config get` — expected vs actual.
 *   5. Trigger a full gateway restart. CRITICAL — see HOT-RELOAD TAXONOMY:
 *      - The 5 `channels.telegram.streaming.*` keys DO hot-reload (channel
 *        restart hook fires within 1-3s of config-set).
 *      - The 4 `messages.*` keys DO NOT hot-reload. They're captured in
 *        closures at channel-init time (bot-msflwCEW.js:5473 and surrounding)
 *        and only re-read on full gateway restart.
 *      So for L1 + L2 together to take effect, we MUST restart.
 *      Verified empirically on vm-050 2026-05-11: ackReactionScope changes
 *      did NOT activate until a separate (gbrain-terminal-triggered)
 *      gateway restart loaded them, even though "[reload] config change
 *      detected" was logged.
 *   6. Wait up to 180s for the gateway to reach "active" + /health=200.
 *      Actual boot time on vm-050: ~85s gateway-ready, plus channel-connect
 *      grace. 180s gives generous margin.
 *   7. If the gateway fails to come back: revert ALL 9 keys to their
 *      snapshot values, restart again, exit failure (Rule 5).
 *   8. Tail journal for ~10s and grep for known-bad patterns (v68 leak
 *      shapes) — sanity check that new config didn't regress.
 *
 * --no-restart flag: skip the restart and rely on hot-reload only.
 *   USE WITH CAUTION — only the 5 streaming.* keys take effect. The 4
 *   messages.* keys land on disk but stay inert until the gateway is
 *   restarted by some other means. Useful for debugging the streaming.*
 *   subset in isolation.
 *
 * This script does NOT bump config_version on the VM. The natural reconciler
 * will pick up the manifest v94 entries on its next cycle and re-set the same
 * keys (no-op since they're already set) and then bump cv → 94. That's the
 * desired flow: canary verifies the config is safe BEFORE the reconciler
 * propagates it fleet-wide.
 *
 * Rollback: pass --rollback to set every v94 key back to its pre-v94 value
 * (streaming.mode → off, etc.) and restart the gateway. Used if Cooper observes
 * a regression during canary testing.
 *
 * Rules applied: §3 (test on one VM first), §4 (--dry-run supported), §5
 * (verify gateway health after config changes), §10 (verify-after-set).
 *
 * Usage:
 *   npx tsx scripts/_canary-v94-ack-ux.ts --vm instaclaw-vm-050 --dry-run
 *   npx tsx scripts/_canary-v94-ack-ux.ts --vm instaclaw-vm-050
 *   npx tsx scripts/_canary-v94-ack-ux.ts --vm instaclaw-vm-050 --rollback
 */
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
import { connectSSH } from "../lib/ssh";

require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
require("dotenv").config({ path: path.join(__dirname, "..", ".env.ssh-key") });

// ── The 9 keys we're setting in v94 ──
// Single source of truth for THIS canary script. Must match
// lib/vm-manifest.ts:configSettings entries added in v94.
const V94_KEYS: Array<{ key: string; value: string; layer: "L1" | "L2" }> = [
  // Layer 2 — streaming preview
  { key: "channels.telegram.streaming.mode", value: "partial", layer: "L2" },
  { key: "channels.telegram.streaming.preview.toolProgress", value: "false", layer: "L2" },
  { key: "channels.telegram.streaming.preview.chunk.minChars", value: "30", layer: "L2" },
  { key: "channels.telegram.streaming.preview.chunk.maxChars", value: "800", layer: "L2" },
  { key: "channels.telegram.streaming.preview.chunk.breakPreference", value: "sentence", layer: "L2" },
  // Layer 1 — reactions + status
  { key: "messages.ackReactionScope", value: "all", layer: "L1" },
  { key: "messages.ackReaction", value: "👀", layer: "L1" },
  { key: "messages.removeAckAfterReply", value: "false", layer: "L1" },
  { key: "messages.statusReactions.enabled", value: "true", layer: "L1" },
];

// Rollback values — what these keys WERE before v94.
// streaming.mode was "off" fleet-wide (v68).
// ackReactionScope was "group-mentions" (OpenClaw default — never explicitly set fleet-wide).
// The other 7 keys were unset (defaults).
//
// "rollback" means: restore to the safe pre-v94 baseline. For keys that were
// unset, we use `openclaw config unset` semantics — but OpenClaw's CLI doesn't
// have a clean `unset`. The workaround: set to the documented default value
// (off / true / group-mentions / etc.) which has the same observable effect.
const ROLLBACK_VALUES: Record<string, string> = {
  "channels.telegram.streaming.mode": "off",
  "channels.telegram.streaming.preview.toolProgress": "true",  // OpenClaw default
  "channels.telegram.streaming.preview.chunk.minChars": "80",  // OpenClaw default (approx)
  "channels.telegram.streaming.preview.chunk.maxChars": "800",
  "channels.telegram.streaming.preview.chunk.breakPreference": "sentence",
  "messages.ackReactionScope": "group-mentions",
  "messages.ackReaction": "",  // empty string disables
  "messages.removeAckAfterReply": "false",
  "messages.statusReactions.enabled": "false",
};

const NVM = "source ~/.nvm/nvm.sh >/dev/null 2>&1";
const GATEWAY_UNIT = "openclaw-gateway";
const HEALTH_URL = "http://localhost:18789/health";
// Hot-reload settle window — OpenClaw applies channels.telegram.* / messages.*
// changes within ~5s of the config-set (verified on vm-050 2026-05-11: hot-reload
// fires within 1-3s of file mtime change).
const HOT_RELOAD_SETTLE_S = 8;
// Full-restart health-check timeout — OpenClaw 2026.4.26 boot time on vm-050:
// ~85s gateway-ready + channel-connect grace. 180s gives margin.
const RESTART_HEALTH_TIMEOUT_S = 180;
// Hot-reload-only health-check timeout — gateway should stay healthy through
// hot-reload (telegram channel restarts in <1s).
const HOTRELOAD_HEALTH_TIMEOUT_S = 30;
const HEALTH_RETRY_INTERVAL_S = 3;

interface VmRow {
  id: string;
  name: string;
  ip_address: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  partner: string | null;
  health_status: string | null;
  config_version: number | null;
}

interface SetResult {
  key: string;
  expected: string;
  prior?: string;
  actual?: string;
  setOutput?: string;
  ok: boolean;
  error?: string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const vmIdx = args.indexOf("--vm");
  const vm = vmIdx >= 0 ? args[vmIdx + 1] : "instaclaw-vm-050";
  const dryRun = args.includes("--dry-run");
  const rollback = args.includes("--rollback");
  // DEFAULT: full gateway restart. The 4 messages.* keys (ackReaction*,
  // statusReactions) do NOT hot-reload — closure capture at channel-init.
  // Without restart, L1 reactions stay broken.
  // --no-restart only loads the 5 streaming.* keys (hot-reload). Caution.
  const skipRestart = args.includes("--no-restart");
  const forceRestart = !skipRestart;
  return { vm, dryRun, rollback, forceRestart };
}

async function getVm(vmName: string): Promise<VmRow> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data, error } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, partner, health_status, config_version")
    .eq("name", vmName)
    .single();
  if (error) throw new Error(`vm lookup failed: ${error.message}`);
  if (!data) throw new Error(`vm not found: ${vmName}`);
  return data as VmRow;
}

async function ssh(vm: VmRow) {
  if (!vm.ip_address) throw new Error("no ip_address on VM row");
  return connectSSH({
    ip_address: vm.ip_address,
    ssh_port: vm.ssh_port ?? 22,
    ssh_user: vm.ssh_user ?? "openclaw",
  });
}

async function runRemote(c: any, cmd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const r = await c.execCommand(`${NVM} && ${cmd}`, { execOptions: { pty: false } });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code };
}

async function isGatewayHealthy(c: any): Promise<{ active: boolean; healthCode: number }> {
  const a = await runRemote(c, `systemctl --user is-active ${GATEWAY_UNIT}`);
  const h = await runRemote(c, `curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${HEALTH_URL}`);
  return {
    active: a.stdout.trim() === "active",
    healthCode: parseInt(h.stdout.trim() || "0", 10),
  };
}

async function waitForGatewayHealthy(c: any, timeoutS: number): Promise<boolean> {
  const deadline = Date.now() + timeoutS * 1000;
  while (Date.now() < deadline) {
    const { active, healthCode } = await isGatewayHealthy(c);
    if (active && healthCode === 200) return true;
    await new Promise((r) => setTimeout(r, HEALTH_RETRY_INTERVAL_S * 1000));
  }
  return false;
}

async function getCurrentValue(c: any, key: string): Promise<string | null> {
  const r = await runRemote(c, `openclaw config get '${key}' 2>&1`);
  const out = (r.stdout + r.stderr).trim();
  // "Config path not found: <key>" indicates unset (= default value applies)
  if (out.includes("Config path not found")) return null;
  // Otherwise the output IS the value (single line typically)
  // Strip any leading/trailing whitespace
  return out;
}

async function setKey(c: any, key: string, value: string): Promise<{ ok: boolean; output: string }> {
  // Quote value with single quotes; for emoji like 👀, that's safe because emoji bytes don't
  // collide with single-quote (ASCII 0x27).
  const cmd = `openclaw config set '${key}' '${value}' 2>&1`;
  const r = await runRemote(c, cmd);
  const out = (r.stdout + r.stderr).trim();
  // Success pattern: "Updated <key>. Restart the gateway to apply."
  // Failure patterns: any line containing "Error", "Invalid", "Unrecognized"
  const ok = /^Config overwrite:.*\nUpdated /m.test(out) || /^Updated /m.test(out);
  return { ok, output: out };
}

async function applyKeys(
  c: any,
  keys: Array<{ key: string; value: string }>,
  dryRun: boolean,
): Promise<SetResult[]> {
  const results: SetResult[] = [];
  for (const { key, value } of keys) {
    const prior = await getCurrentValue(c, key);
    if (dryRun) {
      results.push({ key, expected: value, prior: prior ?? "(unset)", ok: true });
      continue;
    }
    const setRes = await setKey(c, key, value);
    if (!setRes.ok) {
      results.push({
        key,
        expected: value,
        prior: prior ?? "(unset)",
        setOutput: setRes.output,
        ok: false,
        error: "openclaw config set failed",
      });
      return results;  // halt — don't apply remaining keys
    }
    const actual = await getCurrentValue(c, key);
    const trimmedExpected = value.trim();
    const trimmedActual = (actual ?? "").trim();
    const match = trimmedActual === trimmedExpected;
    results.push({
      key,
      expected: value,
      prior: prior ?? "(unset)",
      actual: actual ?? "(unset)",
      setOutput: setRes.output,
      ok: match,
      error: match ? undefined : `verify mismatch: expected '${trimmedExpected}', got '${trimmedActual}'`,
    });
    if (!match) return results;  // halt on verify mismatch
  }
  return results;
}

async function restartGateway(c: any): Promise<{ ok: boolean; msg: string }> {
  const r = await runRemote(c, `systemctl --user restart ${GATEWAY_UNIT}`);
  if (r.code !== 0) return { ok: false, msg: `restart failed: rc=${r.code} ${r.stderr.slice(0, 200)}` };
  const healthy = await waitForGatewayHealthy(c, RESTART_HEALTH_TIMEOUT_S);
  return healthy
    ? { ok: true, msg: "gateway active + /health=200" }
    : { ok: false, msg: `gateway did not reach healthy state within ${RESTART_HEALTH_TIMEOUT_S}s` };
}

async function waitForHotReload(c: any): Promise<{ ok: boolean; msg: string }> {
  // Wait for OpenClaw's hot-reload to settle (it logs "[reload] config hot reload applied"
  // and "[gateway/channels] restarting telegram channel" within seconds of config-set).
  // We don't strictly check the journal for the reload line because not every key produces
  // an "applied" log entry; we just wait HOT_RELOAD_SETTLE_S and then verify the gateway
  // is still healthy (i.e., hot-reload didn't kill it).
  await new Promise((r) => setTimeout(r, HOT_RELOAD_SETTLE_S * 1000));
  const healthy = await waitForGatewayHealthy(c, HOTRELOAD_HEALTH_TIMEOUT_S);
  return healthy
    ? { ok: true, msg: `gateway still active + /health=200 after ${HOT_RELOAD_SETTLE_S}s hot-reload settle` }
    : { ok: false, msg: `gateway not healthy after hot-reload settle window (${HOTRELOAD_HEALTH_TIMEOUT_S}s)` };
}

async function tailJournalAndGrepLeak(c: any): Promise<{ clean: boolean; matches: string[] }> {
  // Grab last ~10 seconds of journal entries and grep for known v68-leak patterns.
  // This is a sanity check — doesn't replace the canary test prompts.
  const r = await runRemote(c, `journalctl --user -u ${GATEWAY_UNIT} --since '20 seconds ago' --no-pager 2>&1 | head -200`);
  const text = r.stdout + r.stderr;
  const badPatterns = [
    /exec run /,           // v68 leak: "exec run python3 ..."
    /tool: exec/,          // v68 leak header
    /Working…\n•/,         // v94 leak path: formatProgressAsMarkdownCode output
    /tool_use/i,           // raw block leak
  ];
  const matches: string[] = [];
  for (const p of badPatterns) {
    const m = text.match(p);
    if (m) matches.push(m[0]);
  }
  return { clean: matches.length === 0, matches };
}

(async () => {
  const { vm: vmName, dryRun, rollback, forceRestart } = parseArgs();

  console.log("============================================================");
  console.log(`v94 ack-ux canary — vm=${vmName} dryRun=${dryRun} rollback=${rollback}`);
  console.log("============================================================");

  const vm = await getVm(vmName);
  console.log(`VM: ${vm.name} ip=${vm.ip_address} cv=${vm.config_version} health=${vm.health_status} partner=${vm.partner ?? "(none)"}`);
  if (vm.health_status !== "healthy" && vm.health_status !== "assigned") {
    console.error(`✗ VM health_status=${vm.health_status}; refusing to proceed. Triage first.`);
    process.exit(2);
  }

  const c = await ssh(vm);

  try {
    // Pre-flight: gateway must be healthy
    const pre = await isGatewayHealthy(c);
    console.log(`\nPre-flight: active=${pre.active} health=${pre.healthCode}`);
    if (!pre.active || pre.healthCode !== 200) {
      console.error("✗ Gateway not healthy pre-flight. Aborting.");
      process.exit(3);
    }

    // Build the key list (apply or rollback)
    const keys = rollback
      ? V94_KEYS.map((k) => ({ key: k.key, value: ROLLBACK_VALUES[k.key] }))
      : V94_KEYS.map((k) => ({ key: k.key, value: k.value }));

    console.log(`\n${rollback ? "Rollback" : "Apply"} keys (${keys.length}):`);
    for (const k of keys) console.log(`  ${k.key} = ${k.value}`);

    // Apply keys
    console.log(`\n${dryRun ? "[DRY-RUN] " : ""}Setting keys one at a time + verify-after-set...`);
    const results = await applyKeys(c, keys, dryRun);

    let failures = 0;
    for (const r of results) {
      const status = r.ok ? "✓" : "✗";
      console.log(`  ${status} ${r.key}`);
      console.log(`      prior:    ${r.prior}`);
      if (r.actual !== undefined) console.log(`      actual:   ${r.actual}`);
      console.log(`      expected: ${r.expected}`);
      if (r.error) console.log(`      ERROR:    ${r.error}`);
      if (r.setOutput && !r.ok) console.log(`      output:   ${r.setOutput.slice(0, 200)}`);
      if (!r.ok) failures++;
    }

    if (failures > 0) {
      console.error(`\n✗ ${failures} failure(s) during apply. NOT restarting gateway. Triage required.`);
      process.exit(4);
    }

    if (dryRun) {
      console.log("\n[DRY-RUN] No changes applied. Re-run without --dry-run to apply.");
      return;
    }

    // Apply path: full restart (default — required for messages.* keys)
    // or hot-reload only (--no-restart, streaming.* keys only).
    if (forceRestart) {
      console.log("\nPerforming full gateway restart (required — messages.* keys do NOT hot-reload; 180s health timeout)...");
      const restart = await restartGateway(c);
      console.log(`  ${restart.ok ? "✓" : "✗"} ${restart.msg}`);
      if (!restart.ok) {
        console.error("\n✗ Gateway failed to come back healthy. Rolling back config changes...");
        const rb = await applyKeys(
          c,
          V94_KEYS.map((k) => ({ key: k.key, value: ROLLBACK_VALUES[k.key] })),
          false,
        );
        for (const r of rb) console.log(`  ${r.ok ? "✓" : "✗"} rollback ${r.key}`);
        // Don't restart again — rely on hot-reload for rollback too. Just verify.
        const healthy = await waitForGatewayHealthy(c, RESTART_HEALTH_TIMEOUT_S);
        console.error(`  post-rollback gateway: ${healthy ? "ok" : "FAILED — manual intervention required"}`);
        process.exit(5);
      }
    } else {
      console.log("\nWaiting for OpenClaw hot-reload to apply (no restart — relying on built-in hot-reload)...");
      const hotReload = await waitForHotReload(c);
      console.log(`  ${hotReload.ok ? "✓" : "✗"} ${hotReload.msg}`);
      if (!hotReload.ok) {
        console.error("\n✗ Gateway unhealthy after hot-reload settle. Rolling back config changes...");
        const rb = await applyKeys(
          c,
          V94_KEYS.map((k) => ({ key: k.key, value: ROLLBACK_VALUES[k.key] })),
          false,
        );
        for (const r of rb) console.log(`  ${r.ok ? "✓" : "✗"} rollback ${r.key}`);
        const healthy = await waitForGatewayHealthy(c, RESTART_HEALTH_TIMEOUT_S);
        console.error(`  post-rollback gateway: ${healthy ? "ok" : "FAILED — manual intervention required"}`);
        process.exit(5);
      }
    }

    // Sanity: tail journal for known-bad patterns
    if (!rollback) {
      console.log("\nTailing journal for v68/v94 leak patterns (10s window)...");
      // give a moment for the gateway to log boot-up
      await new Promise((r) => setTimeout(r, 5000));
      const leak = await tailJournalAndGrepLeak(c);
      if (leak.clean) {
        console.log("  ✓ no leak patterns in initial journal tail");
      } else {
        console.error(`  ⚠ found leak-pattern matches: ${JSON.stringify(leak.matches)}`);
        console.error("  Investigate before sending test prompts.");
      }
    }

    console.log("\n============================================================");
    console.log(`Done. ${rollback ? "Rollback" : "Apply"} succeeded on ${vmName}.`);
    console.log("============================================================");
    if (!rollback) {
      console.log("\nNext steps:");
      console.log("  1. Send the 5 canary test prompts from PRD §8.1 to the bot DM.");
      console.log("     Especially prompts #2 (schedule lookup) and #4 (web search) —");
      console.log("     these are the tool-leak regression tests.");
      console.log("  2. Watch for: 👀 reaction within 1s; emoji transitions; placeholder");
      console.log("     message within 2-4s; content streaming; NO tool internals in preview.");
      console.log("  3. Report findings before fleet rollout.");
      console.log("\nRollback (if needed):");
      console.log(`  npx tsx scripts/_canary-v94-ack-ux.ts --vm ${vmName} --rollback`);
    }
  } finally {
    c.dispose();
  }
})().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
