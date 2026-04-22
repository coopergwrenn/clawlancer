/**
 * Preview what Pass 0 of process-pending would recover on the CURRENT DB.
 * Runs the exact same query Pass 0 uses, prints the match list.
 *
 * Use this as dry-run preview before committing the cron diff.
 *
 * Usage:
 *   npx tsx scripts/_preview-pass0.ts
 */
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

(async () => {
  console.log(`=== Pass 0 preview (${new Date().toISOString()}) ===\n`);

  // Exact query from the new Pass 0 block
  const { data: orphans, error } = await s
    .from("instaclaw_subscriptions")
    .select("user_id, tier, status, instaclaw_users!inner(email, onboarding_complete)")
    .in("status", ["active", "trialing"])
    .eq("instaclaw_users.onboarding_complete", false)
    .limit(5);

  if (error) {
    console.error(`QUERY ERROR: ${error.message}`);
    process.exit(1);
  }

  console.log(`Orphan subscriptions matched by query (limit 5): ${orphans?.length ?? 0}\n`);
  for (const o of orphans ?? []) {
    const email = (o as {instaclaw_users?:{email?:string}}).instaclaw_users?.email ?? "?";
    // Safety-check in Pass 0 also looks up VM — mirror it here
    const { data: vm } = await s.from("instaclaw_vms").select("id").eq("assigned_to", o.user_id).maybeSingle();
    console.log(`  ${email} (user=${o.user_id.slice(0,8)}): tier=${o.tier} sub.status=${o.status} existingVm=${vm ? vm.id.slice(0,8) : "NONE"}`);
  }

  // Show broader "would-find" without the limit, for full visibility
  console.log(`\n--- Without limit (full pool of orphans to expect across cron cycles) ---`);
  const { data: all } = await s
    .from("instaclaw_subscriptions")
    .select("user_id, tier, status, instaclaw_users!inner(email, onboarding_complete)")
    .in("status", ["active", "trialing"])
    .eq("instaclaw_users.onboarding_complete", false);
  console.log(`Total orphans currently: ${all?.length ?? 0}`);
  for (const o of all ?? []) {
    const email = (o as {instaclaw_users?:{email?:string}}).instaclaw_users?.email ?? "?";
    console.log(`    ${email.padEnd(40)} tier=${o.tier.padEnd(7)} status=${o.status}`);
  }

  // Also preview what would happen with past_due (intentionally excluded — show for visibility)
  console.log(`\n--- past_due (NOT touched by Pass 0 — for visibility only) ---`);
  const { data: pastDue } = await s
    .from("instaclaw_subscriptions")
    .select("user_id, tier, status, instaclaw_users!inner(email, onboarding_complete)")
    .eq("status", "past_due")
    .eq("instaclaw_users.onboarding_complete", false);
  console.log(`past_due orphans: ${pastDue?.length ?? 0}`);
  for (const o of pastDue ?? []) {
    const email = (o as {instaclaw_users?:{email?:string}}).instaclaw_users?.email ?? "?";
    console.log(`    ${email.padEnd(40)} tier=${o.tier.padEnd(7)} status=${o.status}`);
  }
})();
