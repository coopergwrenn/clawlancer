/**
 * Audit script: find ALL paying users stuck in any non-healthy VM state.
 *
 * Born from the 2026-05-26 incident — three paying customers (anton, noyget,
 * leighton) sat in `health_status='configure_failed'` for ~2 months because
 * the 3-tier stuck-VM recovery pipeline + reconciler + process-pending Pass 2
 * all filter `configure_failed` out. The DB row was lying — gateways were
 * actually healthy on disk — but no automated path knew.
 *
 * This script is the one-shot operator tool to surface the full scope at
 * any moment. Run before/after the post-2026-05-26 preventive fixes to
 * confirm the recovery pipeline is doing its job.
 *
 * Usage:
 *   npx tsx scripts/_audit-stuck-paying-users.ts
 *   npx tsx scripts/_audit-stuck-paying-users.ts --json  (machine-readable)
 *
 * Exit code:
 *   0 — zero stuck paying users (fleet healthy)
 *   1 — at least one stuck paying user found
 *
 * The Tier-3 alerting cron (TODO post-incident) wraps this same query.
 */

import { readFileSync } from "node:fs";

function loadEnv(path: string) {
  try {
    const content = readFileSync(path, "utf-8");
    for (const line of content.split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* ignore */
  }
}
loadEnv("/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local");

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://qvrnuyzfqjrsjljcqbub.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY required (load from .env.local)");
  process.exit(2);
}

const jsonOut = process.argv.includes("--json");

interface VmRow {
  id: string;
  name: string;
  ip_address: string | null;
  health_status: string;
  config_version: number | null;
  configure_attempts: number | null;
  configure_lock_at: string | null;
  health_fail_count: number | null;
  last_health_check: string | null;
  last_proxy_call_at: string | null;
  last_user_activity_at: string | null;
  assigned_to: string;
  partner: string | null;
  api_mode: string | null;
  tier: string | null;
  reconcile_quarantined_at: string | null;
  updated_at: string | null;
  created_at: string | null;
}

interface UserRow {
  id: string;
  email: string;
  onboarding_complete: boolean | null;
  partner: string | null;
  created_at: string | null;
}

interface SubRow {
  user_id: string;
  tier: string | null;
  status: string;
  current_period_end: string | null;
}

async function pgQuery<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_KEY!,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Accept-Profile": "public",
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

function ageDays(iso: string | null): number | null {
  if (!iso) return null;
  return Math.round((Date.now() - new Date(iso).getTime()) / 86400_000);
}

