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
  const { data } = await sb.from("instaclaw_vms")
    .select("name, ip_address, health_status, last_health_check, watchdog_consecutive_failures, telegram_bot_username, last_user_activity_at, assigned_to")
    .eq("status", "assigned").eq("provider", "linode")
    .in("health_status", ["unhealthy", "unknown"]);
  console.log("=== unhealthy + unknown VMs ===");
  for (const v of data ?? []) {
    const { data: u } = await sb.from("instaclaw_users").select("email").eq("id", v.assigned_to).single();
    console.log(`  ${v.name.padEnd(22)} ${v.ip_address.padEnd(16)} health=${v.health_status} watchdog_fails=${v.watchdog_consecutive_failures} bot=${v.telegram_bot_username} last_activity=${v.last_user_activity_at} email=${u?.email}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
