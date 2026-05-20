/**
 * One-shot push of the Bug B fix (vm-watchdog.py with gbrain protection) to
 * the 8 at-risk VMs whose vm-watchdog cron is active but who haven't gotten
 * the fix via file-drift yet.
 *
 * At-risk = vm-watchdog cron ACTIVE (uncommented) AND gbrain installed.
 * File-drift cron is propagating the fix at ~3 VMs per 3-min tick, but
 * we have a ~25 min window before the 30-min kill cycle fires on the
 * just-remediated gbrains. Don't trust the timing.
 */

import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { VM_WATCHDOG_SCRIPT } from "../lib/ssh";

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

// 8 at-risk VMs (cohort + edge with active watchdog, no fix yet)
const TARGETS = [
  { name: "vm-917", ip: "45.33.94.224" },
  { name: "vm-922", ip: "173.255.236.248" },
  { name: "vm-923", ip: "173.255.236.125" },
  { name: "vm-912", ip: "173.255.227.194" },
  { name: "vm-913", ip: "173.255.227.211" },
  { name: "vm-893", ip: "45.56.109.213" },
  { name: "vm-935", ip: "173.255.229.222" },
  { name: "vm-904", ip: "172.104.24.104" },
];

async function pushOne(name: string, ip: string): Promise<boolean> {
  const ssh = new NodeSSH();
  try {
    await ssh.connect({
      host: ip, username: "openclaw",
      privateKey: Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8"),
      readyTimeout: 12_000,
    });
    // SFTP-style write via cat + stdin (matches existing fleet-push pattern)
    const up = await ssh.execCommand(
      "cat > ~/.openclaw/scripts/vm-watchdog.py && chmod +x ~/.openclaw/scripts/vm-watchdog.py",
      { stdin: VM_WATCHDOG_SCRIPT },
    );
    if (up.code !== 0) {
      console.log(`✗ ${name}: write failed rc=${up.code} ${up.stderr.slice(0, 80)}`);
      ssh.dispose();
      return false;
    }
    // Verify
    const ver = await ssh.execCommand("grep -c 'gbrain_pid' ~/.openclaw/scripts/vm-watchdog.py");
    const count = parseInt(ver.stdout.trim() || "0", 10);
    ssh.dispose();
    if (count >= 3) {
      console.log(`✓ ${name}: vm-watchdog.py updated (${count} gbrain_pid refs)`);
      return true;
    } else {
      console.log(`✗ ${name}: verify only found ${count} gbrain_pid refs`);
      return false;
    }
  } catch (e: any) {
    console.log(`✗ ${name}: ${String(e.message).slice(0, 80)}`);
    try { ssh.dispose(); } catch {}
    return false;
  }
}

async function main() {
  console.log(`Pushing Bug B fix to ${TARGETS.length} at-risk VMs (parallel):\n`);
  const results = await Promise.all(TARGETS.map((t) => pushOne(t.name, t.ip)));
  const success = results.filter(Boolean).length;
  console.log(`\nResult: ${success}/${TARGETS.length} succeeded`);
  process.exit(success === TARGETS.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
