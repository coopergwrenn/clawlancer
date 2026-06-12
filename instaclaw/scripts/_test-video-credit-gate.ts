#!/usr/bin/env tsx
/**
 * _test-video-credit-gate.ts — safety-contract suite for guardrail #1.
 *
 * Proves the money-gate end-to-end against the LIVE prod reserve/settle/release
 * RPCs, with ZERO Higgsfield spend (no video is ever generated). It exercises
 * the SQL state machine directly using a synthetic throwaway VM row that is
 * created at start and DELETED (cascade) at the end.
 *
 * Two layers:
 *   PART 1 — pure unit tests on lib/higgsfield-models (allowlist, param
 *            validation, cost table, free-cap mapping). No DB, no network.
 *   PART 2/3 — live contract tests on the prod RPCs:
 *            insufficient balance → blocked (no spend);
 *            valid → hold → settle (exact debit) → idempotent;
 *            failed/nsfw → release (no charge);
 *            free allowance → 0 charge; free→paid boundary;
 *            (hardening-gated) settle clamp; free-retry-leak closed;
 *            (hardening-gated) cap fail-closed.
 *
 * The hardening-gated checks AUTO-DETECT whether 20260608230000 is applied:
 *   - applied   → assert the NEW (safe) behavior; green.
 *   - not yet   → report the OLD behavior + a loud WARNING with the fix. The
 *                 suite stays green (these are advisory until Cooper applies).
 *
 * Usage:  npx tsx scripts/_test-video-credit-gate.ts
 * Exit 0 = all hard assertions pass. Exit 1 = a hard assertion failed.
 */
import { readFileSync } from "fs";
import { randomUUID } from "crypto";
import {
  HF_MODELS,
  DEFAULT_MODEL,
  estimateVideoCredits,
  validateInput,
  freeCapForTier,
  utcDayStartISO,
  FRESH_PENDING_TTL_MS,
  mapHiggsfieldStatus,
} from "../lib/higgsfield-models";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
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
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!URL || !KEY) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(2);
}

