import { readFileSync } from "fs";
import { NodeSSH } from "node-ssh";
import { createClient } from "@supabase/supabase-js";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function run() {
  for (const name of ["instaclaw-vm-050", "instaclaw-vm-780"]) {
    const { data: vm } = await sb.from("instaclaw_vms").select("ip_address, ssh_user").eq("name", name).single();
    if (!vm) continue;
    const ssh = new NodeSSH();
    await ssh.connect({ host: vm.ip_address as string, username: (vm.ssh_user as string) || "openclaw", privateKey: sshKey, readyTimeout: 12000 });
    try {
      // Stop the service AND clear its conversation history so the bounce
      // pattern dies. The empty file is fine — agent recreates on next msg.
      await ssh.execCommand('export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user stop instaclaw-xmtp 2>&1');
      await ssh.execCommand("rm -f ~/.openclaw/xmtp/conversations.json");
      console.log(`${name}: stopped + cleared`);
    } finally {
      ssh.dispose();
    }
  }
}
run().catch((e) => { console.error("FATAL:", e); process.exit(1); });
