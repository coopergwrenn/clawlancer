/**
 * Triage VMs in status='failed' (or terminated/destroyed):
 *   - Are any still assigned to a paying user? (Critical — they need recovery)
 *   - When did they fail? Old failures are likely cleanup candidates.
 *   - Do any hold telegram tokens that conflict with active pending_users?
 *
 * Output is informational; no state changes.
 */
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

(async () => {
  console.log("=== Failed VM triage ===\n");

  const { data: failedVms } = await s.from("instaclaw_vms")
    .select("id, name, status, health_status, assigned_to, last_assigned_to, telegram_bot_token, telegram_bot_username, created_at, assigned_at, updated_at")
    .in("status", ["failed", "terminated", "destroyed"])
    .order("updated_at", { ascending: false });

  console.log(`Total VMs in failed/terminated/destroyed: ${failedVms?.length ?? 0}\n`);

  if (!failedVms || failedVms.length === 0) return;

  // Bucket by status
  const byStatus = new Map<string, number>();
  for (const v of failedVms) byStatus.set(v.status!, (byStatus.get(v.status!) ?? 0) + 1);
  console.log("By status:");
  for (const [s, c] of byStatus) console.log(`  ${s}: ${c}`);

  // Currently assigned to a user (real problem — paying user has no working VM)
  const stillAssigned = failedVms.filter((v) => v.assigned_to);
  console.log(`\n🚨 Currently assigned to a user (still paying, broken VM): ${stillAssigned.length}`);
  if (stillAssigned.length > 0) {
    console.log("Details:");
    for (const v of stillAssigned) {
      // Look up the user's sub
      const { data: u } = await s.from("instaclaw_users").select("email, onboarding_complete").eq("id", v.assigned_to!).maybeSingle();
      const { data: sub } = await s.from("instaclaw_subscriptions").select("status, payment_status, tier").eq("user_id", v.assigned_to!).maybeSingle();
      console.log(`  ${v.name?.padEnd(20)} status=${v.status} health=${v.health_status} assigned_at=${v.assigned_at} user=${u?.email ?? "?"} sub=${sub?.status ?? "none"}/${sub?.tier ?? "?"}`);
    }
  }

  // Token conflicts (dead VMs holding active pending tokens)
  const { data: pending } = await s.from("instaclaw_pending_users")
    .select("user_id, telegram_bot_token, telegram_bot_username")
    .is("consumed_at", null)
    .not("telegram_bot_token", "is", null);
  const pendingTokens = new Set<string>(((pending ?? []).map((p) => p.telegram_bot_token!)));
  const tokenConflicts = failedVms.filter((v) => v.telegram_bot_token && pendingTokens.has(v.telegram_bot_token));
  console.log(`\n🪙 Dead VMs holding active pending tokens (block re-config): ${tokenConflicts.length}`);
  for (const v of tokenConflicts) {
    console.log(`  ${v.name?.padEnd(20)} status=${v.status} bot=${v.telegram_bot_username}`);
  }

  // Age distribution
  const now = Date.now();
  const buckets = { "<7d": 0, "7-30d": 0, "30-90d": 0, ">90d": 0 };
  for (const v of failedVms) {
    const age = (now - new Date(v.updated_at).getTime()) / 86400000;
    if (age < 7) buckets["<7d"]++;
    else if (age < 30) buckets["7-30d"]++;
    else if (age < 90) buckets["30-90d"]++;
    else buckets[">90d"]++;
  }
  console.log("\nAge of failure (since last update):");
  for (const [k, v] of Object.entries(buckets)) console.log(`  ${k}: ${v}`);
})();