// ── tiny test harness ──────────────────────────────────────────────────────
let pass = 0,
  fail = 0,
  warn = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}${detail ? `  (${detail})` : ""}`);
  } else {
    fail++;
    fails.push(name);
    console.log(`  ❌ ${name}${detail ? `  (${detail})` : ""}`);
  }
}
function warnAdvisory(name: string, detail = "") {
  warn++;
  console.log(`  ⚠️  ${name}${detail ? `  — ${detail}` : ""}`);
}
function section(t: string) {
  console.log(`\n${t}`);
}

const H = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  "Content-Type": "application/json",
};
async function rpc(name: string, args: Record<string, unknown>) {
  const r = await fetch(`${URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: H,
    body: JSON.stringify(args),
  });
  return r.json();
}
async function dbDelete(path: string) {
  await fetch(`${URL}/rest/v1/${path}`, { method: "DELETE", headers: { ...H, Prefer: "return=minimal" } });
}
async function dbInsert(table: string, row: Record<string, unknown>) {
  await fetch(`${URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
}
async function dbPatch(path: string, body: Record<string, unknown>) {
  await fetch(`${URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
}
async function getBalance(vmId: string): Promise<number> {
  const r = await fetch(`${URL}/rest/v1/instaclaw_vms?id=eq.${vmId}&select=video_credit_balance`, { headers: H });
  const d = (await r.json()) as Array<{ video_credit_balance: string | number }>;
  return Number(d[0]?.video_credit_balance);
}
async function txRow(vmId: string, reqId: string) {
  const r = await fetch(
    `${URL}/rest/v1/instaclaw_video_transactions?vm_id=eq.${vmId}&request_id=eq.${reqId}&select=status,settled_credits,est_credits,is_free`,
    { headers: H },
  );
  const d = (await r.json()) as Array<Record<string, unknown>>;
  return d[0];
}

const TEST_VM = "ffffffff-0000-4000-8000-0000000c0de1";
async function freshVM(balance: number, tier: string | null) {
  await dbDelete(`instaclaw_vms?id=eq.${TEST_VM}`); // cascade clears tx rows
  await dbInsert("instaclaw_vms", { id: TEST_VM, video_credit_balance: balance, tier });
}
function reserveArgs(o: {
  reqId: string;
  endpoint: string;
  est: number;
  hf: number;
  isFree: boolean;
  freeCap: number;
  capDaily: number | null;
}) {
  return {
    p_vm_id: TEST_VM,
    p_request_id: o.reqId,
    p_endpoint: o.endpoint,
    p_est_credits: o.est,
    p_hf_cost_credits: o.hf,
    p_is_free: o.isFree,
    p_free_cap_daily: o.freeCap,
    p_cap_daily: o.capDaily,
    p_window_start: utcDayStartISO(),
    p_fresh_pending_cutoff: new Date(Date.now() - FRESH_PENDING_TTL_MS).toISOString(),
    p_metadata: { test: true },
  };
}

async function main() {
  console.log("════════ video-credit gate — safety-contract suite ════════");

  // ── PART 1: pure unit tests (no DB) ──────────────────────────────────────
  section("PART 1 — model registry / validation / cost (pure)");

  ok("unknown slug is NOT in the allowlist", HF_MODELS["bogus/model"] === undefined);
  ok("default model is dop/lite", DEFAULT_MODEL === "higgsfield-ai/dop/lite" && !!HF_MODELS[DEFAULT_MODEL]);
  ok("seedance is excluded (unmeasured)", HF_MODELS["bytedance/seedance/v1/pro/image-to-video"] === undefined);

  // cost table — must equal the calibration/proof numbers exactly
  ok("estimate image(soul)=2", estimateVideoCredits(HF_MODELS["higgsfield-ai/soul/standard"]) === 2);
  ok("estimate dop/lite=3", estimateVideoCredits(HF_MODELS["higgsfield-ai/dop/lite"]) === 3);
  ok("estimate dop/turbo=8", estimateVideoCredits(HF_MODELS["higgsfield-ai/dop/turbo"]) === 8);
  ok("estimate dop/standard=11", estimateVideoCredits(HF_MODELS["higgsfield-ai/dop/standard"]) === 11);
  ok("estimate kling=18 (re-pinned 15.68→measured 15.0)", estimateVideoCredits(HF_MODELS["kling-video/v2.1/pro/image-to-video"]) === 18);

  const lite = HF_MODELS["higgsfield-ai/dop/lite"];
  const img = HF_MODELS["higgsfield-ai/soul/standard"];
  ok("validate: image2video needs image_url", validateInput(lite, { prompt: "a cat" }).ok === false);
  ok("validate: empty prompt rejected", validateInput(lite, { image_url: "https://x/y.png", prompt: "  " }).ok === false);
  ok("validate: non-url image_url rejected", validateInput(lite, { image_url: "not-a-url", prompt: "hi" }).ok === false);
  ok("validate: duration out of range rejected", validateInput(lite, { image_url: "https://x/y.png", prompt: "hi", duration: 99 }).ok === false);
  const good = validateInput(lite, { image_url: "https://x/y.png", prompt: "  a cat  ", duration: 5 });
  ok("validate: good image2video passes + trims + keeps duration", good.ok === true && good.ok && good.input.prompt === "a cat" && good.input.duration === 5);
  const gimg = validateInput(img, { prompt: "a castle" });
  ok("validate: image needs only prompt", gimg.ok === true && gimg.ok && gimg.input.image_url === undefined);
  const extra = validateInput(lite, { image_url: "https://x/y.png", prompt: "hi", duration: 5 });
  ok("validate: no arbitrary passthrough (only known keys)", extra.ok === true && extra.ok && Object.keys(extra.input).sort().join(",") === "duration,image_url,prompt");

  // Kling duration ENUM (locked to MEASURED 10s) — proves the overcharge path is
  // CLOSED: a 5s request can't be submitted at the 10s price, and any Kling job
  // that IS submitted is the 10s length we actually price.
  const kling = HF_MODELS["kling-video/v2.1/pro/image-to-video"];
  ok("kling allowedDurations locked to [10]", JSON.stringify(kling.allowedDurations) === "[10]");
  ok("kling 5s REJECTED (5s unmeasured → no overcharge path)", validateInput(kling, { image_url: "https://x/y.png", prompt: "hi", duration: 5 }).ok === false);
  ok("kling 7s REJECTED (not in enum → can't coerce-and-bill)", validateInput(kling, { image_url: "https://x/y.png", prompt: "hi", duration: 7 }).ok === false);
  const k10 = validateInput(kling, { image_url: "https://x/y.png", prompt: "hi", duration: 10 });
  ok("kling 10s accepted + duration kept", k10.ok === true && k10.ok && k10.input.duration === 10);
  const kOmit = validateInput(kling, { image_url: "https://x/y.png", prompt: "hi" });
  ok("kling omitted duration PINNED to 10 (the priced length)", kOmit.ok === true && kOmit.ok && kOmit.input.duration === 10);
  ok("dop/lite still accepts generic duration 5 (no enum, flat cost)", validateInput(lite, { image_url: "https://x/y.png", prompt: "hi", duration: 5 }).ok === true);

  // G1 Option B — agent-poll status state machine (the ?action=status contract).
  const mq = mapHiggsfieldStatus({ status: "queued" });
  ok("status queued → not done", mq.done === false && mq.ok === false && mq.video_url === null);
  ok("status in_progress → not done", mapHiggsfieldStatus({ status: "in_progress" }).done === false);
  const mc = mapHiggsfieldStatus({ status: "completed", video: { url: "https://x/y.mp4" } });
  ok("status completed+video → done+ok+url", mc.done === true && mc.ok === true && mc.video_url === "https://x/y.mp4");
  const mi = mapHiggsfieldStatus({ status: "completed", images: [{ url: "https://x/i.png" }] });
  ok("status completed+image (no video) → ok+image url", mi.ok === true && mi.video_url === "https://x/i.png");
  const mnurl = mapHiggsfieldStatus({ status: "completed" });
  ok("status completed+NO url → done but NOT ok", mnurl.done === true && mnurl.ok === false && mnurl.video_url === null);
  ok("status failed → done, not ok, no url", (() => { const m = mapHiggsfieldStatus({ status: "failed" }); return m.done && !m.ok && m.video_url === null; })());
  ok("status nsfw → done, not ok", (() => { const m = mapHiggsfieldStatus({ status: "nsfw" }); return m.done && !m.ok; })());
  ok("status cancelled (legacy) → done, not ok", mapHiggsfieldStatus({ status: "cancelled" }).done === true);
  ok("status missing → unknown, not done", (() => { const m = mapHiggsfieldStatus({}); return m.status === "unknown" && !m.done; })());
  ok("status null input → unknown, not done", (() => { const m = mapHiggsfieldStatus(null); return m.status === "unknown" && !m.done && !m.ok; })());
  // M1 fail-safe: an UNDOCUMENTED terminal status must be `done` (not infinite-poll).
  ok("M1: unknown terminal 'moderated' → done, not ok (fail-safe, not poll-to-timeout)", (() => { const m = mapHiggsfieldStatus({ status: "moderated" }); return m.done === true && m.ok === false && m.video_url === null; })());
  ok("M1: unknown terminal 'error' → done (fail-safe)", mapHiggsfieldStatus({ status: "error" }).done === true);
  ok("M1: only queued/in_progress/unknown stay transient", mapHiggsfieldStatus({ status: "queued" }).done === false && mapHiggsfieldStatus({ status: "in_progress" }).done === false && mapHiggsfieldStatus({ status: "unknown" }).done === false);

  ok("freeCap starter=2", freeCapForTier("starter") === 2);
  ok("freeCap pro=5", freeCapForTier("pro") === 5);
  ok("freeCap power=15", freeCapForTier("power") === 15);
  ok("freeCap premium=15", freeCapForTier("premium") === 15);
  ok("freeCap null→default 2", freeCapForTier(null) === 2);
  ok("freeCap unknown→default 2", freeCapForTier("enterprise") === 2);

  // ── PART 2: detect whether the hardening migration is applied ─────────────
  section("PART 2 — detect hardening migration (20260608230000)");
  await freshVM(1000, "power");
  const detReq = randomUUID();
  const det = await rpc("instaclaw_video_reserve_spend", reserveArgs({ reqId: detReq, endpoint: "higgsfield-ai/dop/lite", est: 1, hf: 2, isFree: false, freeCap: 2, capDaily: null }));
  const HARDENED = det?.reason === "no_cap_provided";
  if (HARDENED) {
    ok("cap fail-closed: NULL paid cap is REJECTED (hardening applied)", det?.reserved === false && det?.reason === "no_cap_provided");
  } else {
    warnAdvisory("cap FAILS OPEN: NULL paid cap was accepted", "apply 20260608230000 — the route always passes a real cap, so prod is safe, but the RPC's defense-in-depth is not yet live");
    if (det?.reserved) await rpc("instaclaw_video_release", { p_vm_id: TEST_VM, p_request_id: detReq, p_reason: "cleanup" });
  }
  console.log(`  → hardening migration applied: ${HARDENED ? "YES" : "NO (advisory checks below)"}`);

  // ── PART 3: live contract scenarios ──────────────────────────────────────
  section("PART 3 — live money-gate contract (zero Higgsfield spend)");

  // A. insufficient balance → blocked, no spend, no row.
  await freshVM(1, "power");
  const aReq = randomUUID();
  const a = await rpc("instaclaw_video_reserve_spend", reserveArgs({ reqId: aReq, endpoint: "kling-video/v2.1/pro/image-to-video", est: 19, hf: 15.68, isFree: false, freeCap: 15, capDaily: 300 }));
  ok("A. insufficient balance → reserved:false", a?.reserved === false && a?.reason === "insufficient_balance");
  ok("A. balance untouched", (await getBalance(TEST_VM)) === 1);
  ok("A. no hold row inserted on denial", (await txRow(TEST_VM, aReq)) === undefined);

  // B. valid → hold → settle (exact debit) → idempotent.
  await freshVM(100, "power");
  const bReq = randomUUID();
  const b = await rpc("instaclaw_video_reserve_spend", reserveArgs({ reqId: bReq, endpoint: "kling-video/v2.1/pro/image-to-video", est: 19, hf: 15.68, isFree: false, freeCap: 15, capDaily: 300 }));
  ok("B. valid reserve → reserved:true, held 19", b?.reserved === true && Number(b?.held) === 19);
  ok("B. balance not yet debited at reserve", (await getBalance(TEST_VM)) === 100);
  const bSettle = await rpc("instaclaw_video_settle", { p_vm_id: TEST_VM, p_request_id: bReq, p_actual_credits: 19, p_metadata: { test: true } });
  ok("B. settle → charged 19, new_balance 81", bSettle?.settled === true && Number(bSettle?.charged) === 19 && Number(bSettle?.new_balance) === 81);
  ok("B. balance debited exactly", (await getBalance(TEST_VM)) === 81);
  const bSettle2 = await rpc("instaclaw_video_settle", { p_vm_id: TEST_VM, p_request_id: bReq, p_actual_credits: 19, p_metadata: {} });
  ok("B. re-settle is idempotent (no double-debit)", bSettle2?.idempotent === true && (await getBalance(TEST_VM)) === 81);

  // C. failed/nsfw → release → no charge.
  const cReq = randomUUID();
  const c = await rpc("instaclaw_video_reserve_spend", reserveArgs({ reqId: cReq, endpoint: "higgsfield-ai/dop/standard", est: 11, hf: 9, isFree: false, freeCap: 15, capDaily: 300 }));
  ok("C. reserve standard → held 11", c?.reserved === true && Number(c?.held) === 11);
  const cRel = await rpc("instaclaw_video_release", { p_vm_id: TEST_VM, p_request_id: cReq, p_reason: "nsfw" });
  ok("C. release → released:true", cRel?.released === true);
  ok("C. balance unchanged by release (81)", (await getBalance(TEST_VM)) === 81);
  const cRow = await txRow(TEST_VM, cReq);
  ok("C. row failed + settled_credits 0", cRow?.status === "failed" && Number(cRow?.settled_credits) === 0);
  const cSettleAfter = await rpc("instaclaw_video_settle", { p_vm_id: TEST_VM, p_request_id: cReq, p_actual_credits: 11, p_metadata: {} });
  ok("C. settle-after-release can't charge (idempotent)", cSettleAfter?.settled !== true && (await getBalance(TEST_VM)) === 81);

  // D. free path → 0 charge, never debits.
  await freshVM(0, "starter"); // free cap 2, no paid balance
  const dReq = randomUUID();
  const d = await rpc("instaclaw_video_reserve_spend", reserveArgs({ reqId: dReq, endpoint: "higgsfield-ai/dop/lite", est: 3, hf: 2, isFree: true, freeCap: 2, capDaily: 300 }));
  ok("D. free reserve → reserved:true, free:true", d?.reserved === true && d?.free === true);
  const dSettle = await rpc("instaclaw_video_settle", { p_vm_id: TEST_VM, p_request_id: dReq, p_actual_credits: 3, p_metadata: {} });
  ok("D. free settle → was_free, charged 0", dSettle?.settled === true && dSettle?.was_free === true && Number(dSettle?.charged) === 0);
  ok("D. free never debits (balance 0)", (await getBalance(TEST_VM)) === 0);

  // E. free→paid boundary: exhaust free, then paid is blocked by 0 balance.
  const e2 = await rpc("instaclaw_video_reserve_spend", reserveArgs({ reqId: randomUUID(), endpoint: "higgsfield-ai/dop/lite", est: 3, hf: 2, isFree: true, freeCap: 2, capDaily: 300 }));
  ok("E. 2nd free within cap → reserved", e2?.reserved === true); // free_used now 2
  const eReqC = randomUUID();
  const e3 = await rpc("instaclaw_video_reserve_spend", reserveArgs({ reqId: eReqC, endpoint: "higgsfield-ai/dop/lite", est: 3, hf: 2, isFree: true, freeCap: 2, capDaily: 300 }));
  ok("E. 3rd free → free_exhausted", e3?.reserved === false && e3?.reason === "free_exhausted");
  const e3paid = await rpc("instaclaw_video_reserve_spend", reserveArgs({ reqId: eReqC, endpoint: "higgsfield-ai/dop/lite", est: 3, hf: 2, isFree: false, freeCap: 2, capDaily: 300 }));
  ok("E. fall-through paid (same id) → insufficient_balance (bal 0)", e3paid?.reserved === false && e3paid?.reason === "insufficient_balance");

  // F. (hardening-gated) settle clamp: charge never exceeds the hold.
  await freshVM(100, "power");
  const fReq = randomUUID();
  await rpc("instaclaw_video_reserve_spend", reserveArgs({ reqId: fReq, endpoint: "higgsfield-ai/dop/lite", est: 3, hf: 2, isFree: false, freeCap: 2, capDaily: 300 }));
  const fSettle = await rpc("instaclaw_video_settle", { p_vm_id: TEST_VM, p_request_id: fReq, p_actual_credits: 999, p_metadata: {} });
  const fBal = await getBalance(TEST_VM);
  if (HARDENED) {
    ok("F. settle clamps charge to held 3 (hold is hard ceiling)", Number(fSettle?.charged) === 3 && fBal === 97);
  } else {
    warnAdvisory("F. settle does NOT clamp pre-hardening", `charged=${fSettle?.charged}, balance=${fBal} — apply 20260608230000 to make the hold a hard ceiling`);
  }

  // G. (hardening-gated) free-retry leak: failed free jobs consume a slot.
  await freshVM(0, "starter"); // free cap 2
  const gA = randomUUID();
  await rpc("instaclaw_video_reserve_spend", reserveArgs({ reqId: gA, endpoint: "higgsfield-ai/dop/lite", est: 3, hf: 2, isFree: true, freeCap: 2, capDaily: 300 }));
  await rpc("instaclaw_video_release", { p_vm_id: TEST_VM, p_request_id: gA, p_reason: "nsfw" });
  const gB = randomUUID();
  await rpc("instaclaw_video_reserve_spend", reserveArgs({ reqId: gB, endpoint: "higgsfield-ai/dop/lite", est: 3, hf: 2, isFree: true, freeCap: 2, capDaily: 300 }));
  await rpc("instaclaw_video_release", { p_vm_id: TEST_VM, p_request_id: gB, p_reason: "nsfw" });
  const gC = await rpc("instaclaw_video_reserve_spend", reserveArgs({ reqId: randomUUID(), endpoint: "higgsfield-ai/dop/lite", est: 3, hf: 2, isFree: true, freeCap: 2, capDaily: 300 }));
  if (HARDENED) {
    ok("G. 2 failed free attempts consume slots → 3rd free exhausted", gC?.reserved === false && gC?.reason === "free_exhausted");
  } else {
    warnAdvisory("G. free-retry LEAK present pre-hardening", `3rd free after 2 failed = reserved:${gC?.reserved} — apply 20260608230000 to count attempts`);
  }
}

main()
  .catch((e) => {
    console.error("\nFATAL:", e);
    fail++;
    fails.push("fatal:" + (e instanceof Error ? e.message : String(e)));
  })
  .finally(async () => {
    // teardown — delete the synthetic VM (cascades its tx rows).
    await dbDelete(`instaclaw_vms?id=eq.${TEST_VM}`);
    console.log(`\n════════ ${pass} passed, ${fail} failed, ${warn} advisory ════════`);
    if (fail) console.log("FAILURES: " + fails.join(" | "));
    process.exit(fail ? 1 : 0);
  });
