/**
 * Investigate users assigned to a terminated/failed VM but whose
 * subscription is NOT canceled. They may be paying but unable to use
 * the service.
 */
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

(async () => {
  const { data: badVms } = await s.from("instaclaw_vms")
    .select("id, name, status, health_status, assigned_to, telegram_bot_username, updated_at")
    .in("status", ["failed", "terminated", "destroyed"])
    .not("assigned_to", "is", null);

  for (const v of badVms ?? []) {
    const { data: u } = await s.from("instaclaw_users")
      .select("id, email, onboarding_complete, deployment_lock_at")
      .eq("id", v.assigned_to!).maybeSingle();
    const { data: sub } = await s.from("instaclaw_subscriptions")
      .select("status, payment_status, tier, current_period_end")
      .eq("user_id", v.assigned_to!).maybeSingle();

    if (!sub) continue;
    if (sub.status === "canceled") continue;

    // Does this user ALSO have a working VM elsewhere?
    const { data: otherVms } = await s.from("instaclaw_vms")
      .select("name, status, health_status")
      .eq("assigned_to", v.assigned_to!)
      .not("status", "in", "(failed,terminated,destroyed)");

    console.log(`\n=== ${u?.email ?? v.assigned_to} ===`);
    console.log(`  user_id:    ${v.assigned_to}`);
    console.log(`  bad VM:     ${v.name} status=${v.status} health=${v.health_status} updated=${v.updated_at}`);
    console.log(`  sub:        ${sub.status}/${sub.tier} payment=${sub.payment_status} period_end=${sub.current_period_end}`);
    console.log(`  onboarding: ${u?.onboarding_complete}`);
    console.log(`  other VMs:  ${otherVms?.length ?? 0}`);
    for (const ov of otherVms ?? []) {
      console.log(`    ${ov.name} status=${ov.status} health=${ov.health_status}`);
    }
  }
})();
