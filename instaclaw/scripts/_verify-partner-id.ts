/**
 * Verify PARTNER_ID=INSTACLAW on 5 random VMs + vm-050.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

for (const f of [".env.ssh-key", ".env.local", ".env.local.full"]) {
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

import { connectSSH } from "../lib/ssh";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function checkVM(vm: any): Promise<void> {
  try {
    const ssh = await connectSSH(vm);

    const bashrc = await ssh.execCommand("grep 'PARTNER_ID=INSTACLAW' ~/.bashrc | head -1");
    const acpEnv = await ssh.execCommand("grep 'PARTNER_ID=INSTACLAW' ~/virtuals-protocol-acp/.env 2>/dev/null | head -1 || echo 'NO_ACP'");
    const skill = await ssh.execCommand("wc -c < ~/.openclaw/skills/dgclaw/SKILL.md 2>/dev/null || echo 0");
    const soul = await ssh.execCommand("grep -c DEGENCLAW ~/.openclaw/workspace/SOUL.md 2>/dev/null || echo 0");
    const health = await ssh.execCommand("curl -s -m 5 -o /dev/null -w '%{http_code}' http://localhost:18789/health");

    console.log(`${vm.name} (${vm.ip_address}):`);
    console.log(`  .bashrc PARTNER_ID: ${bashrc.stdout?.trim() ? 'YES' : 'MISSING'}`);
    console.log(`  ACP .env PARTNER_ID: ${acpEnv.stdout?.trim().includes('INSTACLAW') ? 'YES' : acpEnv.stdout?.trim()}`);
    console.log(`  SKILL.md: ${parseInt(skill.stdout?.trim() || "0") > 1000 ? 'OK' : 'MISSING'} (${skill.stdout?.trim()} bytes)`);
    console.log(`  SOUL.md DegenClaw: ${parseInt(soul.stdout?.trim() || "0") > 0 ? 'YES' : 'MISSING'}`);
    console.log(`  Gateway health: ${health.stdout?.trim()}`);
    console.log();

    ssh.dispose();
  } catch (e) {
    console.log(`${vm.name} (${vm.ip_address}): SSH ERROR — ${String(e).slice(0, 80)}\n`);
  }
}

async function main() {
  console.log("=== PARTNER_ID + DegenClaw Verification (6 VMs) ===\n");

  const { data: vms } = await sb
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user")
    .eq("status", "assigned")
    .not("assigned_to", "is", null)
    .not("ip_address", "is", null)
    .order("name");

  if (!vms?.length) { console.log("No VMs"); return; }

  // vm-050 + 5 random
  const vm050 = vms.find((v: any) => v.name === "instaclaw-vm-050");
  const others = vms.filter((v: any) => v.name !== "instaclaw-vm-050");
  const random5 = [];
  const indices = new Set<number>();
  while (indices.size < 5 && indices.size < others.length) {
    indices.add(Math.floor(Math.random() * others.length));
  }
  for (const i of indices) random5.push(others[i]);

  const targets = vm050 ? [vm050, ...random5] : random5;

  for (const vm of targets) {
    await checkVM(vm);
  }
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
