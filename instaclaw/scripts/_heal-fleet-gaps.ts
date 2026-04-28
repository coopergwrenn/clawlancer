/**
 * Workstream 1: heal the 5 remaining configureOpenClaw gaps fleet-wide.
 *
 *   1. XMTP missing/inactive  (~42 VMs)
 *   2. Bankr skill missing    (~21 VMs)
 *   3. SHM_CLEANUP cron miss  (~16 VMs)
 *   4. node_exporter missing  (~14 VMs)
 *   5. gateway-watchdog timer (~12 VMs)
 *
 * Modes:
 *   --probe                  classify all VMs, no changes
 *   --heal-bankr             apply bankr heal
 *   --heal-shm               apply SHM_CLEANUP heal
 *   --heal-watchdog          apply gateway-watchdog heal
 *   --heal-node-exporter     apply node_exporter heal
 *   --heal-xmtp              apply XMTP heal
 *   --heal-all               all five in order
 *
 * Each heal mode probes its own targets (idempotent); safe to re-run.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { resolve } from "path";

const envLocal = readFileSync(resolve(".", ".env.local"), "utf-8");
for (const l of envLocal.split("\n")) {
  const m = l.match(/^([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const envVercel = readFileSync(resolve(".", ".env.vercel"), "utf-8");
for (const l of envVercel.split("\n")) {
  const m = l.match(/^([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const SSH_KEY = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const PROBE = process.argv.includes("--probe");
const HEAL_ALL = process.argv.includes("--heal-all");
const HEAL_BANKR = HEAL_ALL || process.argv.includes("--heal-bankr");
const HEAL_SHM = HEAL_ALL || process.argv.includes("--heal-shm");
const HEAL_WATCHDOG = HEAL_ALL || process.argv.includes("--heal-watchdog");
const HEAL_NODE_EXPORTER = HEAL_ALL || process.argv.includes("--heal-node-exporter");
const HEAL_XMTP = HEAL_ALL || process.argv.includes("--heal-xmtp");

if (!PROBE && !HEAL_BANKR && !HEAL_SHM && !HEAL_WATCHDOG && !HEAL_NODE_EXPORTER && !HEAL_XMTP) {
  console.error("Pass --probe or one of --heal-bankr / --heal-shm / --heal-watchdog / --heal-node-exporter / --heal-xmtp / --heal-all");
  process.exit(1);
}

interface VM { id: string; name: string; ip_address: string; tier: string; gateway_token: string; xmtp_address: string | null; }

async function loadVms(): Promise<VM[]> {
  const { data } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address, tier, gateway_token, xmtp_address")
    .eq("status", "assigned")
    .eq("health_status", "healthy")
    .like("name", "instaclaw-vm-%")
    .not("gateway_token", "is", null)
    .order("name");
  return (data || []) as any;
}

async function withSsh<T>(vm: VM, fn: (ssh: NodeSSH) => Promise<T>, fallback: T): Promise<T> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: vm.ip_address, port: 22, username: "openclaw", privateKey: SSH_KEY, readyTimeout: 10000 });
    const result = await fn(ssh);
    ssh.dispose();
    return result;
  } catch (e: any) {
    try { ssh.dispose(); } catch {}
    return fallback;
  }
}

async function batched<T, R>(items: T[], batchSize: number, fn: (item: T) => Promise<R>, label?: string): Promise<R[]> {
  const results: R[] = [];
  const queue = [...items];
  while (queue.length) {
    const batch = queue.splice(0, batchSize);
    results.push(...await Promise.all(batch.map(fn)));
    if (label) process.stderr.write(`  ${label}: ${results.length}/${items.length}\r`);
  }
  if (label) console.error("");
  return results;
}

// ── PROBE ──
async function probe(vms: VM[]) {
  console.log(`Probing ${vms.length} VMs across 5 categories...`);
  const probeCmd = `bash -c '
yn() { eval "$@" >/dev/null 2>&1 && echo "1" || echo "0"; }
echo bankr=$(yn "test -d \\$HOME/.openclaw/skills/bankr")
echo shm=$(yn "crontab -l 2>/dev/null | grep -q SHM_CLEANUP")
echo watchdog=$(yn "systemctl --user is-active gateway-watchdog.timer 2>&1 | grep -q ^active$")
echo watchdog_unit=$(yn "test -f \\$HOME/.config/systemd/user/gateway-watchdog.timer")
echo watchdog_script=$(yn "test -x \\$HOME/scripts/gateway-watchdog.sh")
echo nodex_bin=$(yn "test -x /usr/local/bin/node_exporter || which node_exporter")
echo nodex_port=$(yn "ss -tln 2>/dev/null | grep -q :9100")
echo xmtp_unit=$(yn "test -f \\$HOME/.config/systemd/user/instaclaw-xmtp.service")
echo xmtp_active=$(yn "systemctl --user is-active instaclaw-xmtp 2>&1 | grep -q ^active$")
echo xmtp_env=$(yn "grep -q ^XMTP_WALLET_KEY= \\$HOME/.openclaw/xmtp/.env")
echo xmtp_mjs=$(yn "test -f \\$HOME/scripts/xmtp-agent.mjs")
'`;

  const probeFn = async (vm: VM) => {
    const out = await withSsh(vm, async (ssh) => (await ssh.execCommand(probeCmd)).stdout, "");
    const data: Record<string, string> = {};
    for (const line of out.split("\n")) {
      const [k, v] = line.split("=");
      if (k && v != null) data[k.trim()] = v.trim();
    }
    if (!data.bankr) return null;  // SSH failed, skip
    return {
      vm,
      bankrMissing: data.bankr === "0",
      shmMissing: data.shm === "0",
      watchdogInactive: data.watchdog === "0",
      watchdogUnitMissing: data.watchdog_unit === "0",
      watchdogScriptMissing: data.watchdog_script === "0",
      nodexMissing: data.nodex_bin === "0" || data.nodex_port === "0",
      xmtpBroken: data.xmtp_active === "0",
      xmtpUnitPresent: data.xmtp_unit === "1",
      xmtpEnvHasKey: data.xmtp_env === "1",
      xmtpMjsMissing: data.xmtp_mjs === "0",
    };
  };

  const results = await batched(vms, 20, probeFn, "probing");
  return results.filter(r => r !== null) as NonNullable<Awaited<ReturnType<typeof probeFn>>>[];
}

// ── HEALS ──

async function healBankr(vm: VM) {
  return withSsh(vm, async (ssh) => {
    const r = await ssh.execCommand(
      'if [ -d $HOME/.openclaw/skills/bankr ]; then echo SKIP_EXISTS; else mkdir -p $HOME/.openclaw/skills && git clone --depth 1 https://github.com/BankrBot/skills $HOME/.openclaw/skills/bankr 2>&1 && echo CLONED || echo CLONE_FAILED; fi'
    );
    const ok = r.stdout.includes("CLONED") || r.stdout.includes("SKIP_EXISTS");
    return { vm: vm.name, ok, note: r.stdout.trim().split("\n").pop() || "" };
  }, { vm: vm.name, ok: false, note: "ssh-fail" });
}

async function healShm(vm: VM) {
  // Idempotent: append the SHM_CLEANUP line only if marker not present
  const SHM_LINE = `0 * * * * ipcs -m | awk 'NR>3 && $6==0 {print $2}' | xargs -r ipcrm -m 2>/dev/null; pgrep -x Xvfb >/dev/null && ! pgrep -x x11vnc >/dev/null && x11vnc -display :99 -forever -shared -rfbport 5901 -localhost -noxdamage -nopw -bg 2>/dev/null # SHM_CLEANUP`;
  return withSsh(vm, async (ssh) => {
    // Use base64 to avoid quoting hell
    const b64 = Buffer.from(SHM_LINE, "utf-8").toString("base64");
    // The trailing `printf '\\n'` is critical — `crontab -` rejects files
    // whose last byte isn't a newline, and `crontab -l` output may not end
    // in one on some VMs.
    const r = await ssh.execCommand(
      `if crontab -l 2>/dev/null | grep -q SHM_CLEANUP; then echo SKIP_EXISTS; else { crontab -l 2>/dev/null; printf '\\n'; echo '${b64}' | base64 -d; printf '\\n'; } | crontab - 2>&1 && echo INSTALLED; fi`
    );
    return { vm: vm.name, ok: r.stdout.includes("INSTALLED") || r.stdout.includes("SKIP_EXISTS"), note: r.stdout.trim() };
  }, { vm: vm.name, ok: false, note: "ssh-fail" });
}

async function healWatchdog(vm: VM, scriptMissing: boolean) {
  // gateway-watchdog.sh missing? Need to read from local repo and SCP it.
  let scriptContent: Buffer | null = null;
  if (scriptMissing) {
    try {
      scriptContent = readFileSync(resolve(".", "skills/computer-dispatch/scripts/gateway-watchdog.sh"));
    } catch (e) {
      return { vm: vm.name, ok: false, note: "local gateway-watchdog.sh not found" };
    }
  }

  return withSsh(vm, async (ssh) => {
    // 1. Ensure the script exists
    if (scriptContent) {
      const sftp = await ssh.requestSFTP();
      await new Promise<void>((res, rej) => sftp.writeFile("/home/openclaw/scripts/gateway-watchdog.sh", scriptContent!, (err) => err ? rej(err) : res()));
      sftp.end();
      await ssh.execCommand("chmod +x $HOME/scripts/gateway-watchdog.sh");
    }

    // 2. Write systemd service + timer (idempotent: cat > overwrites)
    const setup = await ssh.execCommand(`bash -c '
mkdir -p $HOME/.config/systemd/user
cat > $HOME/.config/systemd/user/gateway-watchdog.service << WDEOF
[Unit]
Description=Gateway Watchdog Check

[Service]
Type=oneshot
ExecStart=/bin/bash /home/openclaw/scripts/gateway-watchdog.sh
Environment=HOME=/home/openclaw
WDEOF
cat > $HOME/.config/systemd/user/gateway-watchdog.timer << WTEOF
[Unit]
Description=Gateway Watchdog Timer

[Timer]
OnBootSec=120
OnUnitActiveSec=120
AccuracySec=30

[Install]
WantedBy=timers.target
WTEOF
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user daemon-reload 2>/dev/null
systemctl --user enable gateway-watchdog.timer 2>/dev/null
systemctl --user start gateway-watchdog.timer 2>/dev/null
echo SETUP_OK
'`);
    if (!setup.stdout.includes("SETUP_OK")) {
      return { vm: vm.name, ok: false, note: "setup failed: " + setup.stderr.slice(0, 100) };
    }

    // 3. Verify
    const verify = await ssh.execCommand(`export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user is-active gateway-watchdog.timer 2>&1 | head -1`);
    const active = verify.stdout.trim() === "active";
    return { vm: vm.name, ok: active, note: `timer=${verify.stdout.trim()}` };
  }, { vm: vm.name, ok: false, note: "ssh-fail" });
}

async function healNodeExporter(vm: VM) {
  // Canonical: download to /usr/local/bin/node_exporter, write systemd unit, start.
  // Pin to a specific stable version to match what's on healthy VMs.
  const NE_VERSION = "1.8.2"; // Latest stable as of audit; matches binary size on vm-755
  return withSsh(vm, async (ssh) => {
    const setup = await ssh.execCommand(`bash -c '
set -e
ARCH=$(dpkg --print-architecture)
case "$ARCH" in
  amd64) NE_ARCH=linux-amd64 ;;
  arm64) NE_ARCH=linux-arm64 ;;
  *) echo "UNSUPPORTED_ARCH=$ARCH"; exit 1 ;;
esac

# Download if not already present (idempotent)
if [ ! -x /usr/local/bin/node_exporter ]; then
  cd /tmp
  curl -sSL -o /tmp/ne.tgz https://github.com/prometheus/node_exporter/releases/download/v${NE_VERSION}/node_exporter-${NE_VERSION}.\$NE_ARCH.tar.gz
  tar xf /tmp/ne.tgz
  sudo mv node_exporter-${NE_VERSION}.\$NE_ARCH/node_exporter /usr/local/bin/
  sudo chown root:root /usr/local/bin/node_exporter
  sudo chmod +x /usr/local/bin/node_exporter
  rm -rf /tmp/ne.tgz /tmp/node_exporter-${NE_VERSION}.\$NE_ARCH
fi

# Create node_exporter user (idempotent)
id node_exporter >/dev/null 2>&1 || sudo useradd --no-create-home --shell /bin/false node_exporter

# Write systemd unit (idempotent: same content each time)
sudo tee /etc/systemd/system/node_exporter.service >/dev/null << UEOF
[Unit]
Description=Node Exporter
After=network.target

[Service]
User=node_exporter
ExecStart=/usr/local/bin/node_exporter --collector.systemd
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UEOF

sudo systemctl daemon-reload
sudo systemctl enable node_exporter
sudo systemctl restart node_exporter
sleep 2
echo SETUP_OK
'`);
    if (!setup.stdout.includes("SETUP_OK")) {
      return { vm: vm.name, ok: false, note: "setup failed: " + (setup.stderr || setup.stdout).slice(0, 200) };
    }

    // Verify
    const verify = await ssh.execCommand(
      "ss -tln 2>/dev/null | grep -q :9100 && echo PORT_OK; sudo systemctl is-active node_exporter 2>/dev/null"
    );
    const port = verify.stdout.includes("PORT_OK");
    const active = verify.stdout.includes("active");
    return { vm: vm.name, ok: port && active, note: `port=${port} active=${active}` };
  }, { vm: vm.name, ok: false, note: "ssh-fail" });
}

async function healXmtp(vm: VM, hasKey: boolean, mjsMissing: boolean) {
  // Strategy:
  //  - hasKey + mjs present: in-place unit fix (preserves wallet identity)
  //  - hasKey + mjs missing: deploy mjs from source code base, then in-place unit fix
  //  - !hasKey: clear DB xmtp_address, call setupXMTP() for fresh provision
  if (!hasKey) {
    // Clear DB xmtp_address so setupXMTP doesn't short-circuit
    await sb.from("instaclaw_vms").update({ xmtp_address: null }).eq("id", vm.id);

    // Re-fetch fresh vm record
    const { data: freshVm } = await sb
      .from("instaclaw_vms")
      .select("*")
      .eq("id", vm.id)
      .single();

    // Look up user wallet for greeting target
    let userWalletAddress: string | undefined;
    let userGreetingAlreadySent = false;
    const { data: vmRow } = await sb.from("instaclaw_vms").select("assigned_to").eq("id", vm.id).single();
    if (vmRow?.assigned_to) {
      const { data: user } = await sb
        .from("instaclaw_users")
        .select("evm_wallet_address, xmtp_greeting_sent_at")
        .eq("id", vmRow.assigned_to)
        .maybeSingle();
      userWalletAddress = user?.evm_wallet_address || undefined;
      userGreetingAlreadySent = !!user?.xmtp_greeting_sent_at;
    }

    // Dynamic import of setupXMTP (avoids loading lib/ssh on every probe call)
    const { setupXMTP } = await import("../lib/ssh");
    const result = await setupXMTP(freshVm as any, userWalletAddress, userGreetingAlreadySent);
    return { vm: vm.name, ok: !!result.success, note: result.success ? `addr=${result.xmtpAddress?.slice(0, 10)}...` : `err=${(result.error || "").slice(0, 80)}` };
  }

  // In-place fix path: rewrite unit with dynamic node path, restart
  return withSsh(vm, async (ssh) => {
    // If mjs missing, upload from local source (canonical path per setupXMTP)
    if (mjsMissing) {
      try {
        const mjsContent = readFileSync(resolve(".", "skills/xmtp-agent/scripts/xmtp-agent.mjs"));
        const sftp = await ssh.requestSFTP();
        await new Promise<void>((res, rej) => sftp.writeFile("/home/openclaw/scripts/xmtp-agent.mjs", mjsContent, (err) => err ? rej(err) : res()));
        sftp.end();
      } catch (e: any) {
        return { vm: vm.name, ok: false, note: "mjs missing locally: " + (e.message || "?").slice(0, 60) };
      }
    }

    // Ensure @xmtp/agent-sdk is installed (preserves wallet — only adds the dep if missing)
    await ssh.execCommand(
      'bash -c "cd $HOME/scripts && [ -f package.json ] || echo \\"{}\\" > package.json; if [ ! -d node_modules/@xmtp/agent-sdk ]; then NPATH=$(ls -d $HOME/.nvm/versions/node/*/bin/node 2>/dev/null | head -1); NDIR=$(dirname $NPATH 2>/dev/null); PATH=$NDIR:$PATH npm install @xmtp/agent-sdk@latest >/dev/null 2>&1 || true; fi"'
    );

    // Rewrite unit with dynamic node path + restart
    const r = await ssh.execCommand(`bash -c '
NPATH=\$(ls -d \$HOME/.nvm/versions/node/*/bin/node 2>/dev/null | head -1)
[ -z "\$NPATH" ] && { echo "NO_NODE"; exit 1; }
mkdir -p \$HOME/.config/systemd/user
cat > \$HOME/.config/systemd/user/instaclaw-xmtp.service << SVCEOF
[Unit]
Description=InstaClaw XMTP Agent
After=network.target

[Service]
Type=simple
ExecStart=\$NPATH /home/openclaw/scripts/xmtp-agent.mjs
WorkingDirectory=/home/openclaw/scripts
EnvironmentFile=/home/openclaw/.openclaw/xmtp/.env
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
SVCEOF
export XDG_RUNTIME_DIR=/run/user/\$(id -u)
systemctl --user daemon-reload
systemctl --user enable instaclaw-xmtp 2>/dev/null
systemctl --user restart instaclaw-xmtp
echo SETUP_OK
'`);
    if (!r.stdout.includes("SETUP_OK")) {
      return { vm: vm.name, ok: false, note: "setup failed: " + r.stdout.slice(0, 80) };
    }

    // Wait up to 20s for service to become active and write address
    let active = false;
    let address = "";
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 2500));
      const v = await ssh.execCommand(`bash -c 'export XDG_RUNTIME_DIR=/run/user/$(id -u); systemctl --user is-active instaclaw-xmtp 2>&1; cat $HOME/.openclaw/xmtp/address 2>/dev/null'`);
      if (v.stdout.includes("active")) active = true;
      const m = v.stdout.match(/(0x[a-fA-F0-9]{40})/);
      if (m) address = m[1];
      if (active && address) break;
    }

    if (active && address) {
      // Update DB if address changed (in-place fix preserves wallet, but DB might be out of sync)
      if (address.toLowerCase() !== (vm.xmtp_address || "").toLowerCase()) {
        await sb.from("instaclaw_vms").update({ xmtp_address: address.toLowerCase() }).eq("id", vm.id);
      }
      return { vm: vm.name, ok: true, note: `addr=${address.slice(0, 10)}...` };
    }
    return { vm: vm.name, ok: false, note: `active=${active} addr=${address || "none"}` };
  }, { vm: vm.name, ok: false, note: "ssh-fail" });
}

