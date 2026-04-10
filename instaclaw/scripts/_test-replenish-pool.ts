/**
 * Local test for replenish-pool decision logic + DB queries.
 *
 * Runs the same SELECT queries the cron route would, plus exercises the
 * pure decision function with mocked states. NO writes. NO Linode API calls.
 *
 * Usage:
 *   cd instaclaw && npx tsx scripts/_test-replenish-pool.ts
 */

import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local manually
for (const f of [".env.local"]) {
  try {
    const c = readFileSync(resolve(".", f), "utf-8");
    for (const l of c.split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m) {
        const k = m[1].trim();
        const v = m[2].trim().replace(/^["']|["']$/g, "");
        if (!process.env[k]) process.env[k] = v;
      }
    }
  } catch {}
}

import { decideAction, type PoolConfig, type PoolState } from "../lib/replenish-pool-logic";
import { getSupabase } from "../lib/supabase";

const CONFIG: PoolConfig = {
  POOL_FLOOR: 10,
  POOL_TARGET: 15,
  POOL_CEILING: 30,
  POOL_CRITICAL: 3,
  MAX_PER_RUN: 10,
  MAX_TOTAL_VMS: 500,
};

// ─── Part 1: Pure decision logic tests ────────────────────────────────────

function emptyState(overrides: Partial<PoolState> = {}): PoolState {
  return {
    ready: 0,
    provisioning: 0,
    total: 200,
    stuckProvisioning: [],
    ...overrides,
  };
}

interface TestCase {
  name: string;
  state: PoolState;
  expectAction: string;
  expectToProvision: number;
  expectCritical: boolean;
}

const cases: TestCase[] = [
  // ─── Basic states (no in-flight provisioning) ───────────────────────────
  {
    name: "Pool empty (0 ready, 0 provisioning)",
    state: emptyState({ ready: 0 }),
    expectAction: "provision",
    expectToProvision: 10, // 15 needed → capped by MAX_PER_RUN
    expectCritical: true,
  },
  {
    name: "Pool critical (1 ready, 0 provisioning)",
    state: emptyState({ ready: 1 }),
    expectAction: "provision",
    expectToProvision: 10, // 14 needed → capped
    expectCritical: true,
  },
  {
    name: "Pool below critical (3 = critical edge)",
    state: emptyState({ ready: 3 }),
    expectAction: "provision",
    expectToProvision: 10, // 12 needed → capped
    expectCritical: true,
  },
  {
    name: "Pool below floor (5 ready, 0 provisioning)",
    state: emptyState({ ready: 5 }),
    expectAction: "provision",
    expectToProvision: 10, // in-flight=5, need 10
    expectCritical: false,
  },
  {
    name: "Pool just below floor (9 ready, 0 provisioning)",
    state: emptyState({ ready: 9 }),
    expectAction: "provision",
    expectToProvision: 6, // in-flight=9, target=15, need 6
    expectCritical: false,
  },
  {
    name: "Pool at floor (10 ready, 0 provisioning)",
    state: emptyState({ ready: 10 }),
    expectAction: "skip_healthy",
    expectToProvision: 0,
    expectCritical: false,
  },
  {
    name: "Pool above floor (15 ready, 0 provisioning)",
    state: emptyState({ ready: 15 }),
    expectAction: "skip_healthy",
    expectToProvision: 0,
    expectCritical: false,
  },
  {
    name: "Pool at ceiling (30 ready, 0 provisioning)",
    state: emptyState({ ready: 30 }),
    expectAction: "skip_healthy", // healthy first — 30 >= 10 floor
    expectToProvision: 0,
    expectCritical: false,
  },

  // ─── Cost ceiling ───────────────────────────────────────────────────────
  {
    name: "Cost ceiling reached (500 total)",
    state: emptyState({ ready: 5, total: 500 }),
    expectAction: "skip_cap",
    expectToProvision: 0,
    expectCritical: false,
  },
  {
    name: "Cost ceiling near (495 total, need 10)",
    state: emptyState({ ready: 5, total: 495 }),
    expectAction: "provision",
    expectToProvision: 5, // 10 needed but only 5 slots left
    expectCritical: false,
  },

  // ─── Stuck VMs ──────────────────────────────────────────────────────────
  {
    name: "Stuck provisioning VMs",
    state: emptyState({
      ready: 5,
      provisioning: 3,
      stuckProvisioning: [
        { name: "instaclaw-vm-100", minutesOld: 25 },
        { name: "instaclaw-vm-101", minutesOld: 30 },
      ],
    }),
    expectAction: "skip_stuck",
    expectToProvision: 0,
    expectCritical: false,
  },
  {
    name: "Stuck VMs AND critical pool",
    state: emptyState({
      ready: 1,
      provisioning: 2,
      stuckProvisioning: [{ name: "instaclaw-vm-100", minutesOld: 20 }],
    }),
    expectAction: "skip_stuck",
    expectToProvision: 0,
    expectCritical: true, // alert independent of action
  },

  // ─── BUG #4 FIX: in-flight (provisioning) counted as inventory ──────────
  {
    name: "BUG#4: ready=5, provisioning=8 → in-flight=13, skip_healthy",
    state: emptyState({ ready: 5, provisioning: 8 }),
    expectAction: "skip_healthy",
    expectToProvision: 0,
    expectCritical: false,
  },
  {
    name: "BUG#4: ready=5, provisioning=3 → in-flight=8, provision deficit (7)",
    state: emptyState({ ready: 5, provisioning: 3 }),
    expectAction: "provision",
    expectToProvision: 7, // target(15) - inFlight(8) = 7
    expectCritical: false,
  },
  {
    name: "BUG#4: ready=0, provisioning=15 → skip_healthy but CRITICAL alert",
    state: emptyState({ ready: 0, provisioning: 15 }),
    expectAction: "skip_healthy",
    expectToProvision: 0,
    expectCritical: true, // ready=0 ≤ POOL_CRITICAL even though in-flight is fine
  },
  {
    name: "BUG#4: ready=2, provisioning=10 → skip_healthy, critical (ready≤3)",
    state: emptyState({ ready: 2, provisioning: 10 }),
    expectAction: "skip_healthy",
    expectToProvision: 0,
    expectCritical: true,
  },
  {
    name: "BUG#4: ready=10, provisioning=5 → skip_healthy (already at floor)",
    state: emptyState({ ready: 10, provisioning: 5 }),
    expectAction: "skip_healthy",
    expectToProvision: 0,
    expectCritical: false,
  },
  {
    name: "BUG#4 regression: ready=0, provisioning=0 → still provision",
    state: emptyState({ ready: 0, provisioning: 0 }),
    expectAction: "provision",
    expectToProvision: 10,
    expectCritical: true,
  },
];

console.log("═══════════════════════════════════════════════════════");
console.log("  Replenish-Pool Decision Logic Tests");
console.log("═══════════════════════════════════════════════════════\n");

let passed = 0;
let failed = 0;

for (const c of cases) {
  const d = decideAction(c.state, CONFIG);
  const ok =
    d.action === c.expectAction &&
    d.toProvision === c.expectToProvision &&
    d.criticalAlert === c.expectCritical;

  if (ok) {
    passed++;
    console.log(`  ✅ ${c.name}`);
  } else {
    failed++;
    console.log(`  ❌ ${c.name}`);
    console.log(
      `     expected: action=${c.expectAction} toProvision=${c.expectToProvision} critical=${c.expectCritical}`
    );
    console.log(
      `     got:      action=${d.action} toProvision=${d.toProvision} critical=${d.criticalAlert}`
    );
    console.log(`     reason: ${d.reason}`);
  }
}

console.log(`\n  Result: ${passed}/${cases.length} passed${failed > 0 ? ` — ${failed} FAILED` : ""}`);
console.log("");

if (failed > 0) {
  console.error("Decision logic tests failed. Aborting DB query test.");
  process.exit(1);
}

// ─── Part 2: Real DB query (no writes) ────────────────────────────────────

async function testRealQueries() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  Real DB Query Test (NO writes)");
  console.log("═══════════════════════════════════════════════════════\n");

  const supabase = getSupabase();

  // Same queries the route uses
  const { count: readyCount, error: readyErr } = await supabase
    .from("instaclaw_vms")
    .select("*", { count: "exact", head: true })
    .eq("status", "ready")
    .eq("provider", "linode");
  if (readyErr) throw readyErr;

  const { data: provisioningVms, error: provErr } = await supabase
    .from("instaclaw_vms")
    .select("name, created_at")
    .eq("status", "provisioning");
  if (provErr) throw provErr;

  const { count: totalCount, error: totalErr } = await supabase
    .from("instaclaw_vms")
    .select("*", { count: "exact", head: true })
    .not("status", "in", "(terminated,destroyed,failed)");
  if (totalErr) throw totalErr;

  const now = Date.now();
  const stuckThresholdMs = 15 * 60 * 1000;

  const stuck = (provisioningVms ?? [])
    .map((vm) => ({
      name: vm.name ?? "unknown",
      ageMs: now - new Date(vm.created_at).getTime(),
    }))
    .filter((vm) => vm.ageMs > stuckThresholdMs)
    .map(({ name, ageMs }) => ({ name, minutesOld: Math.round(ageMs / 60000) }));

  const state: PoolState = {
    ready: readyCount ?? 0,
    provisioning: provisioningVms?.length ?? 0,
    total: totalCount ?? 0,
    stuckProvisioning: stuck,
  };

  console.log("Current pool state:");
  console.log(`  ready (Linode):  ${state.ready}`);
  console.log(`  provisioning:    ${state.provisioning}`);
  console.log(`  total active:    ${state.total}`);
  console.log(`  stuck (>15min):  ${state.stuckProvisioning.length}`);
  if (state.stuckProvisioning.length > 0) {
    for (const s of state.stuckProvisioning) {
      console.log(`    - ${s.name} (${s.minutesOld} min old)`);
    }
  }

  console.log("\nConfig:");
  console.log(`  POOL_FLOOR:    ${CONFIG.POOL_FLOOR}`);
  console.log(`  POOL_TARGET:   ${CONFIG.POOL_TARGET}`);
  console.log(`  POOL_CEILING:  ${CONFIG.POOL_CEILING}`);
  console.log(`  POOL_CRITICAL: ${CONFIG.POOL_CRITICAL}`);
  console.log(`  MAX_PER_RUN:   ${CONFIG.MAX_PER_RUN}`);
  console.log(`  MAX_TOTAL_VMS: ${CONFIG.MAX_TOTAL_VMS}`);

  const decision = decideAction(state, CONFIG);

  console.log("\nDecision (DRY RUN — no VMs created):");
  console.log(`  action:        ${decision.action}`);
  console.log(`  toProvision:   ${decision.toProvision}`);
  console.log(`  reason:        ${decision.reason}`);
  console.log(`  criticalAlert: ${decision.criticalAlert}`);
  console.log("\n  ✅ DB queries succeeded. Cron is safe to deploy.\n");
}

testRealQueries().catch((err) => {
  console.error("\n❌ DB query test failed:", err);
  process.exit(1);
});
