/**
 * Acceptance test for configureOpenClaw() — the function that turns a fresh
 * ready-pool VM into an assigned, fully-configured user VM.
 *
 * Two phases:
 *
 *   1. STATIC validation — call buildOpenClawConfig() with a fake user and
 *      assert every key the reconciler enforces is present and correct.
 *      No SSH, no DB writes, no Linode calls.
 *
 *   2. (optional, --vm <id>) LIVE validation — pick a ready Linode VM,
 *      run configureOpenClaw on it, then SSH in and verify ALL items
 *      that should now exist on disk. Marks the VM as "test_consumed"
 *      after — DO NOT recycle to a real user.
 *
 * Usage:
 *   cd instaclaw
 *   npx tsx scripts/_test-configure-openclaw.ts                # static only
 *   npx tsx scripts/_test-configure-openclaw.ts --vm <vm-id>   # full live test
 *
 * Exit code: 0 if every assertion passes, 1 otherwise.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local manually so this script works without next.js
for (const f of [".env.local"]) {
  try {
    const c = readFileSync(resolve(".", f), "utf-8");
    for (const l of c.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m) {
        const k = m[1].trim();
        const v = m[2].trim().replace(/^["']|["']$/g, "");
        if (!process.env[k]) process.env[k] = v;
      }
    }
  } catch {}
}

import { buildOpenClawConfig, configureOpenClaw, connectSSH } from "../lib/ssh";
import { getSupabase } from "../lib/supabase";

// ─── Tiny assertion harness ────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    const msg = detail ? `${label} — ${detail}` : label;
    failures.push(msg);
    console.log(`  ❌ ${msg}`);
  }
}

// ─── PHASE 1: Static config validation ────────────────────────────────────

function runStaticChecks() {
  console.log("\n═══ Phase 1: buildOpenClawConfig() static validation ═══\n");

  const fakeConfig = {
    apiMode: "all_inclusive" as const,
    tier: "premium",
    channels: ["telegram"],
    telegramBotToken: "1234:fake",
    braveApiKey: "brave-fake",
  };

  const cfg = buildOpenClawConfig(
    fakeConfig,
    "fake-gateway-token-abc123",
    "https://proxy.fake.example",
    "anthropic/claude-opus-4-6",
    "brave-fake",
  ) as Record<string, unknown>;

  // Walk helper
  const get = (path: string): unknown => {
    return path.split(".").reduce<unknown>((o, k) => {
      if (o && typeof o === "object") return (o as Record<string, unknown>)[k];
      return undefined;
    }, cfg);
  };

  // P0 #1 — sandbox.mode = off
  check(
    "agents.defaults.sandbox.mode === 'off'",
    get("agents.defaults.sandbox.mode") === "off",
    `got ${JSON.stringify(get("agents.defaults.sandbox.mode"))}`,
  );

  // P0 #2 — streaming (NOT streamMode)
  check(
    "channels.telegram.streaming === 'partial'",
    get("channels.telegram.streaming") === "partial",
    `got ${JSON.stringify(get("channels.telegram.streaming"))}`,
  );
  check(
    "channels.telegram.streamMode is ABSENT (legacy key)",
    get("channels.telegram.streamMode") === undefined,
    `got ${JSON.stringify(get("channels.telegram.streamMode"))}`,
  );

  // P1 #5 — config keys
  check(
    "channels.telegram.groupPolicy === 'open'",
    get("channels.telegram.groupPolicy") === "open",
  );
  check(
    "channels.telegram.groups['*'].requireMention === false",
    get("channels.telegram.groups.*.requireMention") === false ||
      ((): boolean => {
        const g = get("channels.telegram.groups") as Record<string, unknown> | undefined;
        const star = g?.["*"] as Record<string, unknown> | undefined;
        return star?.requireMention === false;
      })(),
  );
  check("commands.useAccessGroups === false", get("commands.useAccessGroups") === false);
  check("tools.exec.security === 'full'", get("tools.exec.security") === "full");
  check("tools.exec.ask === 'off'", get("tools.exec.ask") === "off");
  check(
    "agents.defaults.compaction.reserveTokensFloor === 35000",
    get("agents.defaults.compaction.reserveTokensFloor") === 35000,
  );

  // Sanity: existing keys still present
  check("session.reset.mode === 'idle'", get("session.reset.mode") === "idle");
  check("session.reset.idleMinutes === 10080", get("session.reset.idleMinutes") === 10080);
  check(
    "agents.defaults.heartbeat.session === 'heartbeat'",
    get("agents.defaults.heartbeat.session") === "heartbeat",
  );
  check(
    "skills.limits.maxSkillsPromptChars === 500000",
    get("skills.limits.maxSkillsPromptChars") === 500000,
  );
  check("gateway.auth.token is set", typeof get("gateway.auth.token") === "string");
}

// ─── PHASE 2: Live VM validation (only with --vm) ─────────────────────────

interface RemoteCheck {
  label: string;
  cmd: string;
  expect: (stdout: string) => boolean;
}

const REMOTE_CHECKS: RemoteCheck[] = [
  // ── 5 platform scripts ──
  { label: "strip-thinking.py present", cmd: "test -x ~/.openclaw/scripts/strip-thinking.py && echo OK", expect: (s) => s.includes("OK") },
  { label: "vm-watchdog.py present", cmd: "test -x ~/.openclaw/scripts/vm-watchdog.py && echo OK", expect: (s) => s.includes("OK") },
  { label: "silence-watchdog.py present", cmd: "test -x ~/.openclaw/scripts/silence-watchdog.py && echo OK", expect: (s) => s.includes("OK") },
  { label: "push-heartbeat.sh present", cmd: "test -x ~/.openclaw/scripts/push-heartbeat.sh && echo OK", expect: (s) => s.includes("OK") },
  { label: "auto-approve-pairing.py present", cmd: "test -x ~/.openclaw/scripts/auto-approve-pairing.py && echo OK", expect: (s) => s.includes("OK") },

  // ── 4 workspace files ──
  { label: "SOUL.md present", cmd: "test -f ~/.openclaw/workspace/SOUL.md && echo OK", expect: (s) => s.includes("OK") },
  { label: "CAPABILITIES.md present", cmd: "test -f ~/.openclaw/workspace/CAPABILITIES.md && echo OK", expect: (s) => s.includes("OK") },
  { label: "EARN.md present", cmd: "test -f ~/.openclaw/workspace/EARN.md && echo OK", expect: (s) => s.includes("OK") },
  { label: "MEMORY.md present", cmd: "test -f ~/.openclaw/workspace/MEMORY.md && echo OK", expect: (s) => s.includes("OK") },

  // ── 5 SOUL.md sections (markers) ──
  { label: "SOUL.md has INTELLIGENCE_INTEGRATED marker", cmd: "grep -q INTELLIGENCE_INTEGRATED ~/.openclaw/workspace/SOUL.md && echo OK", expect: (s) => s.includes("OK") },
  { label: "SOUL.md has Learned Preferences", cmd: "grep -q 'Learned Preferences' ~/.openclaw/workspace/SOUL.md && echo OK", expect: (s) => s.includes("OK") },
  { label: "SOUL.md has 'NEVER self-restart' principle", cmd: "grep -q 'NEVER self-restart' ~/.openclaw/workspace/SOUL.md && echo OK", expect: (s) => s.includes("OK") },
  { label: "SOUL.md has DEGENCLAW_AWARENESS_V1", cmd: "grep -q DEGENCLAW_AWARENESS_V1 ~/.openclaw/workspace/SOUL.md && echo OK", expect: (s) => s.includes("OK") },
  { label: "SOUL.md has MEMORY_FILING_SYSTEM_V1", cmd: "grep -q MEMORY_FILING_SYSTEM_V1 ~/.openclaw/workspace/SOUL.md && echo OK", expect: (s) => s.includes("OK") },

  // ── openclaw.json critical keys ──
  { label: "openclaw.json: sandbox.mode = off", cmd: "jq -r '.agents.defaults.sandbox.mode' ~/.openclaw/openclaw.json", expect: (s) => s.trim() === "off" },
  { label: "openclaw.json: telegram.streaming = partial", cmd: "jq -r '.channels.telegram.streaming' ~/.openclaw/openclaw.json", expect: (s) => s.trim() === "partial" },
  { label: "openclaw.json: telegram.streamMode ABSENT", cmd: "jq -r '.channels.telegram.streamMode // \"absent\"' ~/.openclaw/openclaw.json", expect: (s) => s.trim() === "absent" },
  { label: "openclaw.json: tools.exec.security = full", cmd: "jq -r '.tools.exec.security' ~/.openclaw/openclaw.json", expect: (s) => s.trim() === "full" },
  { label: "openclaw.json: tools.exec.ask = off", cmd: "jq -r '.tools.exec.ask' ~/.openclaw/openclaw.json", expect: (s) => s.trim() === "off" },
  { label: "openclaw.json: telegram.groupPolicy = open", cmd: "jq -r '.channels.telegram.groupPolicy' ~/.openclaw/openclaw.json", expect: (s) => s.trim() === "open" },
  { label: "openclaw.json: commands.useAccessGroups = false", cmd: "jq -r '.commands.useAccessGroups' ~/.openclaw/openclaw.json", expect: (s) => s.trim() === "false" },
  { label: "openclaw.json: reserveTokensFloor = 35000", cmd: "jq -r '.agents.defaults.compaction.reserveTokensFloor' ~/.openclaw/openclaw.json", expect: (s) => s.trim() === "35000" },

  // ── gateway health ──
  { label: "openclaw-gateway is active", cmd: "export XDG_RUNTIME_DIR=/run/user/$(id -u) && systemctl --user is-active openclaw-gateway", expect: (s) => s.trim() === "active" },
  { label: "gateway health endpoint returns 200", cmd: "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8800/health", expect: (s) => s.trim() === "200" },
];

async function runLiveChecks(vmId: string) {
  console.log(`\n═══ Phase 2: Live VM validation against ${vmId} ═══\n`);

  const supabase = getSupabase();
  const { data: vm, error } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, status, provider, assigned_to")
    .eq("id", vmId)
    .single();

  if (error || !vm) throw new Error(`VM ${vmId} not found: ${error?.message}`);
  if (vm.provider !== "linode") throw new Error(`Refusing to test non-Linode VM (provider=${vm.provider})`);

  console.log(`VM ${vm.id} @ ${vm.ip_address} (status=${vm.status}, assigned_to=${vm.assigned_to ?? "none"})`);

  if (vm.assigned_to) {
    throw new Error(`VM is assigned to ${vm.assigned_to} — refusing to run destructive test on a live user's VM`);
  }

  // Run configureOpenClaw with a test user
  console.log("\n→ Running configureOpenClaw...");
  await configureOpenClaw(vm as any, {
    apiMode: "all_inclusive",
    tier: "premium",
    channels: ["telegram"],
    telegramBotToken: process.env.TEST_TELEGRAM_BOT_TOKEN || "1234:fake-test-token-do-not-use",
    userName: "Acceptance Test",
    userEmail: "acceptance-test@instaclaw.io",
    botUsername: "AcceptanceTestBot",
    userTimezone: "America/New_York",
  } as any);

  console.log("→ configureOpenClaw completed. SSHing in to verify...\n");

  const ssh = await connectSSH(vm as any);
  try {
    for (const c of REMOTE_CHECKS) {
      const r = await ssh.execCommand(c.cmd);
      check(c.label, c.expect(r.stdout || ""), `stdout=${(r.stdout || "").trim().slice(0, 60)} stderr=${(r.stderr || "").trim().slice(0, 60)}`);
    }
  } finally {
    ssh.dispose();
  }

  console.log("\n⚠️  This VM was wiped + reconfigured for testing. Mark it failed and recycle:");
  console.log(`    UPDATE instaclaw_vms SET status='failed' WHERE id='${vm.id}';`);
}

// ─── main ────────────────────────────────────────────────────────────────

async function main() {
  runStaticChecks();

  const vmFlagIdx = process.argv.indexOf("--vm");
  if (vmFlagIdx !== -1 && process.argv[vmFlagIdx + 1]) {
    await runLiveChecks(process.argv[vmFlagIdx + 1]);
  } else {
    console.log("\n(Static checks only. Pass --vm <id> for full live verification.)");
  }

  console.log(`\n═══ Result: ${passed} passed, ${failed} failed ═══`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n❌ Test crashed:", err);
  process.exit(1);
});
