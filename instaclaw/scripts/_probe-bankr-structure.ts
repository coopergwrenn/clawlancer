/**
 * Quick probe of bankr skill dir on vm-050 — establish whether SKILL.md
 * lives at top-level or in subdirs (multi-skill repo).
 */
import { readFileSync } from "fs";
import { connectSSH } from "../lib/ssh";
import { createClient } from "@supabase/supabase-js";

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

(async () => {
  const { data: vms } = await sb.from("instaclaw_vms")
    .select("id,name,ip_address,ssh_port,ssh_user")
    .in("name", ["instaclaw-vm-050", "instaclaw-vm-893", "instaclaw-vm-895", "instaclaw-vm-896", "instaclaw-vm-877", "instaclaw-vm-321", "instaclaw-vm-729"]);

  for (const vm of vms ?? []) {
    console.log(`\n══ ${vm.name} ══`);
    const ssh = await connectSSH(vm as any);
    try {
      const r = await ssh.execCommand(
        `echo "── ~/.openclaw/skills/bankr ──"; ls -la ~/.openclaw/skills/bankr 2>&1 | head -20; echo "── git remote ──"; cd ~/.openclaw/skills/bankr 2>/dev/null && git remote get-url origin 2>&1 | head -1; echo "── subdir SKILL.md count ──"; find ~/.openclaw/skills/bankr -name SKILL.md -not -path '*/.git/*' 2>/dev/null | head -10; echo "── ~/.openclaw/skills/dgclaw ──"; ls -la ~/.openclaw/skills/dgclaw 2>&1 | head -10; echo "── ~/dgclaw-skill ──"; ls -la ~/dgclaw-skill 2>&1 | head -10; echo "── ~/dgclaw-skill/scripts ──"; ls -la ~/dgclaw-skill/scripts 2>&1 | head -10`
      );
      console.log(r.stdout);
      if (r.stderr) console.log("stderr:", r.stderr.slice(0, 300));
    } finally {
      ssh.dispose();
    }
  }
})().catch(e => { console.error("FATAL", e); process.exit(1); });
