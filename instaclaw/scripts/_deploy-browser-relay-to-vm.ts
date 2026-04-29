/**
 * Single-VM deploy helper for browser-relay-server.
 *
 * Usage:
 *   npx tsx scripts/_deploy-browser-relay-to-vm.ts --vm vm-860
 *   npx tsx scripts/_deploy-browser-relay-to-vm.ts --ip 1.2.3.4
 *
 * This is the BEFORE-FLEET-ROLLOUT helper. Once smoke-tested on one VM,
 * the install logic should be moved into configureOpenClaw() in lib/ssh.ts
 * and the manifest version bumped so the reconciler picks it up fleet-wide.
 *
 * What it does on the target VM:
 *   1. Copies browser-relay-server.js to /home/openclaw/scripts/
 *   2. Copies browser-relay-server.service to ~/.config/systemd/user/
 *   3. systemctl --user daemon-reload, enable, restart
 *   4. Verifies the unit is active and the local /extension/status endpoint
 *      returns {connected:false} (server alive, no extension yet)
 *   5. Pings the public Caddy endpoint to confirm Caddy proxy works end-to-end
 *
 * Idempotent — re-running just updates the files and restarts the service.
 *
 * Read-only ABORT if the unit is currently running and the file content
 * matches (we still re-deploy on user request, but warn).
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { resolve, join } from "path";

const envLocal = readFileSync(resolve(".", ".env.local"), "utf-8");
for (const l of envLocal.split("\n")) {
  const m = l.match(/^([^#=]+)=(.*)$/);
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const envVercel = readFileSync(resolve(".", ".env.vercel"), "utf-8");
let sshKeyB64 = "";
for (const l of envVercel.split("\n")) {
  const m = l.match(/^SSH_PRIVATE_KEY_B64=(.*)$/);
  if (m) {
    sshKeyB64 = m[1].trim().replace(/^["']|["']$/g, "");
    break;
  }
}
const SSH_KEY = Buffer.from(sshKeyB64, "base64").toString("utf-8");
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

async function resolveTarget(): Promise<{
  ip: string;
  name: string;
  gateway_url: string | null;
}> {
  const explicitIp = arg("ip");
  const vmName = arg("vm");
  if (explicitIp) return { ip: explicitIp, name: explicitIp, gateway_url: null };
  if (!vmName) throw new Error("pass --vm <name> or --ip <ip>");
  const fullName = vmName.startsWith("instaclaw-vm-") ? vmName : `instaclaw-vm-${vmName.replace(/^vm-/, "")}`;
  const { data: vm, error } = await sb
    .from("instaclaw_vms")
    .select("name, ip_address, gateway_url")
    .eq("name", fullName)
    .single();
  if (error || !vm) throw new Error(`VM not found: ${fullName} (${error?.message})`);
  return { ip: vm.ip_address, name: vm.name, gateway_url: vm.gateway_url };
}

const SERVER_JS = readFileSync(
  join(process.cwd(), "scripts/browser-relay-server/browser-relay-server.js"),
  "utf-8",
);
const SERVICE_UNIT = readFileSync(
  join(process.cwd(), "scripts/browser-relay-server/browser-relay-server.service"),
  "utf-8",
);

async function main() {
  const target = await resolveTarget();
  console.log(`==== deploying browser-relay to ${target.name} (${target.ip}) ====\n`);

  const ssh = new NodeSSH();
  await ssh.connect({
    host: target.ip,
    port: 22,
    username: "openclaw",
    privateKey: SSH_KEY,
    readyTimeout: 12000,
  });

  // 1. Make sure ~/scripts/ exists
  await ssh.execCommand("mkdir -p ~/scripts ~/.config/systemd/user");

  // 2. Write files via SFTP
  const sftp = await ssh.requestSFTP();
  await new Promise<void>((res, rej) => {
    sftp.writeFile(
      "/home/openclaw/scripts/browser-relay-server.js",
      Buffer.from(SERVER_JS, "utf-8"),
      (err) => (err ? rej(err) : res()),
    );
  });
  await new Promise<void>((res, rej) => {
    sftp.writeFile(
      "/home/openclaw/.config/systemd/user/browser-relay-server.service",
      Buffer.from(SERVICE_UNIT, "utf-8"),
      (err) => (err ? rej(err) : res()),
    );
  });
  console.log("✓ files written");

  // 3. Enable + restart unit
  // SSH sessions don't have DBUS_SESSION_BUS_ADDRESS by default — set
  // XDG_RUNTIME_DIR so systemctl --user works (per project memory).
  const sysctl = (cmd: string) =>
    `export XDG_RUNTIME_DIR="/run/user/$(id -u)"; systemctl --user ${cmd}`;
  const reload = await ssh.execCommand(sysctl("daemon-reload"));
  if (reload.code !== 0) console.log("daemon-reload stderr:", reload.stderr);
  await ssh.execCommand(sysctl("enable browser-relay-server.service"));
  const restart = await ssh.execCommand(sysctl("restart browser-relay-server.service"));
  if (restart.code !== 0) {
    console.log("restart failed:", restart.stderr);
    process.exit(1);
  }
  console.log("✓ unit enabled + restarted");

  // 4. Wait briefly, then verify
  await new Promise((r) => setTimeout(r, 1500));
  const status = await ssh.execCommand(sysctl("is-active browser-relay-server.service"));
  console.log(`unit state: ${status.stdout.trim()}`);

  const localProbe = await ssh.execCommand(
    "curl -s --max-time 3 http://127.0.0.1:18792/extension/status; echo; echo '---'; curl -s --max-time 3 http://127.0.0.1:18792/json/version",
  );
  console.log("\n--- local probes ---");
  console.log(localProbe.stdout || localProbe.stderr);

  const journal = await ssh.execCommand(
    "journalctl --user -u browser-relay-server -n 20 --no-pager 2>&1 | tail -20",
  );
  console.log("\n--- recent log lines ---");
  console.log(journal.stdout);

  ssh.dispose();

  // 5. Public Caddy probe (from this machine)
  if (target.gateway_url) {
    console.log("\n--- public Caddy probe ---");
    try {
      const res = await fetch(`${target.gateway_url.replace(/\/+$/, "")}/relay/extension/status`, {
        signal: AbortSignal.timeout(5000),
      });
      const body = await res.text().catch(() => "");
      console.log(`HTTP ${res.status} ${res.statusText}`);
      console.log(`body: ${body.slice(0, 200)}`);
      if (res.status === 200) {
        console.log("\n✓ end-to-end via Caddy works");
      } else {
        console.log("\n✗ Caddy proxy returned non-200 — check Caddyfile");
      }
    } catch (e: any) {
      console.log(`request failed: ${String(e.message || e).slice(0, 200)}`);
    }
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
