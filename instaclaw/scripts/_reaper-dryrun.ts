/**
 * Reaper dry-run (2026-06-10) — LOG ONLY, reaps nothing.
 *
 * Produces the two would-reclaim lists for Cooper's review BEFORE any reaper
 * code goes live. Predicate is the full Rule-14 classification via
 * lib/billing-status.ts:getBillingStatus (DB-cheap; the real reaper will use
 * getBillingStatusVerified before any actual destructive action). billing_exempt
 * rows surface as protected with their comp_exempt_<reason>.
 *
 *   List A — auth-abandon RELEASE reaper (N=72h):
 *     status=assigned + owner.onboarding_complete=false + assigned_at >72h ago
 *     + vm.partner null + NOT isPaying(full) → would release to pool.
 *     (Closes the /auth-provisions-before-payment gap: a user who authed,
 *      got a VM, never finished onboarding/paid.)
 *
 *   List B — Rule-14 Pass-2 HIBERNATE rewrite:
 *     status=assigned + health NOT suspended/hibernating + assigned_at >24h ago
 *     + NOT isPaying(full) → would hibernate. This is what suspend-check Pass 2
 *     WOULD do if its private sub+credit check were replaced with full Rule-14
 *     (honoring credits/partner/billing_exempt correctly).
 *
 *   npx tsx scripts/_reaper-dryrun.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createClient } from "@supabase/supabase-js";
import { getBillingStatus } from "@/lib/billing-status";

const HOURS = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // ── candidate fetch helpers ────────────────────────────────────────
  // classify a list of vm rows; partition would-reclaim vs protected.
  async function classifyAll(vms: Array<{ id: string; name: string; assigned_to: string }>, userEmail: Map<string, string>) {
    const reclaim: Array<{ name: string; email: string; reasons: string[] }> = [];
    const protectedRows: Array<{ name: string; email: string; reasons: string[] }> = [];
    for (const vm of vms) {
      const b = await getBillingStatus(supabase, vm.id);
      const row = {
        name: vm.name,
        email: userEmail.get(vm.assigned_to) ?? "(unknown)",
        reasons: b?.reasons ?? ["(no billing status)"],
      };
      if (b?.isPaying) protectedRows.push(row);
      else reclaim.push(row);
    }
    return { reclaim, protectedRows };
  }

  async function emailMap(userIds: string[]): Promise<Map<string, string>> {
    const m = new Map<string, string>();
    for (let i = 0; i < userIds.length; i += 100) {
      const chunk = userIds.slice(i, i + 100);
      const { data } = await supabase
        .from("instaclaw_users")
        .select("id, email")
        .in("id", chunk);
      for (const u of data ?? []) m.set(u.id, u.email ?? "(no email)");
    }
    return m;
  }

  // ── LIST A: auth-abandon RELEASE (N=72h) ───────────────────────────
  // owner onboarding_complete=false → find those user ids first, then their
  // assigned, >72h, partner-null VMs.
  const { data: incompleteUsers } = await supabase
    .from("instaclaw_users")
    .select("id")
    .eq("onboarding_complete", false);
  const incompleteIds = (incompleteUsers ?? []).map((u) => u.id);

  let listAvms: Array<{ id: string; name: string; assigned_to: string }> = [];
  if (incompleteIds.length) {
    for (let i = 0; i < incompleteIds.length; i += 100) {
      const chunk = incompleteIds.slice(i, i + 100);
      const { data } = await supabase
        .from("instaclaw_vms")
        .select("id, name, assigned_to, assigned_at, partner, health_status, status")
        .eq("status", "assigned")
        .is("partner", null)
        .lt("assigned_at", HOURS(72))
        .in("assigned_to", chunk);
      listAvms.push(...((data ?? []) as Array<{ id: string; name: string; assigned_to: string }>));
    }
  }

  // ── LIST B: Rule-14 Pass-2 HIBERNATE rewrite ───────────────────────
  const { data: listBraw } = await supabase
    .from("instaclaw_vms")
    .select("id, name, assigned_to, assigned_at, health_status, status")
    .eq("status", "assigned")
    .eq("provider", "linode")
    .not("assigned_to", "is", null)
    .neq("health_status", "suspended")
    .neq("health_status", "hibernating")
    .lt("assigned_at", HOURS(24))
    .limit(1000);
  const listBvms = ((listBraw ?? []) as Array<{ id: string; name: string; assigned_to: string }>);

  // shared email map
  const allUserIds = [...new Set([...listAvms, ...listBvms].map((v) => v.assigned_to).filter(Boolean))];
  const emails = await emailMap(allUserIds);

  const A = await classifyAll(listAvms, emails);
  const B = await classifyAll(listBvms, emails);

  const fmt = (rows: Array<{ name: string; email: string; reasons: string[] }>) =>
    rows.map((r) => `    ${r.name.padEnd(22)} ${r.email.padEnd(34)} [${r.reasons.join(", ")}]`).join("\n");

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("LIST A — auth-abandon RELEASE reaper (N=72h)  [DRY-RUN, reaps 0]");
  console.log("  predicate: assigned + onboarding_complete=false + assigned_at>72h");
  console.log("             + partner null + NOT isPaying(full Rule-14)");
  console.log(`  candidates examined: ${listAvms.length}`);
  console.log(`\n  WOULD RELEASE (${A.reclaim.length}):`);
  console.log(A.reclaim.length ? fmt(A.reclaim) : "    (none)");
  console.log(`\n  PROTECTED / skipped (${A.protectedRows.length}) — isPaying:`);
  console.log(A.protectedRows.length ? fmt(A.protectedRows) : "    (none)");

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("LIST B — Rule-14 Pass-2 HIBERNATE rewrite  [DRY-RUN, reaps 0]");
  console.log("  predicate: assigned + not suspended/hibernating + assigned_at>24h");
  console.log("             + NOT isPaying(full Rule-14)  [replaces sub+credit check]");
  console.log(`  candidates examined: ${listBvms.length}`);
  console.log(`\n  WOULD HIBERNATE (${B.reclaim.length}):`);
  console.log(B.reclaim.length ? fmt(B.reclaim) : "    (none)");
  console.log(`\n  PROTECTED / skipped (${B.protectedRows.length}):`);
  // surface billing_exempt rows explicitly
  const exemptB = B.protectedRows.filter((r) => r.reasons.some((x) => x.startsWith("comp_exempt")));
  console.log(`    of which billing_exempt: ${exemptB.length}`);
  exemptB.forEach((r) => console.log(`      ✦ ${r.name} ${r.email} [${r.reasons.join(", ")}]`));
  // protection-reason histogram
  const hist: Record<string, number> = {};
  for (const r of B.protectedRows) for (const reason of r.reasons) hist[reason] = (hist[reason] ?? 0) + 1;
  console.log("    protection-reason histogram:", JSON.stringify(hist));

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log(`SUMMARY: List A would release ${A.reclaim.length}; List B would hibernate ${B.reclaim.length}. Nothing reaped (dry-run).`);
}

main().then(() => process.exit(0));
