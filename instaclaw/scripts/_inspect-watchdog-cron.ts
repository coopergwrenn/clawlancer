/**
 * Inspect watchdog cron format on a working VM AND the 3 broken ones.
 * Goal: learn the exact line(s) to install on vm-748 / vm-773 / vm-linode-06.
 * Read-only — no mutation.
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
  const targets = ["instaclaw-vm-725", "instaclaw-vm-748", "instaclaw-vm-773", "instaclaw-vm-linode-06"];
  const { data: vms } = await sb.from("instaclaw_vms").select("*").in("name", targets);
  for (const vm of vms ?? []) {
    console.log(`\n══ ${vm.name} ══`);
    const ssh = await connectSSH(vm as any);
    try {
      const r = await ssh.execCommand(
        `echo === full crontab ===; crontab -l 2>/dev/null; echo === lines mentioning watchdog ===; crontab -l 2>/dev/null | grep -i watchdog; echo === watchdog script present? ===; ls -la ~/.openclaw/scripts/vm-watchdog.py 2>&1 | head -2; echo === silence-watchdog present? ===; ls -la ~/.openclaw/scripts/silence-watchdog.py 2>&1 | head -2`
      );
      console.log(r.stdout);
    } finally {
      ssh.dispose();
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
