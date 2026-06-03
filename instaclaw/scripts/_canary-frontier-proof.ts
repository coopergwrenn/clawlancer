#!/usr/bin/env tsx
/**
 * W11 — Frontier canary proof harness (the re-runnable keystone proof).
 *
 * The full Phase-1 scenario the PRD works backwards from is:
 *   gap → rolodex pick → earned-budget gate → real purchase → result used → standing change.
 *
 * Two legs of that are proven OUT OF BAND and not re-exercised here (documented,
 * not skipped):
 *   - REAL PURCHASE (Bankr-signed EIP-3009 → x402 settle on Base): proven live,
 *     tx 0x530cab7e… ($0.001, ETH price returned, settled row, supplier → trusted).
 *     Reproducing it needs a stable test x402 endpoint; the canary feed was a
 *     temporary deploy and is down. Same limitation bankr-signing-health documents.
 *   - ROLODEX PICK (Thompson selection over gbrain supplier records): proven live
 *     this session (seeded trusted/mixed/avoid → "Compared 2", picked the reliable
 *     one 3/3) and unit-covered with .mjs↔.ts parity in _test-frontier-spend-core.
 *
 * What THIS harness proves, reproducibly, against the LIVE authorize API: the
 * earned-budget GATE — the keystone invention (Invention 1). It drives a matrix of
 * amounts across the autonomy bands and asserts each verdict, including the
 * load-bearing safety invariant: a hard per-tx ceiling DENIES even WITH human
 * approval. The run deletes its own scaffolding rows on teardown (by w11-* request_id)
 * so it leaves no standing-inflating residue and no fake failures to pollute the
 * failure-rate that cron/frontier-spend-health watches.
 *
 * Run: npx tsx scripts/_canary-frontier-proof.ts [--vm instaclaw-vm-1075]
 *   exit 0 = every gate assertion held; exit 1 = a verdict was wrong; exit 2 = config.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const f of [`${process.cwd()}/.env.local`, "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* optional */ }
}

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const API_BASE = process.env.INSTACLAW_API_BASE || "https://instaclaw.io";
if (!SB_URL || !SB_KEY) {
  console.error("FATAL: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  process.exit(2);
}
const sb = createClient(SB_URL, SB_KEY);

const vmName = (() => {
  const i = process.argv.indexOf("--vm");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : "instaclaw-vm-1075";
})();

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? `  (${detail})` : ""}`); }
}

interface AuthzResp {
  status: number;
  authorized?: boolean;
  mode?: string | null;
  outcome?: string;
  reason?: string;
  hold_id?: string;
  earned_daily_budget_usd?: number;
  policy_bands?: { neverPerTx: number; neverPerDay: number };
  standing?: { score: number; level: string };
}

async function authorize(token: string, body: Record<string, unknown>): Promise<AuthzResp> {
  const res = await fetch(`${API_BASE}/api/agent-economy/authorize`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, ...(await res.json().catch(() => ({}))) };
}

async function deleteTestRows(vmId: string, stamp: number): Promise<number> {
  // Teardown: remove THIS run's scaffolding rows by their w11-<stamp>-* request_id.
  // We delete rather than settle-failed because a settled-failed hold is a real
  // "pay leg broke" signal — leaving fake failures would pollute the failure-rate
  // the frontier-spend-health cron watches and could false-page. These rows are
  // unambiguously harness-created (request_id prefix), so deleting them is clean
  // test teardown, not destroying real economic history.
  const { data } = await sb
    .from("frontier_transactions")
    .delete()
    .eq("vm_id", vmId)
    .like("request_id", `w11-${stamp}-%`)
    .select("id");
  return data?.length ?? 0;
}

(async () => {
  console.log(`W11 Frontier proof — earned-budget gate matrix on ${vmName} @ ${new Date().toISOString()}`);

  const { data: vm } = await sb
    .from("instaclaw_vms")
    .select("id, gateway_token, tier, bankr_evm_address")
    .eq("name", vmName)
    .maybeSingle();
  if (!vm?.gateway_token) {
    console.error(`FATAL: ${vmName} has no gateway_token (not assigned / not found)`);
    process.exit(2);
  }
  const token = vm.gateway_token as string;
  const vmId = vm.id as string;
  const stamp = Date.now();
  let n = 0;
  const rid = () => `w11-${stamp}-${n++}`;

  // Baseline read — what the gate currently believes (for context in the log).
  const baseRid = rid();
  const base = await authorize(token, { request_id: baseRid, amount_usd: 0.001, endpoint: "https://w11.local/probe", category: "data" });
  const earned = base.earned_daily_budget_usd ?? 0;
  const neverPerTx = base.policy_bands?.neverPerTx ?? 0;
  console.log(`\nbaseline: tier=${vm.tier} earned=$${earned} neverPerTx=$${neverPerTx} score=${base.standing?.score} level=${base.standing?.level}\n`);

  const overTx = Math.max(neverPerTx * 5, 50); // unambiguously over the hard per-tx ceiling
  const overEarnedUnderTx = Math.min(Math.max(earned + 0.25, 0.5), Math.max(neverPerTx - 1, 0.5)); // > earned, < neverPerTx

  // ── The matrix ──
  // 1. micro spend within earned budget → autonomous
  {
    const r = rid();
    const a = await authorize(token, { request_id: r, amount_usd: 0.001, endpoint: "https://w11.local/a", category: "data" });
    check("micro ($0.001) within earned → authorized autonomous", a.authorized === true && a.mode === "autonomous", `${a.outcome}/${a.mode}`);
  }
  // 2. over earned budget, under hard ceiling, no human → ask_first
  {
    const r = rid();
    const a = await authorize(token, { request_id: r, amount_usd: overEarnedUnderTx, endpoint: "https://w11.local/b", category: "data" });
    check(`over-earned ($${overEarnedUnderTx}) no approval → ask_first`, a.authorized === false && a.outcome === "ask_first", `${a.authorized}/${a.outcome}`);
  }
  // 3. over earned budget, under hard ceiling, WITH human approval → authorized
  {
    const r = rid();
    const a = await authorize(token, { request_id: r, amount_usd: overEarnedUnderTx, endpoint: "https://w11.local/c", category: "data", human_approved: true });
    check(`over-earned ($${overEarnedUnderTx}) + human_approved → authorized`, a.authorized === true, `${a.authorized}/${a.outcome}`);
  }
  // 4. over hard per-tx ceiling, no human → deny
  {
    const r = rid();
    const a = await authorize(token, { request_id: r, amount_usd: overTx, endpoint: "https://w11.local/d", category: "data" });
    check(`over-ceiling ($${overTx}) → deny`, a.authorized === false && a.outcome === "deny", `${a.authorized}/${a.outcome}`);
  }
  // 5. THE INVARIANT: over hard per-tx ceiling, WITH human approval → STILL deny
  {
    const r = rid();
    const a = await authorize(token, { request_id: r, amount_usd: overTx, endpoint: "https://w11.local/e", category: "data", human_approved: true });
    check(`over-ceiling ($${overTx}) + human_approved → STILL deny (hard ceiling binds)`, a.authorized === false && a.outcome === "deny", `${a.authorized}/${a.outcome}`);
  }
  // 6. unknown capability category → ask_first
  {
    const r = rid();
    const a = await authorize(token, { request_id: r, amount_usd: 0.001, endpoint: "https://w11.local/f" });
    check("unknown category → ask_first", a.authorized === false && a.outcome === "ask_first", `${a.authorized}/${a.outcome}/${a.reason}`);
  }

  // Teardown — remove this run's scaffolding rows so the failure-rate signal stays clean.
  const removed = await deleteTestRows(vmId, stamp);
  console.log(`\nteardown: removed ${removed} harness row(s).`);

  console.log("Out-of-band legs (documented, not re-run): real x402 pay → tx 0x530cab7e; rolodex pick → live this session + unit parity.");
  console.log(`\n${fail === 0 ? "✓ W11 gate proof PASSED" : "✗ W11 gate proof FAILED"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : String(e));
  process.exit(2);
});