(async () => {
  // 1. All assigned VMs with non-healthy status + assigned_to set.
  //    EXCLUDES `suspended` and `hibernating` (intentionally offline; Rule 15).
  const allNonHealthy = await pgQuery<VmRow[]>(
    "instaclaw_vms?status=eq.assigned&assigned_to=not.is.null" +
      "&health_status=not.eq.healthy" +
      "&select=id,name,ip_address,health_status,config_version,configure_attempts,configure_lock_at,health_fail_count,last_health_check,last_proxy_call_at,last_user_activity_at,assigned_to,partner,api_mode,tier,reconcile_quarantined_at,updated_at,created_at" +
      "&order=health_status.asc,config_version.asc",
  );

  if (allNonHealthy.length === 0) {
    if (!jsonOut) console.log("✓ Zero non-healthy assigned VMs with assigned_to set. Fleet clean.");
    else console.log(JSON.stringify({ stuck_count: 0, rows: [] }, null, 2));
    process.exit(0);
  }

  // 2. Bulk-fetch users + subs in one query each.
  const userIds = Array.from(new Set(allNonHealthy.map((v) => v.assigned_to)));
  const userIdsList = userIds.map((u) => `"${u}"`).join(",");
  const users = await pgQuery<UserRow[]>(
    `instaclaw_users?id=in.(${userIdsList})&select=id,email,onboarding_complete,partner,created_at`,
  );
  const userById = new Map(users.map((u) => [u.id, u]));

  const subs = await pgQuery<SubRow[]>(
    `instaclaw_subscriptions?user_id=in.(${userIdsList})&select=user_id,tier,status,current_period_end`,
  );
  const subByUserId = new Map(subs.map((s) => [s.user_id, s]));

  // 3. Classify each row.
  type Row = VmRow & {
    email: string;
    sub_status: string | null;
    sub_tier: string | null;
    is_paying: boolean;
    is_intentional_offline: boolean;
    stuck_class: "P0_PAYING_BROKEN" | "P1_PAYING_OFFLINE" | "P2_NONPAYING" | "P3_QUARANTINED";
    days_since_updated: number | null;
    days_since_proxy_call: number | null;
  };
  const classified: Row[] = allNonHealthy.map((vm) => {
    const user = userById.get(vm.assigned_to);
    const sub = subByUserId.get(vm.assigned_to);
    const subStatus = sub?.status ?? null;
    const isPaying =
      subStatus === "active" ||
      subStatus === "trialing" ||
      subStatus === "past_due" ||
      Boolean(vm.partner);
    const intentionalOffline =
      vm.health_status === "suspended" || vm.health_status === "hibernating";

    let stuckClass: Row["stuck_class"];
    if (vm.reconcile_quarantined_at) stuckClass = "P3_QUARANTINED";
    else if (intentionalOffline && isPaying) stuckClass = "P1_PAYING_OFFLINE";
    else if (isPaying) stuckClass = "P0_PAYING_BROKEN";
    else stuckClass = "P2_NONPAYING";

    return {
      ...vm,
      email: user?.email ?? "(unknown)",
      sub_status: subStatus,
      sub_tier: sub?.tier ?? null,
      is_paying: isPaying,
      is_intentional_offline: intentionalOffline,
      stuck_class: stuckClass,
      days_since_updated: ageDays(vm.updated_at),
      days_since_proxy_call: ageDays(vm.last_proxy_call_at),
    };
  });

  // 4. Render.
  if (jsonOut) {
    console.log(
      JSON.stringify(
        {
          stuck_count: classified.length,
          by_class: classified.reduce((acc, r) => {
            acc[r.stuck_class] = (acc[r.stuck_class] ?? 0) + 1;
            return acc;
          }, {} as Record<string, number>),
          by_health: classified.reduce((acc, r) => {
            acc[r.health_status] = (acc[r.health_status] ?? 0) + 1;
            return acc;
          }, {} as Record<string, number>),
          rows: classified,
        },
        null,
        2,
      ),
    );
    process.exit(classified.some((r) => r.stuck_class === "P0_PAYING_BROKEN") ? 1 : 0);
  }

  // Human-readable output.
  console.log(`\n=== STUCK PAYING-USER AUDIT — ${new Date().toISOString()} ===\n`);
  console.log(`Total non-healthy assigned VMs: ${classified.length}\n`);
  const byClass = classified.reduce((acc, r) => {
    acc[r.stuck_class] = (acc[r.stuck_class] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  for (const k of ["P0_PAYING_BROKEN", "P1_PAYING_OFFLINE", "P3_QUARANTINED", "P2_NONPAYING"]) {
    if (byClass[k]) console.log(`  ${k}: ${byClass[k]}`);
  }
  console.log("");

  // P0 first (paying + broken — REAL incident).
  const p0 = classified.filter((r) => r.stuck_class === "P0_PAYING_BROKEN");
  if (p0.length > 0) {
    console.log(`\n--- P0 PAYING BROKEN (${p0.length}) ---`);
    console.log(`  These are paying users whose VM is in a non-healthy state AND not intentionally offline.`);
    console.log(`  ACTION: investigate each — flip to healthy if gateway responds, escalate if not.\n`);
    for (const r of p0) {
      console.log(
        `  ${r.name.padEnd(18)} ${r.email.padEnd(38)} ${r.health_status.padEnd(20)} cv=${String(r.config_version).padEnd(3)} attempts=${r.configure_attempts} sub=${r.sub_status} tier=${r.sub_tier}`,
      );
      console.log(
        `    IP=${r.ip_address}  updated=${r.days_since_updated}d-ago  last_proxy=${r.days_since_proxy_call}d-ago`,
      );
    }
  }

  // P1 paying-but-intentionally-offline (suspended/hibernating).
  const p1 = classified.filter((r) => r.stuck_class === "P1_PAYING_OFFLINE");
  if (p1.length > 0) {
    console.log(`\n--- P1 PAYING OFFLINE (${p1.length}) ---`);
    console.log(`  Paying users whose VM is suspended/hibernating. May be legitimate (user-idle) or stuck-asleep.`);
    console.log(`  ACTION: check last_proxy_call_at — if recent, they're trying to use it; wake-paid-hibernating should handle.\n`);
    for (const r of p1) {
      console.log(
        `  ${r.name.padEnd(18)} ${r.email.padEnd(38)} ${r.health_status.padEnd(15)} cv=${r.config_version} last_proxy=${r.days_since_proxy_call ?? "?"}d-ago`,
      );
    }
  }

  // P3 quarantined.
  const p3 = classified.filter((r) => r.stuck_class === "P3_QUARANTINED");
  if (p3.length > 0) {
    console.log(`\n--- P3 QUARANTINED (${p3.length}) ---`);
    console.log(`  Reconciler quarantined these after K consecutive failures. Operator review needed.\n`);
    for (const r of p3) {
      console.log(`  ${r.name.padEnd(18)} ${r.email.padEnd(38)} quarantined=${r.reconcile_quarantined_at}`);
    }
  }

  // P2 non-paying.
  const p2 = classified.filter((r) => r.stuck_class === "P2_NONPAYING");
  if (p2.length > 0) {
    console.log(`\n--- P2 NON-PAYING (${p2.length}) ---  (informational only)`);
    for (const r of p2) {
      console.log(
        `  ${r.name.padEnd(18)} ${r.email.padEnd(38)} ${r.health_status.padEnd(20)} sub=${r.sub_status}`,
      );
    }
  }

  console.log("");
  process.exit(p0.length > 0 ? 1 : 0);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
