/**
 * Triage vm-625 + vm-846 — head-of-line blockers identified post 5e949f0f.
 * Both healthy, both reachable, both reconciler-stuck for 22-35 days.
 *
 * Approach: SSH in, run a sequence of probes that mirror what the
 * reconciler does. First probe to fail = the reason cv hasn't bumped.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
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

import { connectSSH } from "../lib/ssh";

async function probe(vmName: string) {
  console.log(`\n========== ${vmName} ==========`);
  const { data: vm, error } = await sb
    .from("instaclaw_vms")
    .select("*")
    .eq("name", vmName)
    .single();
  if (error || !vm) {
    console.log("DB lookup failed:", error?.message);
    return;
  }
  console.log(
    `id=${vm.id} ip=${vm.ip_address} cv=${vm.config_version} health=${vm.health_status} assigned_to=${vm.assigned_to ?? "(none)"}`,
  );

  let ssh;
  const t0 = Date.now();
  try {
    ssh = await connectSSH(vm);
  } catch (e) {
    console.log(`SSH connect FAILED after ${Date.now() - t0}ms:`, (e as Error).message);
    return;
  }
  console.log(`SSH connected in ${Date.now() - t0}ms`);

  const cmds: Array<[string, string]> = [
    // Basic system
    ["uptime", "uptime"],
    ["disk", "df -h / | tail -1"],
    ["mem", "free -m | grep '^Mem:'"],

    // OpenClaw / gateway
    ["gateway-active", "export XDG_RUNTIME_DIR=/run/user/$(id -u) && systemctl --user is-active openclaw-gateway"],
    ["gateway-substate", "export XDG_RUNTIME_DIR=/run/user/$(id -u) && systemctl --user show openclaw-gateway -p SubState --value"],
    ["gateway-restarts", "export XDG_RUNTIME_DIR=/run/user/$(id -u) && systemctl --user show openclaw-gateway -p NRestarts --value"],
    ["openclaw-version", "source ~/.nvm/nvm.sh 2>/dev/null && openclaw --version 2>&1 || which openclaw 2>&1"],
    ["openclaw-bin", "ls -la $(npm root -g 2>/dev/null)/openclaw/dist/index.js 2>&1 | head -1"],
    ["node-version", "source ~/.nvm/nvm.sh 2>/dev/null; node --version 2>&1"],

    // Config readability — does `openclaw config get` even work?
    ["config-get-heartbeat", "source ~/.nvm/nvm.sh 2>/dev/null; openclaw config get agents.defaults.heartbeat.every 2>&1 | head -3"],
    // The exact key the reconciler tries to set every cycle (v90 Layer 2)
    ["config-get-compaction-mode", "source ~/.nvm/nvm.sh 2>/dev/null; openclaw config get agents.defaults.compaction.mode 2>&1 | head -3"],
    // Try a no-op set to see if the config-set path itself works
    ["config-set-noop", "source ~/.nvm/nvm.sh 2>/dev/null; openclaw config set agents.defaults.heartbeat.every 3h 2>&1 | head -5"],

    // Auth profiles
    ["auth-profiles-exists", "test -f ~/.openclaw/agents/main/agent/auth-profiles.json && echo OK || echo MISSING"],
    ["auth-profiles-size", "stat -c '%s' ~/.openclaw/agents/main/agent/auth-profiles.json 2>&1 || echo NOEXIST"],

    // Recent journalctl errors from openclaw-gateway (last 10 lines)
    ["recent-errors", "export XDG_RUNTIME_DIR=/run/user/$(id -u) && journalctl --user -u openclaw-gateway --since '24 hours ago' --no-pager 2>&1 | grep -iE '(error|fail|timeout|killed|sigterm)' | tail -10"],

    // The strict-mode/canary failure mode would surface in /health
    ["health", "curl -s -o /dev/null -w '%{http_code}' http://localhost:18789/health 2>&1"],

    // Manifest version sentinel — what does the on-disk openclaw.json have?
    ["json-config-existence", "test -f ~/.openclaw/openclaw.json && echo OK || echo MISSING"],
    ["json-compaction-mode", "grep -A1 'compaction' ~/.openclaw/openclaw.json 2>/dev/null | head -10 || echo PARSE_ERR"],
  ];

  for (const [label, cmd] of cmds) {
    try {
      const r = await Promise.race([
        ssh.execCommand(cmd),
        new Promise<{ code: -1; stdout: string; stderr: string }>((res) =>
          setTimeout(() => res({ code: -1, stdout: "", stderr: "<<TIMEOUT 15s>>" }), 15000),
        ),
      ]);
      const out = (r.stdout || r.stderr || "").trim().slice(0, 200).replace(/\n/g, " | ");
      console.log(`  [${label.padEnd(28)}] code=${r.code}  ${out}`);
    } catch (e) {
      console.log(`  [${label.padEnd(28)}] THREW: ${(e as Error).message}`);
    }
  }

  ssh.dispose();
}

async function main() {
  for (const name of ["instaclaw-vm-625", "instaclaw-vm-846"]) {
    await probe(name);
  }
}

main().then(() => process.exit(0));
