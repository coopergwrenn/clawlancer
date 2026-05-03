import { readFileSync } from "fs";
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

async function main() {
  // vm-544 specifically
  const { data: vm544 } = await sb
    .from("instaclaw_vms")
    .select("name, ip_address, status, health_status, frozen_at, lifecycle_locked_at, telegram_bot_username, last_user_activity_at, watchdog_consecutive_failures, watchdog_quarantined_at, gateway_token, assigned_to")
    .eq("name", "instaclaw-vm-544");
  console.log("=== vm-544 ===");
  console.log(JSON.stringify(vm544, null, 2));

  if (vm544?.[0]?.assigned_to) {
    const { data: u } = await sb.from("instaclaw_users").select("email, partner").eq("id", vm544[0].assigned_to).single();
    console.log("Owner:", u);
  }

  // Current fleet distribution
  const { data: dist } = await sb.from("instaclaw_vms")
    .select("health_status, name, ip_address")
    .eq("status", "assigned")
    .eq("provider", "linode");
  const counts = new Map<string, number>();
  for (const v of dist ?? []) counts.set(v.health_status || "(null)", (counts.get(v.health_status || "(null)") ?? 0) + 1);
  console.log("\n=== fleet distribution NOW ===");
  for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log(`  TOTAL: ${dist?.length ?? 0}`);

  // VMs that match fleet-pusher filter NOW
  const { data: healthyNow } = await sb.from("instaclaw_vms")
    .select("name, ip_address")
    .eq("status", "assigned").eq("provider", "linode").eq("health_status", "healthy")
    .is("frozen_at", null).is("lifecycle_locked_at", null)
    .not("ip_address", "is", null).not("gateway_token", "is", null);
  console.log(`\nFleet-pusher filter would match NOW: ${healthyNow?.length ?? 0} VMs`);
}
main().catch((e) => { console.error(e); process.exit(1); });
