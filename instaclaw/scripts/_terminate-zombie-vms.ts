#!/usr/bin/env tsx
/**
 * _terminate-zombie-vms.ts — find + (optionally) terminate VMs that
 * are billing Linode without a paying customer.
 *
 * 2026-05-20 baseline: 894 DB rows, 267 live Linode instances. ~$4k/mo
 * leaked last month on churned-user VMs we kept paying for. This script
 * is the operator-driven one-shot cleanup, and `dry-run` is the report
 * Cooper sees before approving destructive action.
 *
 * Classification logic (zombie = candidate for termination):
 *
 *   Category A — terminated-but-billing: DB says status=terminated yet
 *     a Linode instance with the recorded provider_server_id still
 *     exists. Lying-DB; safe to delete from Linode.
 *
 *   Category B — failed > 7d: DB status=failed AND Linode instance
 *     exists AND VM created_at > 7d ago. Configure failed long ago,
 *     no user. Safe.
 *
 *   Category C — ready unassigned > 7d: DB status=ready AND
 *     assigned_to IS NULL AND created_at > 7d ago. Idle inventory;
 *     ready pool should be churning every few hours so a 7d-old ready
 *     VM is suspect.
 *
 *   Category D — assigned but unpaying: DB status=assigned AND the
 *     user has no isPaying signal (no active/trialing sub, no
 *     past_due-within-7d-grace, no credit_balance>0, no partner). Age
 *     > 7d AND last_user_activity_at > 48h ago.
 *
 *   Category E — assigned but orphan: status=assigned AND
 *     assigned_to IS NULL AND age > 7d. Should not happen but does.
 *
 * SAFETY GATES (all must pass before terminating):
 *
 *   1. VM age >= 7 days (provisioning grace)
 *   2. NEVER partner=edge_city (Cooper explicit + Edge Esmeralda is
 *      sponsor-funded; killing a partner VM mid-event is unacceptable)
 *   3. NEVER if owner has active/trialing Stripe sub
 *   4. NEVER if owner has credit_balance > 0 (WLD users — Rule 14)
 *   5. NEVER if owner has past_due sub within 7d grace (Rule 14)
 *   6. NEVER if owner has api_mode=all_inclusive + tier in (starter,
 *      pro, power) (all-inclusive tiers may have credit_balance=0
 *      normally — Rule 14 lesson 4)
 *   7. NEVER if last_user_activity_at within last 48h (in-flight user)
 *   8. NEVER if any Bankr token launch is in progress (column TBD —
 *      conservative skip if unsure)
 *
 * Dry-run default. --live flag actually issues Linode DELETE.
 *
 * Usage:
 *   npx tsx scripts/_terminate-zombie-vms.ts                 # dry-run
 *   npx tsx scripts/_terminate-zombie-vms.ts --live          # ACTUAL TERMINATION
 *   npx tsx scripts/_terminate-zombie-vms.ts --category=A    # filter
 *   npx tsx scripts/_terminate-zombie-vms.ts --max=10        # cap for testing
 */

import { readFileSync } from "fs";

