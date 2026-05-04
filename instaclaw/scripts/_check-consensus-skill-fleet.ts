import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { NodeSSH } from "node-ssh";
for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local","/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key"]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const sshKey = Buffer.from(process.env.SSH_PRIVATE_KEY_B64!, "base64").toString("utf-8");

async function main() {
  // 1. How many VMs have the consensus_2026 partner tag?
  const { data: tagged } = await sb.from("instaclaw_vms")
    .select("name, partner")
    .eq("partner", "consensus_2026");
  console.log("VMs tagged consensus_2026:", tagged?.length ?? 0);
  if (tagged) for (const v of tagged) console.log("  -", v.name);

  const { data: edge } = await sb.from("instaclaw_vms")
    .select("name, partner")
    .eq("partner", "edge_city");
  console.log("VMs tagged edge_city:", edge?.length ?? 0);
  if (edge) for (const v of edge) console.log("  -", v.name);

  // 2. Sample 5 random healthy VMs and check if consensus-2026 skill exists
  const { data: sample } = await sb.from("instaclaw_vms")
    .select("name, ip_address, ssh_user, partner")
    .eq("status", "assigned").eq("provider", "linode").eq("health_status", "healthy")
    .is("frozen_at", null).is("lifecycle_locked_at", null)
    .not("ip_address", "is", null).not("gateway_token", "is", null)
    .limit(8);

  console.log("\n── consensus-2026 skill presence on 8 random healthy VMs ──");
  for (const v of (sample || [])) {
    const ssh = new NodeSSH();
    try {
      await ssh.connect({ host: v.ip_address as string, username: (v.ssh_user as string) || "openclaw", privateKey: sshKey, readyTimeout: 6_000 });
      const r = await ssh.execCommand("test -d ~/.openclaw/skills/consensus-2026 && echo INSTALLED || echo MISSING");
      console.log(`  ${(v.name as string).padEnd(22)} partner=${(v.partner as string) || "null".padEnd(15)} ${r.stdout.trim()}`);
    } catch (e) {
      console.log(`  ${v.name} ERR: ${(e as Error).message.slice(0, 60)}`);
    } finally {
      try { ssh.dispose(); } catch {}
    }
  }
}
main().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
