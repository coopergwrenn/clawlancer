/**
 * Video Creator Plan — the spread-table acceptance tests (Rule 31).
 * Every row's proof is DISCRIMINATING: it FAILS if the logic is wrong, not
 * just passes when it's right (e.g. grant idempotency is proven by
 * burn-then-retry — a guard-less SET passes naive value checks; 533≠546
 * catches it).
 *
 * RUNS ONLY AFTER pending_migrations/20260612200000_video_creator_plan.sql
 * is applied (held for Cooper's Studio review). Exits cleanly before then.
 *
 * Test subject: vm-050 (the canary). Every mutation is recorded and RESTORED;
 * synthetic transactions use test-tagged request_ids and are deleted at the
 * end (they would otherwise pollute the funnel/burn metrics).
 *
 * Usage: npx tsx scripts/_test-video-plan.ts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { VIDEO_BILLING_WIPE_FIELDS } from "../lib/vm-billing-wipe";

for (const l of readFileSync("/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local", "utf-8").split("\n")) {
  const m = l.match(/^([^#=]+)=(.*)$/);
  if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
}
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://qvrnuyzfqjrsjljcqbub.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const VM = "4922f655-f0c1-4161-b8ff-79b24e1a3166"; // vm-050
const T2V = "kling-video/v3.0/pro/text-to-video";
const TAG = `vptest_${Date.now()}`;
let seq = 0;
const rid = () => `${TAG}_${++seq}`;

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

const P1 = "2026-07-01T00:00:00.000Z";
const P2 = "2026-08-01T00:00:00.000Z";
const FUTURE = new Date(Date.now() + 20 * 86400_000).toISOString(); // in-period "now" window
const PAST = new Date(Date.now() - 86400_000).toISOString();

async function vmState() {
  const { data } = await sb.from("instaclaw_vms")
    .select("video_credit_balance, video_plan_status, video_plan_allowance_remaining, video_plan_period_end, video_plan_stripe_sub_id, video_plan_last_invoice_id")
    .eq("id", VM).single();
  return data!;
}
async function setPlan(p: Record<string, unknown>) {
  const { error } = await sb.from("instaclaw_vms").update(p).eq("id", VM);
  if (error) throw new Error(`setPlan: ${error.message}`);
}
async function grant(invoiceId: string, periodEnd: string, allowance = 546, status = "active") {
  return sb.rpc("instaclaw_video_plan_grant", {
    p_vm_id: VM, p_invoice_id: invoiceId, p_sub_id: "sub_test", p_status: status,
    p_period_end: periodEnd, p_allowance: allowance,
  });
}
async function reserve(est = 13) {
  const id = rid();
  const r = await sb.rpc("instaclaw_video_reserve_spend", {
    p_vm_id: VM, p_request_id: id, p_endpoint: T2V, p_est_credits: est,
    p_hf_cost_credits: 13, p_is_free: false, p_free_cap_daily: 2, p_cap_daily: 100000,
    p_window_start: new Date(Date.now() - 3600_000).toISOString(),
    p_fresh_pending_cutoff: new Date(Date.now() - 1800_000).toISOString(),
    p_metadata: { test: TAG },
  });
  return { id, ...r };
}
async function settle(requestId: string, actual = 13) {
  return sb.rpc("instaclaw_video_settle", {
    p_vm_id: VM, p_request_id: requestId, p_actual_credits: actual, p_metadata: { test_settle: true },
  });
}
async function release(requestId: string) {
  return sb.rpc("instaclaw_video_release", { p_vm_id: VM, p_request_id: requestId, p_reason: "test" });
}

async function main() {
  // Migration applied? READ-ONLY probes (the first version's probe was a
  // real grant() that errored cleanly pre-apply but MUTATED vm-050's plan
  // columns post-apply, polluting the pre-test snapshot — caught in the
  // 2026-06-12 first run's self-audit and cleaned by hand. Never probe with
  // a write.)
  const colProbe = await sb.from("instaclaw_vms").select("video_plan_status").eq("id", VM).single();
  if (colProbe.error) {
    console.log("⏸  plan columns not applied yet — apply 20260612200000 then re-run. (held for review)");
    process.exit(0);
  }
  const fnProbe = await sb.rpc("instaclaw_video_plan_grant", {
    // vm_not_found path: a random uuid that cannot exist — exercises the
    // function WITHOUT touching any real row.
    p_vm_id: "00000000-0000-0000-0000-000000000000",
    p_invoice_id: "probe", p_sub_id: null, p_status: "canceled",
    p_period_end: P1, p_allowance: 0,
  });
  const probeCode = (fnProbe.error as { code?: string } | null)?.code;
  if (fnProbe.error && (probeCode === "PGRST202" || /does not exist|schema cache/i.test(fnProbe.error.message))) {
    console.log("⏸  plan RPC not applied yet — apply 20260612200000 then re-run. (held for review)");
    process.exit(0);
  }

  // Snapshot for restore.
  const before = await vmState();
  console.log("vm-050 before:", JSON.stringify(before));

  try {
    console.log("\n— GRANT idempotency (the burn-then-retry discriminator) —");
    await setPlan({ video_plan_status: null, video_plan_allowance_remaining: 0, video_plan_period_end: null, video_plan_last_invoice_id: null, video_plan_stripe_sub_id: null });
    const g1 = await grant("inv_A", FUTURE);
    check("grant(inv_A) granted", g1.data?.granted === true, JSON.stringify(g1.data ?? g1.error));
    const r1 = await reserve(13);
    check("burn 13 from allowance", (r1 as { data?: { plan_used?: number } }).data?.plan_used === 13, JSON.stringify((r1 as { data?: unknown }).data));
    const midState = await vmState();
    check("allowance now 533", Number(midState.video_plan_allowance_remaining) === 533, String(midState.video_plan_allowance_remaining));
    const g1r = await grant("inv_A", FUTURE); // THE RETRY
    const afterRetry = await vmState();
    check("retry grant(inv_A) SKIPPED (allowance still 533, NOT 546)",
      g1r.data?.granted === false && Number(afterRetry.video_plan_allowance_remaining) === 533,
      JSON.stringify({ res: g1r.data, allowance: afterRetry.video_plan_allowance_remaining }));
    await release(r1.id); // clean the pending hold (refunds 13 → 546)

    console.log("\n— STALE-invoice regression + LATE-DUNNING grant (Finding 3's >=) —");
    await setPlan({ video_plan_allowance_remaining: 0, video_plan_last_invoice_id: null, video_plan_period_end: null });
    await grant("inv_B", P2);
    const stale = await grant("inv_OLD", P1); // P1 < P2 → must skip
    const s1 = await vmState();
    check("stale prior-period invoice SKIPPED (period stays P2)",
      stale.data?.granted === false && new Date(s1.video_plan_period_end!).toISOString() === P2,
      JSON.stringify({ res: stale.data, period: s1.video_plan_period_end }));
    const lateDunning = await grant("inv_C", P2); // SAME period, NEW invoice → must grant
    check("late-dunning invoice (== period, new id) GRANTS", lateDunning.data?.granted === true,
      JSON.stringify(lateDunning.data ?? lateDunning.error));

    console.log("\n— PRECEDENCE (F1): allowance before balance —");
    await setPlan({ video_plan_status: "active", video_plan_allowance_remaining: 546, video_plan_period_end: FUTURE });
    const balBefore = Number((await vmState()).video_credit_balance);
    const r2 = await reserve(13);
    const d2 = (r2 as { data?: { plan_used?: number; balance_used?: number } }).data;
    check("plan_used=13, balance_used=0", d2?.plan_used === 13 && d2?.balance_used === 0, JSON.stringify(d2));
    const st2 = await settle(r2.id);
    const balAfter = Number((await vmState()).video_credit_balance);
    check("settle debits balance by 0 (allowance covered it)", balAfter === balBefore,
      `before=${balBefore} after=${balAfter} settle=${JSON.stringify(st2.data)}`);

    console.log("\n— BOUNDARY SPLIT (F3) —");
    await setPlan({ video_plan_allowance_remaining: 5 });
    const r3 = await reserve(13);
    const d3 = (r3 as { data?: { plan_used?: number; balance_used?: number } }).data;
    check("split: plan 5 + balance 8", d3?.plan_used === 5 && d3?.balance_used === 8, JSON.stringify(d3));
    const balB3 = Number((await vmState()).video_credit_balance);
    const st3 = await settle(r3.id);
    const balA3 = Number((await vmState()).video_credit_balance);
    check("settle debits balance by 8 ONLY", balB3 - balA3 === 8,
      `delta=${balB3 - balA3} settle=${JSON.stringify(st3.data)}`);

    console.log("\n— SAME-PERIOD release refund —");
    await setPlan({ video_plan_allowance_remaining: 5, video_plan_period_end: FUTURE });
    const r4 = await reserve(13); // split 5/8
    const rel4 = await release(r4.id);
    const s4 = await vmState();
    check("release refunds plan portion (5 back)", Number(s4.video_plan_allowance_remaining) === 5
      && (rel4.data as { plan_refunded?: number })?.plan_refunded === 5,
      JSON.stringify({ allowance: s4.video_plan_allowance_remaining, rel: rel4.data }));

    console.log("\n— CROSS-PERIOD release (no-rollover cannot be resurrected) —");
    await setPlan({ video_plan_allowance_remaining: 5, video_plan_period_end: FUTURE });
    const r5 = await reserve(13); // split 5/8, hold records FUTURE
    await grant("inv_NEXT", P2, 546); // period rolls → allowance SET 546
    const rel5 = await release(r5.id);
    const s5 = await vmState();
    check("cross-period release does NOT refund (allowance stays 546)",
      Number(s5.video_plan_allowance_remaining) === 546
      && (rel5.data as { plan_refunded?: number })?.plan_refunded === 0,
      JSON.stringify({ allowance: s5.video_plan_allowance_remaining, rel: rel5.data }));

    console.log("\n— FREEZE (F4) + PERIOD-EXPIRED —");
    await setPlan({ video_plan_status: "past_due", video_plan_allowance_remaining: 500, video_plan_period_end: FUTURE });
    const r6 = await reserve(13);
    const d6 = (r6 as { data?: { plan_used?: number } }).data;
    check("past_due → plan_used=0 (balance-only)", d6?.plan_used === 0, JSON.stringify(d6));
    await release(r6.id);
    await setPlan({ video_plan_status: "active", video_plan_period_end: PAST });
    const r7 = await reserve(13);
    const d7 = (r7 as { data?: { plan_used?: number } }).data;
    check("active-but-period-expired → plan_used=0", d7?.plan_used === 0, JSON.stringify(d7));
    await release(r7.id);

    console.log("\n— LEGACY HOLDS byte-identical (the proven pack path) —");
    // (a) A no-plan NEW row: plan inactive → plan_used 0; settle debits full est
    //     — value-identical to this morning's proven chain.
    await setPlan({ video_plan_status: null, video_plan_allowance_remaining: 0, video_plan_period_end: null });
    const balB8 = Number((await vmState()).video_credit_balance);
    const r8 = await reserve(13);
    await settle(r8.id);
    const balA8 = Number((await vmState()).video_credit_balance);
    check("no-plan reserve+settle debits exactly 13 (baseline semantics)", balB8 - balA8 === 13, `delta=${balB8 - balA8}`);
    // (b) A TRUE legacy-shaped row (no split metadata at all — direct insert,
    //     as every pre-migration row is): settle must COALESCE to full est.
    const legacyId = rid();
    await sb.from("instaclaw_video_transactions").insert({
      request_id: legacyId, vm_id: VM, endpoint: T2V, est_credits: 13,
      hf_cost_credits: 13, is_free: false, status: "pending", metadata: { test: TAG },
    });
    const balB9 = Number((await vmState()).video_credit_balance);
    await settle(legacyId);
    const balA9 = Number((await vmState()).video_credit_balance);
    check("legacy row (no split metadata) settle debits full est (13)", balB9 - balA9 === 13, `delta=${balB9 - balA9}`);
    // (c) legacy release refunds nothing plan-side
    const legacyId2 = rid();
    await sb.from("instaclaw_video_transactions").insert({
      request_id: legacyId2, vm_id: VM, endpoint: T2V, est_credits: 13,
      hf_cost_credits: 13, is_free: false, status: "pending", metadata: { test: TAG },
    });
    await setPlan({ video_plan_allowance_remaining: 100, video_plan_status: "active", video_plan_period_end: FUTURE });
    const rel9 = await release(legacyId2);
    const s9 = await vmState();
    check("legacy release: plan_refunded=0, allowance untouched",
      (rel9.data as { plan_refunded?: number })?.plan_refunded === 0
      && Number(s9.video_plan_allowance_remaining) === 100,
      JSON.stringify({ rel: rel9.data, allowance: s9.video_plan_allowance_remaining }));

    console.log("\n— POOL WIPE (Finding 2: the field set zeroes everything) —");
    await setPlan({ video_plan_status: "active", video_plan_allowance_remaining: 321, video_plan_period_end: FUTURE, video_plan_stripe_sub_id: "sub_test", video_plan_last_invoice_id: "inv_X" });
    await sb.from("instaclaw_vms").update({ ...VIDEO_BILLING_WIPE_FIELDS }).eq("id", VM);
    const s10 = await vmState();
    check("wipe zeroes balance + all 5 plan columns",
      Number(s10.video_credit_balance) === 0 && s10.video_plan_status === null
      && Number(s10.video_plan_allowance_remaining) === 0 && s10.video_plan_period_end === null
      && s10.video_plan_stripe_sub_id === null && s10.video_plan_last_invoice_id === null,
      JSON.stringify(s10));
  } finally {
    // RESTORE vm-050 exactly + delete every synthetic row.
    await sb.from("instaclaw_vms").update(before).eq("id", VM);
    await sb.from("instaclaw_video_transactions").delete().eq("vm_id", VM).like("request_id", `${TAG}%`);
    const after = await vmState();
    const restored = JSON.stringify(after) === JSON.stringify(before);
    console.log(`\nrestore: ${restored ? "✅ exact" : "⚠️ DRIFT — compare manually"}`);
    if (!restored) console.log("after:", JSON.stringify(after));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
