/**
 * Read-only SSH probe of a healthy cv=95 VM to reconcile the
 * cloud-init snapshot-bake-requirements doc against actual filesystem
 * reality. Per Cooper's directive 2026-05-14: setup.sh's classification
 * of SNAPSHOT_BAKED vs PER_USER files must match what's actually on the
 * baked snapshot — drift here means setup.sh skips files it shouldn't
 * or overwrites files it shouldn't.
 *
 * Target VM: vm-050 (Cooper's test agent) at cv=95.
 *
 * READ-ONLY — commands are find/ls/cat/crontab-l/dpkg-l. No state mutation.
 */
import * as path from "path";
import dotenv from "dotenv";
for (const f of [
  path.resolve(__dirname, "../.env.local"),
  path.resolve(__dirname, "../.env.ssh-key"),
]) {
  dotenv.config({ path: f });
}

import { createClient } from "@supabase/supabase-js";
import { connectSSH } from "../lib/ssh";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const TARGET_VM = process.env.PROBE_VM ?? "instaclaw-vm-050";

const PROBE = `
set +e

echo "=== 1. cv from openclaw.json (sanity check) ==="
test -f ~/.openclaw/openclaw.json && \\
  python3 -c "import json; d=json.load(open('/home/openclaw/.openclaw/openclaw.json')); print('agents.defaults.bootstrapMaxChars:', d.get('agents',{}).get('defaults',{}).get('bootstrapMaxChars'))" 2>&1

echo ""
echo "=== 2. .openclaw-pinned-version (snapshot-baked marker) ==="
test -f ~/.openclaw/.openclaw-pinned-version && cat ~/.openclaw/.openclaw-pinned-version || echo "MISSING"

echo ""
echo "=== 3. openclaw + node version ==="
. ~/.nvm/nvm.sh 2>/dev/null
openclaw --version 2>&1 | head -1
node --version 2>&1 | head -1

echo ""
echo "=== 4a. ~/.openclaw root files (non-session, non-cache) ==="
find ~/.openclaw -maxdepth 1 -type f 2>/dev/null | sort

echo ""
echo "=== 4b. ~/.openclaw/scripts/ inventory ==="
ls -la ~/.openclaw/scripts/ 2>&1 | head -40

echo ""
echo "=== 4c. ~/.openclaw/workspace/ inventory ==="
find ~/.openclaw/workspace -maxdepth 2 -type f -not -path "*/memory/*backup*" 2>/dev/null | sort

echo ""
echo "=== 4d. ~/.openclaw/workspace/memory/ inventory ==="
ls -la ~/.openclaw/workspace/memory/ 2>&1 | head -20

echo ""
echo "=== 4e. ~/.openclaw/agents/main/agent/ inventory (non-session files only) ==="
find ~/.openclaw/agents/main/agent -maxdepth 1 -type f 2>/dev/null | sort

echo ""
echo "=== 4f. ~/.openclaw/cron/ inventory ==="
ls -la ~/.openclaw/cron/ 2>&1 | head -10

echo ""
echo "=== 4g. ~/.openclaw/devices /audio-config /email-config /etc ==="
ls -la ~/.openclaw/ 2>&1 | grep -v -E "^total|^d.*sessions|\.bak|\.json\.[0-9]" | head -40

echo ""
echo "=== 5. ~/scripts/ outer-scripts inventory ==="
find ~/scripts -maxdepth 3 -type f 2>/dev/null | sort | head -50

echo ""
echo "=== 6. Skills installed (dir-listing) ==="
ls -la ~/.openclaw/skills/ 2>&1 | head -40

echo ""
echo "=== 7. crontab -l ==="
crontab -l 2>&1 | head -30

echo ""
echo "=== 8. systemd user drop-ins ==="
ls -la ~/.config/systemd/user/openclaw-gateway.service.d/ 2>&1

echo ""
echo "=== 9. systemd system unit drop-ins (ssh, dispatch, browser-relay) ==="
ls -la /etc/systemd/system/ssh.service.d/ 2>/dev/null | head -10
sudo ls -la /etc/systemd/system/ 2>/dev/null | grep -E "openclaw|dispatch|browser-relay|xvfb|x11vnc|websockify" | head -20

echo ""
echo "=== 10. apt packages (sample) ==="
dpkg -l 2>/dev/null | grep -E "^ii.*(ffmpeg|jq|build-essential|xvfb|xdotool|x11vnc|websockify|caddy|fail2ban|cron|python3-pip)" | awk '{print $2, $3}' | head -20

echo ""
echo "=== 11. pip packages (sample) ==="
pip3 list 2>/dev/null | grep -iE "openai|crawlee|web3|solders|eth-account|websockets|cryptography|base58|httpx" | head -15

echo ""
echo "=== 12. npm global packages ==="
. ~/.nvm/nvm.sh 2>/dev/null
npm list -g --depth=0 2>/dev/null | grep -E "openclaw|bankr|agentkit|prctl|usecomputer|mcporter" | head -10

echo ""
echo "=== 13. /usr/local/bin/chromium-browser ==="
ls -la /usr/local/bin/chromium-browser 2>&1 | head -2
which node_exporter 2>&1

echo ""
echo "=== 14. NVM node version + linger ==="
ls -d ~/.nvm/versions/node/v* 2>&1 | head -3
loginctl show-user openclaw 2>/dev/null | grep -E "Linger|UID" | head -3

echo ""
echo "=== 15. Counts ==="
echo ".openclaw files: $(find ~/.openclaw -type f 2>/dev/null | wc -l)"
echo ".openclaw scripts: $(find ~/.openclaw/scripts -type f 2>/dev/null | wc -l)"
echo "~/scripts files: $(find ~/scripts -type f 2>/dev/null | wc -l)"
echo "skills dirs: $(find ~/.openclaw/skills -maxdepth 1 -type d 2>/dev/null | tail -n +2 | wc -l)"
echo "crontab lines: $(crontab -l 2>/dev/null | wc -l)"
`;

async function main() {
  const { data: vm, error } = await sb
    .from("instaclaw_vms")
    .select("*")
    .eq("name", TARGET_VM)
    .single();
  if (error || !vm) {
    console.error(`FAIL: ${TARGET_VM} not found:`, error?.message);
    process.exit(1);
  }
  console.log(`Probing ${vm.name} (${vm.ip_address})`);
  console.log(`  cv=${vm.config_version} health=${vm.health_status} status=${vm.status}`);
  console.log(`  partner=${vm.partner ?? "null"} api_mode=${vm.api_mode}`);
  console.log("");

  let ssh;
  try {
    ssh = await connectSSH(vm);
  } catch (e) {
    console.error("SSH connect failed:", String(e));
    process.exit(2);
  }

  try {
    const result = await ssh.execCommand(PROBE);
    console.log(result.stdout);
    if (result.stderr.trim()) {
      console.log("─── stderr ───");
      console.log(result.stderr);
    }
  } finally {
    ssh.dispose();
  }
}

main().catch((e) => {
  console.error("Script error:", e);
  process.exit(1);
});
