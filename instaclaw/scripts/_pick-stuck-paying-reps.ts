/**
 * Pick 3 representative VMs from the ~53 paying-but-reconcile-stuck cohort
 * for deep triage. Spread across tiers when possible.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { getBillingStatusVerified } from "../lib/billing-status";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  for (const l of readFileSync(f, "utf-8").split("\n")) {
    const m = l.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) {
      process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

async function main() {
  const reconcileCutoff = new Date(Date.now() - 14 * 86400_000).toISOString();
  const userCutoff = new Date(Date.now() - 7 * 86400_000).toISOString();

  const { data: cand } = await sb
    .from("instaclaw_vms")
    .select("id, name, config_version, tier, assigned_to, updated_at, last_user_activity_at, ip_address")
    .eq("status", "assigned")
    .eq("provider", "linode")
    .eq("health_status", "healthy")
    .lt("config_version", 84)
    .lt("updated_at", reconcileCutoff)
    .order("updated_at", { ascending: true });

  if (!cand) { console.error("query failed"); process.exit(1); }

  const filtered = cand.filter((v) =>
    !v.last_user_activity_at || new Date(v.last_user_activity_at).toISOString() < userCutoff,
  );

  console.log(`Candidate stuck-head VMs: ${filtered.length}`);
  const byTier: Record<string, number> = {};
  for (const v of filtered) byTier[v.tier || "(none)"] = (byTier[v.tier || "(none)"] || 0) + 1;
  console.log(`By tier:`, JSON.stringify(byTier));

  console.log(`\nVerifying billing for all candidates (Stripe-truth)...`);
  const paying: typeof filtered = [];
  for (let i = 0; i < filtered.length; i++) {
    try {
      const s = await getBillingStatusVerified(sb, stripe, filtered[i].id);
      if (s && s.isPaying) paying.push(filtered[i]);
    } catch { /* noop */ }
  }
  console.log(`Paying confirmed: ${paying.length}`);

  // Pick 3 — one per distinct tier, spread by cv if possible
  const tiersSeen = new Set<string>();
  const picks: typeof filtered = [];
  for (const vm of paying) {
    const t = vm.tier || "(none)";
    if (!tiersSeen.has(t) && picks.length < 3) {
      tiersSeen.add(t);
      picks.push(vm);
    }
  }
  if (picks.length < 3) {
    for (const vm of paying) {
      if (!picks.includes(vm) && picks.length < 3) picks.push(vm);
    }
  }

  console.log(`\n=== Selected representative VMs ===`);
  for (const p of picks) {
    const updAge = ((Date.now() - new Date(p.updated_at).getTime()) / 86400_000).toFixed(1);
    console.log(`  ${(p.name ?? "").padEnd(22)} cv=${p.config_version}  tier=${p.tier}  upd=${updAge}d  ip=${p.ip_address}`);
  }
}

main().then(() => process.exit(0));
