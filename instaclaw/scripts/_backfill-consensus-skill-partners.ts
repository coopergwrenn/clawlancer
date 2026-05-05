/**
 * Backfill: enable the consensus-2026 skill for every existing VM whose
 * partner is 'edge_city' or 'consensus_2026'. New users hitting
 * /api/partner/tag get this automatically (the endpoint was extended in
 * a sibling commit); this script catches users who were tagged before
 * the migration ran.
 *
 * Idempotent — uses ignoreDuplicates so existing rows are not modified.
 * If a user has explicitly toggled the skill OFF (row exists with
 * enabled=false), this script preserves their choice.
 *
 * Pre-flight:
 *   1. Run the migration 20260505_consensus_2026_skill.sql in Studio
 *   2. Verify the skill row exists: select * from instaclaw_skills where slug='consensus-2026'
 *   3. Then run this script: npx tsx scripts/_backfill-consensus-skill-partners.ts
 *      (--dry-run for preview)
 */
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

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const TARGET_PARTNERS = ["edge_city", "consensus_2026"];
const TARGET_SKILL_SLUG = "consensus-2026";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`══ Backfill consensus-2026 skill for partners: ${TARGET_PARTNERS.join(", ")} ══`);
  if (dryRun) console.log("(DRY-RUN — preview only)");
  console.log("");

  // 1. Resolve the skill ID
  const { data: skill, error: skillErr } = await sb
    .from("instaclaw_skills")
    .select("id, slug, name, category")
    .eq("slug", TARGET_SKILL_SLUG)
    .maybeSingle();

  if (skillErr || !skill) {
    console.error(`FATAL: skill '${TARGET_SKILL_SLUG}' not found in registry. Run the migration first.`);
    process.exit(2);
  }
  console.log(`Skill: ${skill.name} (${skill.slug}, category=${skill.category}, id=${skill.id})`);

  // 2. Find target VMs
  const { data: vms, error: vmErr } = await sb
    .from("instaclaw_vms")
    .select("id, name, partner, assigned_to, health_status")
    .in("partner", TARGET_PARTNERS)
    .not("assigned_to", "is", null);

  if (vmErr) {
    console.error(`FATAL VM query: ${vmErr.message}`);
    process.exit(2);
  }
  if (!vms || vms.length === 0) {
    console.log("No VMs match. Nothing to backfill.");
    process.exit(0);
  }

  console.log(`\nTarget VMs: ${vms.length}`);
  const byPartner: Record<string, number> = {};
  for (const v of vms) byPartner[v.partner as string] = (byPartner[v.partner as string] ?? 0) + 1;
  for (const [p, n] of Object.entries(byPartner)) console.log(`  partner=${p}: ${n}`);

  // 3. Check existing rows so we know what's already set
  const vmIds = vms.map((v) => v.id as string);
  const { data: existing } = await sb
    .from("instaclaw_vm_skills")
    .select("vm_id, enabled")
    .eq("skill_id", skill.id as string)
    .in("vm_id", vmIds);

  const existingByVmId = new Map((existing ?? []).map((r) => [r.vm_id as string, r.enabled as boolean]));
  let alreadyOn = 0;
  let alreadyOff = 0;
  let willInsert = 0;
  for (const v of vms) {
    const e = existingByVmId.get(v.id as string);
    if (e === true) alreadyOn++;
    else if (e === false) alreadyOff++;
    else willInsert++;
  }
  console.log(`\nState breakdown:`);
  console.log(`  already enabled:   ${alreadyOn}`);
  console.log(`  user-disabled:     ${alreadyOff}  (will NOT be touched)`);
  console.log(`  no row → enable:   ${willInsert}`);

  if (dryRun) {
    console.log("\nDRY-RUN complete. Re-run without --dry-run to apply.");
    process.exit(0);
  }

  if (willInsert === 0) {
    console.log("\nNothing to insert — all target VMs already have a row.");
    process.exit(0);
  }

  // 4. Insert (ignoreDuplicates preserves existing rows including user-disabled ones)
  const rows = vms.map((v) => ({
    vm_id: v.id as string,
    skill_id: skill.id as string,
    enabled: true,
  }));

  const { error: insErr, count } = await sb
    .from("instaclaw_vm_skills")
    .upsert(rows, {
      onConflict: "vm_id,skill_id",
      ignoreDuplicates: true,
      count: "exact",
    });

  if (insErr) {
    console.error(`\nFATAL upsert: ${insErr.message}`);
    process.exit(1);
  }

  console.log(`\n✓ Inserted ${count ?? "?"} rows. ${alreadyOn} already-on rows untouched, ${alreadyOff} user-disabled rows preserved.`);
  console.log(`\nNext: matching pipeline picks up new state on next 30-min cron tick (≤30 min).`);
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
