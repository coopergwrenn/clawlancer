/**
 * One-shot refund script for the 2026-05-28 strip-thinking summary overcharge
 * incident. Identifies paying users whose daily budget got burned by the
 * periodic-summary cron (proxy ignoring x-model-override, content router
 * upgrading to sonnet/opus, charged to user budget).
 *
 * Victim selection (all three must hold):
 *   1. daily_usage today (UTC) message_count >= 50% of their tier's display limit
 *   2. usage_log today shows >= 50% of the cost coming from "summarize" prompts
 *      (matched by prompt_hint ILIKE)
 *   3. Paying customer per lib/billing-status.ts semantics (active/trialing sub,
 *      past_due within 7d grace, partner-tagged, OR credit_balance > 0)
 *
 * Refund: credit_balance = max(current, 2 * tier_display_limit)
 *   - starter (600 limit) → bumped to at least 1200
 *   - pro (1000 limit) → bumped to at least 2000
 *   - power (2500 limit) → bumped to at least 5000
 *   - internal (5000 limit) → bumped to at least 10000
 * Generous-but-not-absurd: 2x daily budget covers today + tomorrow buffer.
 *
 * Usage:
 *   npx tsx scripts/_refund-strip-thinking-victims-2026-05-28.ts            # dry-run, prints table
 *   npx tsx scripts/_refund-strip-thinking-victims-2026-05-28.ts --apply   # actually writes
 *
 * Outputs `/tmp/inc-2026-05-28-refunds.json` for audit trail.
 */

import { readFileSync, writeFileSync } from "node:fs";

function loadEnv(path: string) {
  try {
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
}
loadEnv("/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local");

const URL = "https://qvrnuyzfqjrsjljcqbub.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const APPLY = process.argv.includes("--apply");

const TIER_LIMITS: Record<string, number> = {
  starter: 600,
  pro: 1000,
  power: 2500,
  internal: 5000,
};
const PAST_DUE_GRACE_DAYS = 7;

async function pg<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> ?? {}),
    },
  });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  if (r.status === 204) return null as T;
  return r.json() as Promise<T>;
}

interface DailyUsage {
  vm_id: string;
  usage_date: string;
  message_count: number;
}
interface VmRow {
  id: string;
  name: string;
  assigned_to: string | null;
  tier: string | null;
  credit_balance: number | null;
  api_mode: string | null;
  partner: string | null;
  gbrain_enabled: boolean | null;
  health_status: string;
}
interface UsageLogRow {
  vm_id: string;
  call_type: string;
  cost_weight: number;
  prompt_hint: string | null;
}
interface UserRow { id: string; email: string; }
interface SubRow {
  user_id: string;
  tier: string | null;
  status: string;
  current_period_end: string | null;
}