// ── MAIN ──

(async () => {
  console.log(`Loading VMs...`);
  const vms = await loadVms();
  console.log(`Loaded ${vms.length} assigned + healthy VMs with gateway_token.\n`);

  console.log("=== Probe pass ===");
  const probed = await probe(vms);

  // Build per-category target sets
  const bankrTargets = probed.filter(p => p.bankrMissing);
  const shmTargets = probed.filter(p => p.shmMissing);
  const watchdogTargets = probed.filter(p => p.watchdogInactive);
  const nodexTargets = probed.filter(p => p.nodexMissing);
  const xmtpTargets = probed.filter(p => p.xmtpBroken);

  console.log(`\nBroken sets:`);
  console.log(`  bankr missing:        ${bankrTargets.length}`);
  console.log(`  SHM_CLEANUP missing:  ${shmTargets.length}`);
  console.log(`  gw_watchdog inactive: ${watchdogTargets.length}  (script-missing: ${watchdogTargets.filter(t=>t.watchdogScriptMissing).length}, unit-missing: ${watchdogTargets.filter(t=>t.watchdogUnitMissing).length})`);
  console.log(`  node_exporter miss:   ${nodexTargets.length}`);
  console.log(`  XMTP broken:          ${xmtpTargets.length}  (no key: ${xmtpTargets.filter(t=>!t.xmtpEnvHasKey).length}, has key: ${xmtpTargets.filter(t=>t.xmtpEnvHasKey).length})`);

  if (PROBE) {
    console.log(`\n--probe mode: no changes. Pass --heal-bankr, --heal-shm, --heal-watchdog, --heal-node-exporter, --heal-xmtp, or --heal-all`);
    return;
  }

  const summary: Array<[string, number, number]> = []; // category, ok, fail

  if (HEAL_BANKR && bankrTargets.length) {
    console.log(`\n=== Heal: bankr (${bankrTargets.length} VMs) ===`);
    const r = await batched(bankrTargets, 15, t => healBankr(t.vm), "  cloning");
    const ok = r.filter(x => x.ok).length;
    summary.push(["bankr", ok, r.length - ok]);
    for (const f of r.filter(x => !x.ok).slice(0, 10)) console.log(`  FAIL ${f.vm}: ${f.note}`);
  }

  if (HEAL_SHM && shmTargets.length) {
    console.log(`\n=== Heal: SHM_CLEANUP cron (${shmTargets.length} VMs) ===`);
    const r = await batched(shmTargets, 20, t => healShm(t.vm), "  installing");
    const ok = r.filter(x => x.ok).length;
    summary.push(["shm_cleanup", ok, r.length - ok]);
    for (const f of r.filter(x => !x.ok).slice(0, 10)) console.log(`  FAIL ${f.vm}: ${f.note}`);
  }

  if (HEAL_WATCHDOG && watchdogTargets.length) {
    console.log(`\n=== Heal: gateway-watchdog (${watchdogTargets.length} VMs) ===`);
    const r = await batched(watchdogTargets, 12, t => healWatchdog(t.vm, t.watchdogScriptMissing), "  setup");
    const ok = r.filter(x => x.ok).length;
    summary.push(["gw_watchdog", ok, r.length - ok]);
    for (const f of r.filter(x => !x.ok).slice(0, 10)) console.log(`  FAIL ${f.vm}: ${f.note}`);
  }

  if (HEAL_NODE_EXPORTER && nodexTargets.length) {
    console.log(`\n=== Heal: node_exporter (${nodexTargets.length} VMs) ===`);
    const r = await batched(nodexTargets, 8, t => healNodeExporter(t.vm), "  installing");
    const ok = r.filter(x => x.ok).length;
    summary.push(["node_exporter", ok, r.length - ok]);
    for (const f of r.filter(x => !x.ok).slice(0, 10)) console.log(`  FAIL ${f.vm}: ${f.note}`);
  }

  if (HEAL_XMTP && xmtpTargets.length) {
    console.log(`\n=== Heal: XMTP (${xmtpTargets.length} VMs) ===`);
    // XMTP is more delicate, smaller batch size + sequential per-batch
    const r = await batched(xmtpTargets, 6, t => healXmtp(t.vm, t.xmtpEnvHasKey, t.xmtpMjsMissing), "  setup");
    const ok = r.filter(x => x.ok).length;
    summary.push(["xmtp", ok, r.length - ok]);
    for (const f of r.filter(x => !x.ok).slice(0, 15)) console.log(`  FAIL ${f.vm}: ${f.note}`);
  }

  console.log(`\n═══════════════════════════════════════════`);
  console.log(`HEAL SUMMARY`);
  console.log(`═══════════════════════════════════════════`);
  for (const [cat, ok, fail] of summary) {
    console.log(`  ${cat.padEnd(18)} ok=${ok}  fail=${fail}`);
  }
})();
