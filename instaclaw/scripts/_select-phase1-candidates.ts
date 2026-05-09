/**
 * Phase 1 candidate selection — surfaces 5 VMs per tier (pro + power)
 * for Cooper to pick #2 and #3 of the 3-VM Phase 1 cohort.
 * (vm-050 is the starter — already done in Phase 0.)
 *
 * Selection criteria per PRD-gbrain-phase1-design.md §2.1:
 *   - status=assigned, provider=linode
 *   - health_status=healthy, health_fail_count=0
 *   - last_health_check < 30 min ago (recent enough to trust)
 *   - config_version >= 88 (TasksMax=120 + prctl-subreaper precondition)
 *   - assigned_to is Cooper or InstaClaw team (consent / dogfood-friendly)
 *   - NOT vm-893, vm-895 (lying-DB cohort, different problem class)
 *   - NOT vm-050 (already Phase 0 done)
 *   - had at least one chat session in the past 7 days (so the agent has
 *     real context to migrate; we estimate via vm.updated_at as proxy)
 *
 * Within each tier, rank by:
 *   - Most recent agent activity (updated_at desc) — fresher VMs are
 *     better canaries, more representative of "live" state
 *
 * Read-only. Doesn't touch any VMs. Doesn't write to DB.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  const env = readFileSync(f, "utf-8");
  for (const l of env.split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

// Cooper / InstaClaw team email allowlist. Add new team emails here.
const TEAM_EMAILS = new Set([
  "coop@valtlabs.com",
  "coopergrantwrenn@gmail.com",
]);

const EXCLUDE_VM_NAMES = new Set([
  "instaclaw-vm-050",  // Phase 0 already done
  "instaclaw-vm-893",  // lying-DB cohort
  "instaclaw-vm-895",  // lying-DB cohort
]);

(async () => {
  // 1. Resolve team user IDs from email allowlist.
  const { data: teamUsers } = await sb.from("instaclaw_users")
    .select("id,email")
    .in("email", Array.from(TEAM_EMAILS));
  const teamUserIds = new Set((teamUsers ?? []).map((u: any) => u.id));
  console.log(`Team users resolved: ${teamUserIds.size} (emails: ${Array.from(TEAM_EMAILS).join(", ")})\n`);

  if (teamUserIds.size === 0) {
    console.error("ERROR: no team users found by email. Update TEAM_EMAILS allowlist.");
    process.exit(1);
  }

  // 2. Pull all eligible assigned VMs.
  const cutoff30min = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const cutoff7days = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: vms } = await sb.from("instaclaw_vms")
    .select("name,ip_address,tier,api_mode,partner,assigned_to,config_version,health_status,health_fail_count,last_health_check,updated_at,strict_hold_streak")
    .eq("status", "assigned")
    .eq("provider", "linode")
    .eq("health_status", "healthy")
    .eq("health_fail_count", 0)
    .gte("config_version", 88)
    .gt("last_health_check", cutoff30min);

  if (!vms) {
    console.error("ERROR: VM query failed");
    process.exit(2);
  }

  // 3. Filter to team-owned + not-excluded + recent activity.
  const eligible = (vms as any[]).filter((v) =>
    teamUserIds.has(v.assigned_to) &&
    !EXCLUDE_VM_NAMES.has(v.name) &&
    v.updated_at > cutoff7days
  );

  console.log(`Eligible VMs after filters: ${eligible.length} of ${vms.length} healthy fleet VMs`);
  console.log(`(${vms.length - eligible.length} excluded: not-team-owned OR in exclude list OR no recent activity)\n`);

  // 4. Resolve user emails for display.
  const userIds = Array.from(new Set(eligible.map((v) => v.assigned_to).filter(Boolean)));
  const { data: users } = await sb.from("instaclaw_users").select("id,email").in("id", userIds);
  const emailById = new Map((users ?? []).map((u: any) => [u.id, u.email]));

  // 5. Group by tier, rank within tier.
  const groups: Record<string, any[]> = { power: [], pro: [], starter: [] };
  for (const vm of eligible) {
    const tier = vm.tier ?? "unknown";
    if (groups[tier]) groups[tier].push(vm);
  }
  for (const tier of Object.keys(groups)) {
    groups[tier].sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
  }

  // 6. Print top 5 per relevant tier.
  for (const tier of ["pro", "power"]) {
    const list = groups[tier];
    console.log(`══ Tier: ${tier} (${list.length} candidates total, showing top 5) ══`);
    if (list.length === 0) {
      console.log("  (none — try widening allowlist or relaxing recent-activity cutoff)");
    } else {
      for (let i = 0; i < Math.min(5, list.length); i++) {
        const v = list[i];
        const email = emailById.get(v.assigned_to) ?? "<unknown>";
        const lastUpd = v.updated_at?.slice(0, 19) ?? "?";
        const lastHc = v.last_health_check?.slice(0, 19) ?? "?";
        console.log(`  ${i + 1}. ${v.name.padEnd(20)} ip=${v.ip_address.padEnd(15)} cv=${v.config_version} api=${v.api_mode}`);
        console.log(`     owner=${email}  partner=${v.partner ?? "none"}  updated=${lastUpd}  health_check=${lastHc}`);
      }
    }
    console.log("");
  }

  // 7. Note the starter slot.
  console.log(`══ Tier: starter ══`);
  console.log(`  Already filled by vm-050 (Phase 0). Skipping.`);
})();
