/**
 * Cohort assignment CLI for Vendrov's EE26 experiments.
 *
 * Reads partner-tagged users from instaclaw_users, applies the
 * deterministic consistent-hash cohort policy from
 * lib/research-export/cohort-assignment.ts, and writes assignments
 * to research.cohort_assignments.
 *
 * Idempotent: re-runs produce the same assignments. ON CONFLICT DO
 * NOTHING means existing rows (including Vendrov's manual overrides)
 * are preserved.
 *
 * Usage:
 *   npx tsx scripts/_assign-cohorts.ts                       # dry-run
 *   npx tsx scripts/_assign-cohorts.ts --apply                # actually write
 *   npx tsx scripts/_assign-cohorts.ts --partner edge_city    # filter
 *   npx tsx scripts/_assign-cohorts.ts --balance              # show
 *                                                              # cohort
 *                                                              # balance
 *
 * Pre-Edge Esmeralda checklist (per Edge strategy doc May 22 milestone):
 *   1. Run --balance to confirm the assignment is approximately uniform.
 *   2. Pre-register the cohort definitions publicly (docs/...prereg...md).
 *   3. Lock the EE26_EXPERIMENTS list in lib/research-export/cohort-
 *      assignment.ts (no further edits).
 *   4. Run --apply to populate research.cohort_assignments.
 *   5. Verify counts match the balance report.
 *
 * Vendrov can manually override individual assignments at any time
 * (INSERT directly via Supabase Studio); the auto-assigner respects
 * existing rows.
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import {
  EE26_EXPERIMENTS,
  assignCohort,
  computeBalance,
  type CohortAssignment,
} from "../lib/research-export/cohort-assignment";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // env already loaded by runner
  }
}

interface Args {
  apply: boolean;
  partner?: string;
  balance: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { apply: false, balance: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--balance") out.balance = true;
    else if (a === "--partner" && i + 1 < argv.length) out.partner = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log("Usage: npx tsx scripts/_assign-cohorts.ts [--apply] [--partner SLUG] [--balance]");
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return out;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const sb = createClient(url, key);

  // Load partner-tagged users. Wallet lives on the user's VM
  // (instaclaw_vms.bankr_evm_address), not on the user row.
  let userQ = sb
    .from("instaclaw_users")
    .select("id, email, partner")
    .not("partner", "is", null);
  if (args.partner) userQ = userQ.eq("partner", args.partner);

  const { data: userData, error: userErr } = await userQ;
  if (userErr) {
    console.error(`Failed to load users: ${userErr.message}`);
    process.exit(1);
  }
  const partnerUsers = (userData ?? []) as Array<{ id: string; email: string; partner: string }>;
  if (partnerUsers.length === 0) {
    console.log(`No partner-tagged users found${args.partner ? ` (partner=${args.partner})` : ""}.`);
    return;
  }

  // Join through instaclaw_vms for Bankr wallet.
  const { data: vmData, error: vmErr } = await sb
    .from("instaclaw_vms")
    .select("assigned_to, bankr_evm_address")
    .in("assigned_to", partnerUsers.map((u) => u.id))
    .not("bankr_evm_address", "is", null);
  if (vmErr) {
    console.error(`Failed to load VMs: ${vmErr.message}`);
    process.exit(1);
  }
  const walletByUser = new Map<string, string>();
  for (const v of (vmData ?? []) as Array<{ assigned_to: string; bankr_evm_address: string }>) {
    if (!walletByUser.has(v.assigned_to)) walletByUser.set(v.assigned_to, v.bankr_evm_address);
  }

  const users = partnerUsers
    .map((u) => ({ ...u, wallet_address: walletByUser.get(u.id) }))
    .filter((u): u is typeof u & { wallet_address: string } => !!u.wallet_address);
  const usersWithoutWallet = partnerUsers.length - users.length;
  console.log(`Loaded ${users.length} partner-tagged users with Bankr wallets${args.partner ? ` (partner=${args.partner})` : ""}.`);
  if (usersWithoutWallet > 0) {
    console.log(`Skipped ${usersWithoutWallet} partner-tagged users with no Bankr wallet (not yet provisioned).`);
  }

  if (args.balance) {
    const wallets = users.map((u) => u.wallet_address);
    const balance = computeBalance(wallets);
    console.log(`\nCohort balance across ${EE26_EXPERIMENTS.length} experiments:\n`);
    for (const b of balance) {
      const entries = Object.entries(b.cohort_counts)
        .map(([c, n]) => `${c}=${n}`)
        .join("  ");
      const skewMarker = b.max_skew_pct > 20 ? " ⚠" : b.max_skew_pct > 10 ? " ·" : "";
      console.log(`  ${b.experiment_id.padEnd(28)} ${entries.padEnd(50)} skew=${b.max_skew_pct.toFixed(1)}%${skewMarker}`);
    }
    console.log(`\n(skew >20% flagged ⚠. At small N, high skew is expected and self-corrects as the pool grows.)`);
  }

  // Compute all proposed assignments.
  const proposedAssignments: CohortAssignment[] = [];
  for (const user of users) {
    for (const def of EE26_EXPERIMENTS) {
      proposedAssignments.push(assignCohort(user.wallet_address, def));
    }
  }
  console.log(`\nProposed assignments: ${proposedAssignments.length} (${users.length} users × ${EE26_EXPERIMENTS.length} experiments).`);

  // Read existing counts via the public RPC (research schema is not
  // exposed via PostgREST; we use public.cohort_assignment_counts to
  // get aggregate counts without crossing schema boundaries).
  const { data: existingCounts, error: cErr } = await sb.rpc("cohort_assignment_counts");
  if (cErr) {
    console.error(`Failed to read existing counts via RPC: ${cErr.message}`);
    console.error(`Apply migration 20260512_cohort_assignment_rpc.sql first.`);
    process.exit(1);
  }
  const existingTotal = (existingCounts ?? []).reduce(
    (n: number, r: unknown) => n + Number((r as { n: number }).n),
    0,
  );
  console.log(`Existing assignments in research.cohort_assignments: ${existingTotal}`);

  if (!args.apply) {
    console.log(`\nDRY RUN. Re-run with --apply to actually write.`);
    console.log(`\nFirst 5 proposed (will INSERT ON CONFLICT DO NOTHING — manual rows preserved):`);
    for (const a of proposedAssignments.slice(0, 5)) {
      console.log(`  ${a.bankr_wallet.slice(0, 12)}... → ${a.experiment_id.padEnd(28)} → ${a.cohort}`);
    }
    return;
  }

  // Write via the public.assign_cohort RPC. RPC returns true if a new
  // row was inserted, false if the (wallet, experiment) was already
  // present. Both are non-error outcomes — the RPC's ON CONFLICT DO
  // NOTHING handles dedup. Run sequentially to keep the output
  // ordered and the load light (we're talking dozens of calls at
  // village scale).
  let inserted = 0;
  let skipped = 0;
  for (const a of proposedAssignments) {
    const { data: wasInserted, error: wErr } = await sb.rpc("assign_cohort", {
      p_bankr_wallet: a.bankr_wallet,
      p_experiment_id: a.experiment_id,
      p_cohort: a.cohort,
      p_notes: `auto-assigned by _assign-cohorts.ts (audit_hash=${a.audit_hash.slice(0, 12)}, bucket_count=${a.bucket_count})`,
    });
    if (wErr) {
      console.error(`assign_cohort RPC failed for ${a.bankr_wallet.slice(0, 12)}...:${a.experiment_id}: ${wErr.message}`);
      process.exit(1);
    }
    if (wasInserted) inserted++;
    else skipped++;
  }

  console.log(`\n✓ ${inserted} new cohort assignments written via public.assign_cohort RPC.`);
  console.log(`  ${skipped} skipped (row already present — preserves Vendrov's manual overrides).`);

  // Final balance from the RPC.
  const { data: finalCounts } = await sb.rpc("cohort_assignment_counts");
  console.log(`\nFinal cohort balance (per research.cohort_assignments):`);
  type CountRow = { experiment_id: string; cohort: string; n: number };
  const grouped: Record<string, CountRow[]> = {};
  for (const r of (finalCounts ?? []) as CountRow[]) {
    grouped[r.experiment_id] ??= [];
    grouped[r.experiment_id].push(r);
  }
  for (const exp of Object.keys(grouped).sort()) {
    const entries = grouped[exp]
      .map((r) => `${r.cohort}=${r.n}`)
      .join("  ");
    console.log(`  ${exp.padEnd(28)} ${entries}`);
  }
}

run().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
