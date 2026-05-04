/**
 * Retry the 2 deadline failures from the timeoutSeconds=300 fleet bump:
 * vm-625 (69.164.210.47) and vm-890 (66.228.43.209).
 *
 * Uses the safer stop→set→start sequence inline (don't depend on the orchestrator).
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

async function bumpOne(name: string, ip: string, sshUser: string | null) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${name} (${ip}) — start`);
  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: ip, username: sshUser || "openclaw", privateKey: sshKey, readyTimeout: 12_000 });
  } catch (e) {
    console.log(`  ERROR connect: ${(e as Error).message.slice(0, 100)}`);
    return false;
  }
  try {
    // First read current value
    const pre = await ssh.execCommand(String.raw`
source ~/.nvm/nvm.sh 2>/dev/null
openclaw config get agents.defaults.timeoutSeconds 2>&1 | head -1
`);
    console.log(`  pre = ${pre.stdout.trim()}`);

    // stop → set → start
    const out = await ssh.execCommand(String.raw`
source ~/.nvm/nvm.sh 2>/dev/null
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user stop openclaw-gateway 2>&1
sleep 1
openclaw config set agents.defaults.timeoutSeconds 300 2>&1
sleep 1
systemctl --user start openclaw-gateway 2>&1
`, { execOptions: { } });
    console.log(`  set+restart: ${out.stdout.replace(/\n/g, " | ").slice(0, 200)}`);

    // Wait up to 150s for /health 200
    const start = Date.now();
    let healthy = false;
    while (Date.now() - start < 150_000) {
      const h = await ssh.execCommand(`curl -s -m 5 -o /dev/null -w "%{http_code}" localhost:18789/health`);
      if (h.stdout.trim() === "200") { healthy = true; break; }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    if (!healthy) {
      console.log(`  ⚠️  /health did not return 200 after 150s`);
      return false;
    }
    const post = await ssh.execCommand(String.raw`
source ~/.nvm/nvm.sh 2>/dev/null
openclaw config get agents.defaults.timeoutSeconds 2>&1 | head -1
`);
    console.log(`  ✓ post = ${post.stdout.trim()}, healthy=true`);
    return true;
  } catch (e) {
    console.log(`  ERROR exec: ${(e as Error).message.slice(0, 100)}`);
    return false;
  } finally {
    try { ssh.dispose(); } catch {}
  }
}

async function main() {
  const targets = ["instaclaw-vm-625", "instaclaw-vm-890"];
  const { data, error } = await sb.from("instaclaw_vms")
    .select("name, ip_address, ssh_user")
    .in("name", targets);
  if (error || !data) { console.log("DB error:", error?.message); return; }
  for (const v of data as { name: string; ip_address: string; ssh_user: string }[]) {
    if (!v.ip_address) { console.log(`${v.name}: no ip_address`); continue; }
    await bumpOne(v.name, v.ip_address, v.ssh_user || null);
  }
}
main().catch((e) => { console.error("FATAL:", (e as Error).message); process.exit(1); });
