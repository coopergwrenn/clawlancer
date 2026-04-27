/**
 * Post-outage P0 fleet health audit.
 *
 * Runs checks 1, 2, 4, 5 from Cooper's request:
 *   1. Orphaned users (paid sub, no VM)
 *   2. VM fleet state
 *   4. Credit state spot check (10 random active users)
 *   5. Ready pool depth + replenish health
 *
 * Read-only. Output is structured for programmatic post-processing in the
 * follow-up steps (cron probes, VM chat tests, auto-fix orphans).
 */
import * as path from "path";
import * as fs from "fs";
import { createClient } from "@supabase/supabase-js";
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Outage window estimate. The migration was applied 2026-04-24T15:50Z and
// Cooper said the outage lasted 13.9h — so roughly 02:00Z to 16:00Z that day.
const OUTAGE_START = new Date("2026-04-24T02:00:00Z");
const OUTAGE_END = new Date("2026-04-24T16:00:00Z");

interface Outcome {
  check: number;
  label: string;
  pass: boolean;
  details: Record<string, unknown>;
}

const results: Outcome[] = [];

(async () => {
  console.log(`╔══════════════════════════════════════════════════════════════════╗`);
  console.log(`║  POST-OUTAGE P0 AUDIT — ${new Date().toISOString()}`);
  console.log(`║  Outage window: ${OUTAGE_START.toISOString()} → ${OUTAGE_END.toISOString()}`);
  console.log(`╚══════════════════════════════════════════════════════════════════╝\n`);

  // ── CHECK 1: ORPHANED USERS ─────────────────────────────────────────────
  console.log(`══ CHECK 1 — Orphaned paid users ══`);
  const { data: paidSubs } = await s
    .from("instaclaw_subscriptions")
    .select("user_id, tier, status, payment_status, stripe_subscription_id, created_at")
    .in("status", ["active", "trialing", "past_due"]);

  const orphans: Array<{
    email: string;
    userId: string;
    tier: string;
    subStatus: string;
    paymentStatus: string;
    subCreated: string;
    onboardingComplete: boolean;
    deploymentLockAt: string | null;
    pendingUsersRow: boolean;
    pendingConsumed: string | null;
    pendingCreated: string | null;
    everHadVm: boolean;
    classification: string;
    autoFixable: boolean;
  }> = [];

  for (const sub of paidSubs ?? []) {
    const { data: u } = await s
      .from("instaclaw_users")
      .select("email, onboarding_complete, deployment_lock_at, created_at")
      .eq("id", sub.user_id)
      .single();
    if (!u) continue;

    const { data: vm } = await s
      .from("instaclaw_vms")
      .select("id")
      .eq("assigned_to", sub.user_id)
      .maybeSingle();
    if (vm) continue; // not an orphan

    const { data: pend } = await s
      .from("instaclaw_pending_users")
      .select("created_at, consumed_at, tier, stripe_session_id")
      .eq("user_id", sub.user_id)
      .maybeSingle();

    const { data: pastVms } = await s
      .from("instaclaw_vms")
      .select("id")
      .eq("last_assigned_to", sub.user_id);
    const everHadVm = (pastVms?.length ?? 0) > 0;

    // Classification:
    //   - past_due → user must resolve payment first; not auto-fixable
    //   - active/trialing + outage-window subscription → likely outage casualty, auto-fixable
    //   - active/trialing + pre-outage subscription → pre-existing problem, auto-fixable
    const subCreatedDate = new Date(sub.created_at);
    const inOutageWindow = subCreatedDate >= OUTAGE_START && subCreatedDate <= OUTAGE_END;
    let classification: string;
    let autoFixable = false;
    if (sub.status === "past_due") {
      classification = "PAYMENT_BLOCKED — user must resolve past_due before recovery";
    } else if (inOutageWindow) {
      classification = "OUTAGE_CASUALTY — sub created during outage window";
      autoFixable = true;
    } else if (subCreatedDate < OUTAGE_START) {
      classification = "PRE_OUTAGE — orphan predates outage; persistent recovery failure";
      autoFixable = true;
    } else {
      classification = "POST_OUTAGE — orphan created after outage ended";
      autoFixable = true;
    }

    orphans.push({
      email: u.email ?? "?",
      userId: sub.user_id,
      tier: sub.tier,
      subStatus: sub.status,
      paymentStatus: sub.payment_status ?? "?",
      subCreated: sub.created_at,
      onboardingComplete: u.onboarding_complete,
      deploymentLockAt: u.deployment_lock_at,
      pendingUsersRow: !!pend,
      pendingConsumed: pend?.consumed_at ?? null,
      pendingCreated: pend?.created_at ?? null,
      everHadVm,
      classification,
      autoFixable,
    });
  }

  console.log(`  Total orphans: ${orphans.length}`);
  console.log(`  Auto-fixable (active/trialing): ${orphans.filter((o) => o.autoFixable).length}`);
  console.log(`  Payment-blocked (past_due):     ${orphans.filter((o) => !o.autoFixable).length}`);
  console.log(``);
  for (const o of orphans) {
    console.log(`    ${o.email.padEnd(38)} tier=${o.tier.padEnd(7)} sub=${o.subStatus.padEnd(9)} pay=${o.paymentStatus.padEnd(9)} pending=${o.pendingUsersRow ? (o.pendingConsumed ? "consumed" : "open") : "none"} sub_created=${o.subCreated.slice(0, 19)}`);
    console.log(`      → ${o.classification}`);
  }

  results.push({
    check: 1,
    label: "Orphaned users",
    pass: orphans.filter((o) => o.autoFixable).length === 0,
    details: {
      total: orphans.length,
      autoFixable: orphans.filter((o) => o.autoFixable).length,
      paymentBlocked: orphans.filter((o) => !o.autoFixable).length,
      orphans,
    },
  });

  // Persist orphan list for the auto-fix step downstream.
  fs.writeFileSync(
    "/tmp/post-outage-orphans.json",
    JSON.stringify(orphans, null, 2),
  );

  // ── CHECK 2: VM FLEET STATE ─────────────────────────────────────────────
  console.log(`\n══ CHECK 2 — VM fleet state ══`);
  const { count: total } = await s.from("instaclaw_vms").select("*", { count: "exact", head: true });
  const statusCounts: Record<string, number> = {};
  for (const status of ["ready", "provisioning", "assigned", "failed"]) {
    const { count } = await s.from("instaclaw_vms").select("*", { count: "exact", head: true }).eq("status", status);
    statusCounts[status] = count ?? 0;
  }
  const { count: healthyAssigned } = await s.from("instaclaw_vms").select("*", { count: "exact", head: true }).eq("status", "assigned").eq("health_status", "healthy");
  const { count: unhealthyAssigned } = await s.from("instaclaw_vms").select("*", { count: "exact", head: true }).eq("status", "assigned").neq("health_status", "healthy");

  // Manifest version distribution among ASSIGNED VMs.
  const { data: assignedVersions } = await s
    .from("instaclaw_vms")
    .select("config_version, health_status")
    .eq("status", "assigned")
    .eq("provider", "linode");
  const versionDist = new Map<string, number>();
  let configZero = 0;
  for (const v of assignedVersions ?? []) {
    const k = String(v.config_version ?? "null");
    versionDist.set(k, (versionDist.get(k) ?? 0) + 1);
    if (v.config_version === 0) configZero++;
  }
  const versionSorted = Array.from(versionDist.entries()).sort((a, b) => Number(a[0]) - Number(b[0]));

  // Stale heartbeat — assigned VMs that haven't pinged proxy in >2 hours.
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { count: staleHeartbeat } = await s
    .from("instaclaw_vms")
    .select("*", { count: "exact", head: true })
    .eq("status", "assigned")
    .lt("last_proxy_call_at", twoHoursAgo);
  // Note: VMs with NULL last_proxy_call_at are excluded by the .lt() filter — count separately.
  const { count: neverProxied } = await s
    .from("instaclaw_vms")
    .select("*", { count: "exact", head: true })
    .eq("status", "assigned")
    .is("last_proxy_call_at", null);

  console.log(`  Total VMs:               ${total}`);
  console.log(`  By status: ready=${statusCounts.ready} provisioning=${statusCounts.provisioning} assigned=${statusCounts.assigned} failed=${statusCounts.failed}`);
  console.log(`  Assigned + healthy:      ${healthyAssigned}  (${(((healthyAssigned ?? 0) / (statusCounts.assigned || 1)) * 100).toFixed(1)}% of assigned)`);
  console.log(`  Assigned + UNhealthy:    ${unhealthyAssigned}`);
  console.log(`  Assigned + cfg=v0:       ${configZero}  (never reconciled past initial provision)`);
  console.log(`  Assigned + last proxy >2h ago: ${staleHeartbeat}  (potentially stuck)`);
  console.log(`  Assigned + never proxied:      ${neverProxied}`);
  console.log(`  Manifest version distribution (assigned VMs):`);
  for (const [v, n] of versionSorted) console.log(`    cfg=v${v.padEnd(4)} ${n}`);

  const VM_MANIFEST_VERSION = 61; // matches reconcile-fleet output earlier
  const atCurrentVersion = versionDist.get(String(VM_MANIFEST_VERSION)) ?? 0;
  const driftCount = (statusCounts.assigned ?? 0) - atCurrentVersion;

  results.push({
    check: 2,
    label: "VM fleet state",
    pass: (unhealthyAssigned ?? 0) < (statusCounts.assigned ?? 0) * 0.1, // <10% unhealthy = pass
    details: {
      total,
      statusCounts,
      healthyAssigned,
      unhealthyAssigned,
      configZero,
      staleHeartbeat,
      neverProxied,
      versionDistribution: Object.fromEntries(versionSorted),
      manifestVersion: VM_MANIFEST_VERSION,
      atCurrentVersion,
      driftCount,
    },
  });

  // ── CHECK 4: CREDIT STATE SPOT CHECK ─────────────────────────────────────
  console.log(`\n══ CHECK 4 — Credit state (10 random active users) ══`);
  const { data: activeVms } = await s
    .from("instaclaw_vms")
    .select("id, name, assigned_to, credit_balance, tier")
    .eq("status", "assigned")
    .eq("health_status", "healthy")
    .not("assigned_to", "is", null)
    .limit(200);
  // Random sample of 10
  const shuffled = [...(activeVms ?? [])].sort(() => Math.random() - 0.5).slice(0, 10);

  // For each, sum credit ledger entries to validate balance.
  const creditAnomalies: Array<{ vmName: string; tier: string; balance: number; ledgerSum: number; delta: number }> = [];
  let allBalancesNonNegative = true;
  for (const vm of shuffled) {
    if ((vm.credit_balance ?? 0) < 0) allBalancesNonNegative = false;

    const { data: ledger } = await s
      .from("instaclaw_credit_ledger")
      .select("amount")
      .eq("vm_id", vm.id);
    const ledgerSum = (ledger ?? []).reduce((sum: number, row: { amount: number }) => sum + (row.amount ?? 0), 0);
    const delta = (vm.credit_balance ?? 0) - ledgerSum;
    if (Math.abs(delta) > 0) {
      creditAnomalies.push({
        vmName: vm.name ?? vm.id.slice(0, 8),
        tier: vm.tier ?? "?",
        balance: vm.credit_balance ?? 0,
        ledgerSum,
        delta,
      });
    }
  }

  // Also: any VMs with negative balance fleet-wide (edge case).
  const { data: negativeBalance } = await s
    .from("instaclaw_vms")
    .select("id, name, credit_balance")
    .lt("credit_balance", 0);

  // Outage-correlation: usage_log entries during outage window.
  // Using vm_id, model, cost_weight, call_type, prompt_hint columns from instaclaw_usage_log
  const { count: outageUsageCount } = await s
    .from("instaclaw_usage_log")
    .select("*", { count: "exact", head: true })
    .gte("created_at", OUTAGE_START.toISOString())
    .lte("created_at", OUTAGE_END.toISOString());

  console.log(`  Sampled 10 random healthy assigned VMs.`);
  console.log(`  All balances non-negative:    ${allBalancesNonNegative ? "YES" : "NO"}`);
  console.log(`  Balance == ledger sum:        ${creditAnomalies.length === 0 ? "YES (all match)" : `NO (${creditAnomalies.length} mismatches)`}`);
  for (const a of creditAnomalies) {
    console.log(`    ANOMALY ${a.vmName} tier=${a.tier} balance=${a.balance} ledger=${a.ledgerSum} delta=${a.delta}`);
  }
  console.log(`  Fleet-wide negative balances: ${negativeBalance?.length ?? 0}`);
  for (const v of negativeBalance ?? []) console.log(`    ${v.name} balance=${v.credit_balance}`);
  console.log(`  Usage_log entries during outage window: ${outageUsageCount ?? 0}`);

  results.push({
    check: 4,
    label: "Credit state",
    pass: allBalancesNonNegative && creditAnomalies.length === 0 && (negativeBalance?.length ?? 0) === 0,
    details: {
      sampledCount: shuffled.length,
      allBalancesNonNegative,
      anomalies: creditAnomalies,
      fleetNegativeBalances: negativeBalance?.length ?? 0,
      negativeBalanceVms: negativeBalance ?? [],
      outageUsageCount: outageUsageCount ?? 0,
    },
  });

  // ── CHECK 5: READY POOL ─────────────────────────────────────────────────
  console.log(`\n══ CHECK 5 — Ready pool ══`);
  const POOL_FLOOR = 10;
  const POOL_TARGET = 15;
  const { count: ready } = await s.from("instaclaw_vms").select("*", { count: "exact", head: true }).eq("status", "ready");
  const { count: provisioning } = await s.from("instaclaw_vms").select("*", { count: "exact", head: true }).eq("status", "provisioning");
  const inFlight = (ready ?? 0) + (provisioning ?? 0);

  // Replenish-pool cron lock state
  const { data: lock } = await s
    .from("instaclaw_cron_locks")
    .select("*")
    .eq("name", "replenish-pool")
    .maybeSingle();

  // Latest 10 VMs created (proxy for "is replenish firing?")
  const { data: latestCreated } = await s
    .from("instaclaw_vms")
    .select("name, status, created_at")
    .order("created_at", { ascending: false })
    .limit(10);

  console.log(`  ready:        ${ready}  (FLOOR=${POOL_FLOOR}, TARGET=${POOL_TARGET})`);
  console.log(`  provisioning: ${provisioning}`);
  console.log(`  in-flight:    ${inFlight}`);
  console.log(`  replenish-pool cron lock: ${lock ? `locked=${lock.locked} locked_at=${lock.locked_at} released=${lock.released_at}` : "NO ROW"}`);
  console.log(`  latest 10 VMs created:`);
  for (const v of latestCreated ?? []) {
    const ageMin = Math.round((Date.now() - new Date(v.created_at).getTime()) / 60000);
    console.log(`    ${v.name?.padEnd(20)} status=${v.status?.padEnd(13)} age=${ageMin}min`);
  }

  results.push({
    check: 5,
    label: "Ready pool",
    pass: inFlight >= POOL_FLOOR,
    details: {
      ready: ready ?? 0,
      provisioning: provisioning ?? 0,
      inFlight,
      poolFloor: POOL_FLOOR,
      poolTarget: POOL_TARGET,
      replenishLock: lock,
      latestCreated: latestCreated ?? [],
    },
  });

  // ── Persist all results ─────────────────────────────────────────────────
  fs.writeFileSync(
    "/tmp/post-outage-audit.json",
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        outage_window: { start: OUTAGE_START.toISOString(), end: OUTAGE_END.toISOString() },
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nResults saved to /tmp/post-outage-audit.json (and orphan list at /tmp/post-outage-orphans.json)`);
  console.log(`\n=== END Phase 1 (checks 1, 2, 4, 5) ===`);
})();