function pastDueWithinGrace(sub: SubRow | undefined): boolean {
  if (!sub || sub.status !== "past_due" || !sub.current_period_end) return false;
  return Date.now() - new Date(sub.current_period_end).getTime() < PAST_DUE_GRACE_DAYS * 86400_000;
}

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n=== Strip-thinking refund audit — today=${today} UTC ===\n`);

  // Step 1: VMs at >= 50% of any tier cap today.
  const minCap = Math.min(...Object.values(TIER_LIMITS)) * 0.5; // 300
  const dailyUsage = await pg<DailyUsage[]>(
    `instaclaw_daily_usage?usage_date=eq.${today}&message_count=gte.${minCap}&select=vm_id,usage_date,message_count`
  );
  console.log(`Step 1: ${dailyUsage.length} VMs at >=${minCap} cost_weight today`);

  if (dailyUsage.length === 0) {
    console.log("Nothing to refund.");
    return;
  }

  // Step 2: Get VM details + tier-aware cap check.
  const vmIds = dailyUsage.map((d) => d.vm_id);
  const vmIdsList = vmIds.map((i) => `"${i}"`).join(",");
  const vms = await pg<VmRow[]>(
    `instaclaw_vms?id=in.(${vmIdsList})&select=id,name,assigned_to,tier,credit_balance,api_mode,partner,gbrain_enabled,health_status`
  );
  const vmById = new Map(vms.map((v) => [v.id, v]));

  // Filter to VMs at >= 50% of THEIR tier's limit
  const overTierCap = dailyUsage.filter((d) => {
    const vm = vmById.get(d.vm_id);
    if (!vm || !vm.tier) return false;
    const limit = TIER_LIMITS[vm.tier] ?? 600;
    return d.message_count >= limit * 0.5;
  });
  console.log(`Step 2: ${overTierCap.length} VMs at >=50% of THEIR tier's cap`);

  // Step 3: usage_log breakdown — confirm >= 50% of cost is summarize prompts.
  // PostgREST's prompt_hint=ilike can't easily filter for this in one query; do it per-VM.
  const summarizePattern = "%summariz%";  // matches "summarize", "summarizing"
  const allConfirmedVms: Array<{
    vm: VmRow;
    todayCost: number;
    summarizeCost: number;
    summarizeFraction: number;
  }> = [];

  for (const d of overTierCap) {
    const vm = vmById.get(d.vm_id)!;
    // Get ALL usage_log rows today + the SUMMARIZE-prompt subset
    const logs = await pg<UsageLogRow[]>(
      `instaclaw_usage_log?vm_id=eq.${d.vm_id}&created_at=gte.${today}T00:00:00&select=cost_weight,prompt_hint&limit=5000`
    );
    let totalCost = 0;
    let summarizeCost = 0;
    for (const l of logs) {
      const c = Number(l.cost_weight ?? 0);
      totalCost += c;
      const hint = (l.prompt_hint ?? "").toLowerCase();
      if (hint.includes("summariz") || hint.includes("summary")) summarizeCost += c;
    }
    const frac = totalCost > 0 ? summarizeCost / totalCost : 0;
    if (frac >= 0.5) {
      allConfirmedVms.push({ vm, todayCost: totalCost, summarizeCost, summarizeFraction: frac });
    }
  }
  console.log(`Step 3: ${allConfirmedVms.length} VMs confirmed >=50% summarize-prompt cost\n`);

  // Step 4: paying classification + assemble refund plan.
  const userIds = Array.from(new Set(allConfirmedVms.map((v) => v.vm.assigned_to).filter(Boolean) as string[]));
  if (userIds.length === 0) {
    console.log("No assigned users — nothing to refund.");
    return;
  }
  const uIds = userIds.map((u) => `"${u}"`).join(",");
  const users = await pg<UserRow[]>(`instaclaw_users?id=in.(${uIds})&select=id,email`);
  const userById = new Map(users.map((u) => [u.id, u]));
  const subs = await pg<SubRow[]>(`instaclaw_subscriptions?user_id=in.(${uIds})&select=user_id,tier,status,current_period_end`);
  const subByUserId = new Map(subs.map((s) => [s.user_id, s]));

  type RefundPlan = {
    name: string;
    email: string;
    tier: string;
    sub_status: string | null;
    is_paying: boolean;
    today_cost: number;
    summarize_cost: number;
    summarize_pct: string;
    credit_balance_before: number;
    credit_balance_after: number;
    bump_delta: number;
    reason: string;
  };
  const plan: RefundPlan[] = [];

  for (const c of allConfirmedVms) {
    const user = userById.get(c.vm.assigned_to!);
    const sub = subByUserId.get(c.vm.assigned_to!);
    const tier = c.vm.tier ?? "starter";
    const isPaying =
      sub?.status === "active" ||
      sub?.status === "trialing" ||
      pastDueWithinGrace(sub) ||
      Boolean(c.vm.partner) ||
      (c.vm.credit_balance ?? 0) > 0;
    const tierLimit = TIER_LIMITS[tier] ?? 600;
    const target = tierLimit * 2;
    const balanceBefore = c.vm.credit_balance ?? 0;
    const balanceAfter = Math.max(balanceBefore, target);
    const delta = balanceAfter - balanceBefore;
    plan.push({
      name: c.vm.name,
      email: user?.email ?? "(unknown)",
      tier,
      sub_status: sub?.status ?? null,
      is_paying: isPaying,
      today_cost: c.todayCost,
      summarize_cost: c.summarizeCost,
      summarize_pct: (c.summarizeFraction * 100).toFixed(1) + "%",
      credit_balance_before: balanceBefore,
      credit_balance_after: balanceAfter,
      bump_delta: delta,
      reason: `2026-05-28 strip-thinking summary overcharge. ${c.summarizeCost.toFixed(0)} of ${c.todayCost.toFixed(0)} cost_weight today was infrastructure summarize-prompt calls misrouted to sonnet/opus and charged to user budget.`,
    });
  }
  plan.sort((a, b) => b.today_cost - a.today_cost);

  // Print refund plan table.
  console.log("Refund plan:");
  console.log("  Format: vm-name  email  tier  sub  paying  today_cost  summary_cost  pct  balance_before→after  delta");
  for (const p of plan) {
    console.log(
      `  ${p.name.padEnd(18)} ${p.email.padEnd(38)} ${p.tier.padEnd(8)} ${(p.sub_status ?? "none").padEnd(10)} paying=${p.is_paying ? "Y" : "N"}  today=${p.today_cost.toFixed(0).padStart(5)} summarize=${p.summarize_cost.toFixed(0).padStart(5)} (${p.summarize_pct.padStart(6)})  bal=${p.credit_balance_before}→${p.credit_balance_after} +${p.bump_delta}`
    );
  }

  const payingPlan = plan.filter((p) => p.is_paying);
  console.log(`\nTotals: ${plan.length} candidates, ${payingPlan.length} paying`);

  writeFileSync("/tmp/inc-2026-05-28-refunds.json", JSON.stringify({
    audit_timestamp: new Date().toISOString(),
    today_utc: today,
    candidates: plan,
  }, null, 2));
  console.log("\nAudit trail written to /tmp/inc-2026-05-28-refunds.json");

  if (!APPLY) {
    console.log("\n[dry-run] Re-run with --apply to write the refunds.");
    return;
  }

  // Step 5: apply.
  console.log("\n=== APPLYING REFUNDS ===");
  let applied = 0, skipped = 0, failed = 0;
  for (const p of payingPlan) {
    if (p.bump_delta <= 0) {
      skipped++;
      continue;
    }
    try {
      const r = await pg<unknown>(
        `instaclaw_vms?name=eq.${p.name}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ credit_balance: p.credit_balance_after }),
        }
      );
      applied++;
      console.log(`  ✓ ${p.name} → credit_balance=${p.credit_balance_after} (+${p.bump_delta})`);
    } catch (e) {
      failed++;
      console.error(`  ✗ ${p.name} FAILED: ${String(e).slice(0, 120)}`);
    }
  }
  console.log(`\nApplied: ${applied}, skipped (no-bump-needed): ${skipped}, failed: ${failed}`);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