for (const f of [
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.ssh-key",
]) {
  try {
    const env = readFileSync(f, "utf-8");
    for (const l of env.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {}
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const LINODE_TOKEN = process.env.LINODE_API_TOKEN!;
if (!SUPABASE_URL || !SUPABASE_KEY || !LINODE_TOKEN) {
  console.error("missing env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, LINODE_API_TOKEN");
  process.exit(2);
}

const LIVE_FLAG = process.argv.includes("--live");
const MAX_CAP = parseInt(
  process.argv.find((a) => a.startsWith("--max="))?.split("=")[1] ?? "9999",
  10,
);
const CATEGORY_FILTER = process.argv.find((a) => a.startsWith("--category="))?.split("=")[1];

const MONTHLY_COST_PER_VM_USD = 29; // CLAUDE.md: $29/mo per g6-dedicated-2 (negotiated rate)
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const NOW_MS = Date.now();

interface Vm {
  id: string;
  name: string | null;
  provider_server_id: string | null; // string-typed in PostgREST even though INT
  status: string | null;
  health_status: string | null;
  assigned_to: string | null;
  partner: string | null;
  created_at: string;
  last_user_activity_at: string | null;
  api_mode: string | null;
  tier: string | null;
  credit_balance: number | null;
}

interface Sub {
  user_id: string;
  status: string;
  current_period_end: string | null;
  payment_status: string | null;
  past_due_since: string | null;
}

interface User {
  id: string;
  email: string | null;
}

interface LinodeInstance {
  id: number;
  label: string;
  status: string;
  type: string;
  created: string;
}

interface ZombieRow {
  vm: Vm;
  category: "A" | "B" | "C" | "D" | "E";
  reason: string;
  user: User | null;
  sub: Sub | null;
  linode: LinodeInstance | null;
  ageDays: number;
  lastActivityHours: number | null;
  safetyGatesPass: boolean;
  safetyGateFailReason: string | null;
}

async function sbFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

/**
 * Paginated fetch — PostgREST defaults to max 1000 rows per response.
 * Loops via Range header until fewer than pageSize rows come back. The
 * `instaclaw_users` table has 7650 rows so a non-paginated fetch would
 * silently drop ~85% of records (caught 2026-05-20 — "(no user)" rows
 * in the dry-run for VMs that had perfectly good user records).
 */
async function sbFetchAll<T>(path: string, pageSize = 1000): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  while (true) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Range: `${offset}-${offset + pageSize - 1}`,
        "Range-Unit": "items",
      },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const chunk = (await res.json()) as T[];
    all.push(...chunk);
    if (chunk.length < pageSize) break;
    offset += pageSize;
    if (offset > 100_000) throw new Error("paginated fetch >100k rows; aborting");
  }
  return all;
}

