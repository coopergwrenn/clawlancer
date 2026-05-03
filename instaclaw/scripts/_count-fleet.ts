// Quick fleet count for the deploy.
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
  // Match the EXACT filter the fleet pusher uses.
  const exactFilter = await sb.from("instaclaw_vms")
    .select("name, ip_address, health_status", { count: "exact" })
    .eq("status", "assigned")
    .eq("provider", "linode")
    .eq("health_status", "healthy")
    .is("frozen_at", null)
    .is("lifecycle_locked_at", null)
    .not("ip_address", "is", null)
    .not("gateway_token", "is", null);
  console.log(`Fleet pusher target: ${exactFilter.data?.length ?? 0} VMs (count=${exactFilter.count})`);

  // Distribution by health_status for status=assigned + linode (anyone we might miss)
  const dist = await sb.from("instaclaw_vms")
    .select("health_status, status, frozen_at, lifecycle_locked_at, ip_address, gateway_token")
    .eq("status", "assigned")
    .eq("provider", "linode");
  const counts = new Map<string, number>();
  let frozen = 0, locked = 0, noIp = 0, noToken = 0;
  for (const r of dist.data || []) {
    counts.set(r.health_status || "(null)", (counts.get(r.health_status || "(null)") ?? 0) + 1);
    if (r.frozen_at) frozen++;
    if (r.lifecycle_locked_at) locked++;
    if (!r.ip_address) noIp++;
    if (!r.gateway_token) noToken++;
  }
  console.log(`\nAll status=assigned + linode: ${dist.data?.length ?? 0}`);
  console.log(`Distribution by health_status:`);
  for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(30)} ${v}`);
  }
  console.log(`\nFurther exclusions among assigned+linode:`);
  console.log(`  frozen_at NOT NULL:           ${frozen}`);
  console.log(`  lifecycle_locked_at NOT NULL: ${locked}`);
  console.log(`  ip_address NULL:              ${noIp}`);
  console.log(`  gateway_token NULL:           ${noToken}`);
  console.log(`\nFleet-pusher would skip: ${(dist.data?.length ?? 0) - (exactFilter.data?.length ?? 0)} (sleeping/suspended/frozen/no-IP/no-token)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