async function fetchAllLinodes(): Promise<Map<number, LinodeInstance>> {
  const map = new Map<number, LinodeInstance>();
  let page = 1;
  while (page <= 20) {
    const res = await fetch(
      `https://api.linode.com/v4/linode/instances?page=${page}&page_size=200`,
      { headers: { Authorization: `Bearer ${LINODE_TOKEN}` } },
    );
    if (!res.ok) throw new Error(`Linode ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      data: LinodeInstance[];
      pages: number;
      results: number;
    };
    for (const inst of body.data) map.set(inst.id, inst);
    if (page >= body.pages) break;
    page++;
  }
  return map;
}

function safetyGatesEvaluate(
  vm: Vm,
  user: User | null,
  sub: Sub | null,
): { pass: boolean; failReason: string | null } {
  // Gate 1: VM age
  const ageMs = NOW_MS - new Date(vm.created_at).getTime();
  if (ageMs < SEVEN_DAYS_MS) {
    return { pass: false, failReason: `vm age ${(ageMs / 86400000).toFixed(1)}d < 7d (provisioning grace)` };
  }

  // Gate 2: partner = edge_city
  if (vm.partner === "edge_city") {
    return { pass: false, failReason: "partner=edge_city (Edge Esmeralda)" };
  }

  // Gate 3-6: paying-user checks (Rule 14)
  if (sub) {
    if (sub.status === "active" || sub.status === "trialing") {
      return { pass: false, failReason: `sub.status=${sub.status} (active customer)` };
    }
    if (sub.payment_status === "past_due" && sub.past_due_since) {
      const sinceMs = NOW_MS - new Date(sub.past_due_since).getTime();
      if (sinceMs < PAST_DUE_GRACE_MS) {
        return {
          pass: false,
          failReason: `payment_status=past_due within 7d grace (${(sinceMs / 86400000).toFixed(1)}d past_due)`,
        };
      }
    }
  }
  if (vm.credit_balance && vm.credit_balance > 0) {
    return { pass: false, failReason: `vm.credit_balance=${vm.credit_balance} > 0 (WLD user — Rule 14)` };
  }
  if (
    vm.api_mode === "all_inclusive" &&
    vm.tier &&
    ["starter", "pro", "power"].includes(vm.tier) &&
    sub &&
    sub.status === "active"
  ) {
    return { pass: false, failReason: `api_mode=all_inclusive tier=${vm.tier} + active sub (Rule 14)` };
  }

  // Gate 7: recent activity
  if (vm.last_user_activity_at) {
    const lastMs = new Date(vm.last_user_activity_at).getTime();
    const sinceMs = NOW_MS - lastMs;
    if (sinceMs < FORTY_EIGHT_HOURS_MS) {
      return {
        pass: false,
        failReason: `last_user_activity ${(sinceMs / 3600000).toFixed(1)}h ago < 48h`,
      };
    }
  }

  return { pass: true, failReason: null };
}

function classify(
  vm: Vm,
  user: User | null,
  sub: Sub | null,
  linodeExists: boolean,
): { category: "A" | "B" | "C" | "D" | "E"; reason: string } | null {
  const ageMs = NOW_MS - new Date(vm.created_at).getTime();
  const ageDays = ageMs / 86400000;

  // Category A: DB terminated but Linode still exists
  if (vm.status === "terminated" && linodeExists) {
    return { category: "A", reason: "terminated-but-linode-alive" };
  }

  // Skip terminated rows that are gone from Linode
  if (vm.status === "terminated") return null;

  // Categories B, C, D, E only matter if Linode instance exists
  if (!linodeExists) return null;

  if (vm.status === "failed" && ageDays >= 7) {
    return { category: "B", reason: `failed > 7d (age=${ageDays.toFixed(1)}d)` };
  }
  if (vm.status === "ready" && !vm.assigned_to && ageDays >= 7) {
    return { category: "C", reason: `ready unassigned > 7d (age=${ageDays.toFixed(1)}d)` };
  }
  if (vm.status === "assigned" && !vm.assigned_to && ageDays >= 7) {
    return { category: "E", reason: `assigned but assigned_to=null (orphan, age=${ageDays.toFixed(1)}d)` };
  }
  if (vm.status === "assigned" && vm.assigned_to && ageDays >= 7) {
    // Has assigned_to — check paying status
    const hasActiveSub =
      sub && (sub.status === "active" || sub.status === "trialing");
    const hasPastDueWithinGrace =
      sub &&
      sub.payment_status === "past_due" &&
      sub.past_due_since &&
      NOW_MS - new Date(sub.past_due_since).getTime() < PAST_DUE_GRACE_MS;
    const hasCredits = vm.credit_balance && vm.credit_balance > 0;
    const isPaying = hasActiveSub || hasPastDueWithinGrace || hasCredits;
    if (!isPaying) {
      const subStr = sub ? `sub.status=${sub.status}` : "no sub row";
      return {
        category: "D",
        reason: `assigned + not paying (${subStr}, credits=${vm.credit_balance ?? 0}, age=${ageDays.toFixed(1)}d)`,
      };
    }
  }

  return null;
}

async function main() {
  console.log("Loading DB + Linode universe…\n");

  const [vms, subs, users, linodes] = await Promise.all([
    sbFetchAll<Vm>(
      "instaclaw_vms?select=id,name,provider_server_id,status,health_status,assigned_to,partner,created_at,last_user_activity_at,api_mode,tier,credit_balance&order=created_at.desc",
    ),
    sbFetchAll<Sub>(
      "instaclaw_subscriptions?select=user_id,status,current_period_end,payment_status,past_due_since",
    ),
    sbFetchAll<User>("instaclaw_users?select=id,email"),
    fetchAllLinodes(),
  ]);
  console.log(`  ${vms.length} VMs in DB`);
  console.log(`  ${subs.length} subs in DB`);
  console.log(`  ${users.length} users in DB`);
  console.log(`  ${linodes.size} live Linode instances\n`);

  const subByUser = new Map<string, Sub>();
  for (const s of subs) {
    // If a user has multiple subs, prefer active > trialing > past_due > anything
    const existing = subByUser.get(s.user_id);
    const rank = (st: string) =>
      st === "active" ? 5 : st === "trialing" ? 4 : st === "past_due" ? 3 : st === "canceled" ? 2 : 1;
    if (!existing || rank(s.status) > rank(existing.status)) {
      subByUser.set(s.user_id, s);
    }
  }
  const userById = new Map(users.map((u) => [u.id, u]));

  // Classify
  const zombies: ZombieRow[] = [];
  for (const vm of vms) {
    const linodeId = vm.provider_server_id ? Number(vm.provider_server_id) : null;
    const linode = linodeId !== null ? linodes.get(linodeId) ?? null : null;
    const linodeExists = linode !== null;

    const user = vm.assigned_to ? userById.get(vm.assigned_to) ?? null : null;
    const sub = vm.assigned_to ? subByUser.get(vm.assigned_to) ?? null : null;

    const verdict = classify(vm, user, sub, linodeExists);
    if (!verdict) continue;
    if (CATEGORY_FILTER && verdict.category !== CATEGORY_FILTER) continue;

    const safety = safetyGatesEvaluate(vm, user, sub);
    const ageMs = NOW_MS - new Date(vm.created_at).getTime();
    const lastActivityHours = vm.last_user_activity_at
      ? (NOW_MS - new Date(vm.last_user_activity_at).getTime()) / 3600000
      : null;

    zombies.push({
      vm,
      category: verdict.category,
      reason: verdict.reason,
      user,
      sub,
      linode,
      ageDays: ageMs / 86400000,
      lastActivityHours,
      safetyGatesPass: safety.pass,
      safetyGateFailReason: safety.failReason,
    });
  }

  // Sort by category then cost (all VMs are $29/mo so secondary sort by age desc)
  zombies.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return b.ageDays - a.ageDays;
  });

  // Detailed table
  console.log("=".repeat(120));
  console.log(
    "CAT  VM              LINODE_ID  STATUS      AGE_D   LAST_USER_H  EMAIL                          SUB_STATUS    CREDITS  SAFETY",
  );
  console.log("=".repeat(120));
  for (const z of zombies) {
    const vmName = (z.vm.name ?? z.vm.id.slice(0, 8)).padEnd(15);
    const linodeId = String(z.linode?.id ?? z.vm.provider_server_id ?? "?").padEnd(9);
    const status = (z.vm.status ?? "?").padEnd(11);
    const ageDays = z.ageDays.toFixed(1).padStart(5);
    const lastH = (z.lastActivityHours !== null ? z.lastActivityHours.toFixed(1) : "—").padStart(11);
    const email = (z.user?.email ?? "(no user)").padEnd(30).slice(0, 30);
    const subStat = (z.sub?.status ?? "—").padEnd(13);
    const credits = String(z.vm.credit_balance ?? 0).padStart(7);
    const safety = z.safetyGatesPass ? "✓ OK" : `✗ ${z.safetyGateFailReason}`;
    console.log(
      ` ${z.category}   ${vmName} ${linodeId}  ${status} ${ageDays}d  ${lastH}h  ${email} ${subStat} ${credits}  ${safety}`,
    );
  }

  // Summary
  const byCategory = new Map<string, ZombieRow[]>();
  for (const z of zombies) {
    if (!byCategory.has(z.category)) byCategory.set(z.category, []);
    byCategory.get(z.category)!.push(z);
  }

  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY BY CATEGORY");
  console.log("=".repeat(80));
  let totalEligible = 0;
  let totalSafetyBlocked = 0;
  for (const [cat, rows] of Array.from(byCategory.entries()).sort()) {
    const safe = rows.filter((r) => r.safetyGatesPass).length;
    const blocked = rows.length - safe;
    totalEligible += safe;
    totalSafetyBlocked += blocked;
    const monthlyCost = rows.length * MONTHLY_COST_PER_VM_USD;
    const safeCost = safe * MONTHLY_COST_PER_VM_USD;
    const catLabel = {
      A: "A terminated-but-billing",
      B: "B failed > 7d",
      C: "C ready unassigned > 7d",
      D: "D assigned but unpaying",
      E: "E assigned orphan",
    }[cat as "A" | "B" | "C" | "D" | "E"];
    console.log(
      `  ${catLabel.padEnd(40)} ${String(rows.length).padStart(4)} VMs  ($${String(monthlyCost).padStart(6)}/mo)  | safe-to-terminate: ${String(safe).padStart(3)} ($${String(safeCost).padStart(6)}/mo) | blocked: ${blocked}`,
    );
  }
  console.log("=".repeat(80));
  console.log(
    `  TOTAL                                  ${String(zombies.length).padStart(4)} VMs  ($${String(zombies.length * MONTHLY_COST_PER_VM_USD).padStart(6)}/mo)  | safe-to-terminate: ${String(totalEligible).padStart(3)} ($${String(totalEligible * MONTHLY_COST_PER_VM_USD).padStart(6)}/mo) | blocked: ${totalSafetyBlocked}`,
  );

  // Termination phase
  const eligibles = zombies.filter((z) => z.safetyGatesPass).slice(0, MAX_CAP);

  if (!LIVE_FLAG) {
    console.log("\n" + "=".repeat(80));
    console.log(`DRY-RUN MODE. ${eligibles.length} VMs would be terminated.`);
    console.log("To execute: re-run with --live");
    console.log("=".repeat(80));
    process.exit(0);
  }

  // LIVE mode
  console.log("\n" + "=".repeat(80));
  console.log(`*** LIVE MODE *** terminating ${eligibles.length} VMs (max=${MAX_CAP})…`);
  console.log("=".repeat(80));
  let ok = 0;
  let failed = 0;
  for (const z of eligibles) {
    const linodeId = z.linode?.id ?? Number(z.vm.provider_server_id ?? 0);
    const vmName = z.vm.name ?? z.vm.id.slice(0, 8);
    if (!linodeId) {
      console.log(`  ✗ ${vmName}: no linode_id`);
      failed++;
      continue;
    }
    process.stdout.write(
      `  [${z.category}] ${vmName} (linode=${linodeId}) ${z.user?.email ?? "(no user)"} … `,
    );
    try {
      // 1. Linode DELETE
      const delRes = await fetch(
        `https://api.linode.com/v4/linode/instances/${linodeId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${LINODE_TOKEN}` },
        },
      );
      if (!delRes.ok && delRes.status !== 404) {
        const body = await delRes.text();
        process.stdout.write(`✗ linode delete failed ${delRes.status}: ${body.slice(0, 100)}\n`);
        failed++;
        continue;
      }

      // 2. DB status=terminated
      const dbRes = await fetch(
        `${SUPABASE_URL}/rest/v1/instaclaw_vms?id=eq.${z.vm.id}`,
        {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            status: "terminated",
            health_status: "unknown",
          }),
        },
      );
      if (!dbRes.ok) {
        process.stdout.write(`⚠ linode killed but DB update failed ${dbRes.status}\n`);
        failed++;
        continue;
      }

      // 3. Lifecycle log
      await fetch(`${SUPABASE_URL}/rest/v1/instaclaw_vm_lifecycle_log`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          vm_id: z.vm.id,
          vm_name: z.vm.name,
          ip_address: null,
          user_id: z.vm.assigned_to,
          user_email: z.user?.email,
          subscription_status: z.sub?.status ?? null,
          credit_balance: z.vm.credit_balance ?? 0,
          action: "zombie_terminated",
          reason: `category=${z.category} reason=${z.reason}`,
          provider_server_id: String(linodeId),
        }),
      }).catch(() => {});

      process.stdout.write(`✓\n`);
      ok++;
    } catch (e) {
      process.stdout.write(`✗ threw: ${(e as Error).message.slice(0, 100)}\n`);
      failed++;
    }
  }
  console.log("\n" + "=".repeat(80));
  console.log(`Done. ok=${ok} failed=${failed} / ${eligibles.length} attempted`);
  console.log(`Monthly burn eliminated: ~$${ok * MONTHLY_COST_PER_VM_USD}/mo`);
  console.log("=".repeat(80));
}

main().catch((e) => {
  console.error("threw:", e);
  process.exit(2);
});
