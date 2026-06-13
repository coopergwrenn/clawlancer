/**
 * vm-freeze — freeze-v2 Phase 3 (PRD §15.6).
 *
 * The actual freeze flow. ~15 lines of freeze logic, wrapped in safety
 * checks + observability. Replaces the old Linode-image-based freezeVM()
 * from lib/vm-freeze-thaw.ts (kept around for reference, no longer called
 * by this cron).
 *
 * Schedule: NOT yet in vercel.json. Two-stage rollout:
 *   Stage 1: when gbrain ships `snapshot_brain` MCP tool, wire up the
 *            archive cron (already-written stub in vm-archive-snapshot/).
 *            Watch archives accumulate. Confirm freeze_state = 'archived'
 *            is reached for ≥3 VMs.
 *   Stage 2: only THEN add the freeze cron to vercel.json. This cron's
 *            candidate query filters to `freeze_state = 'archived'` — so
 *            even if accidentally triggered with no archives, it's a no-op.
 *            But explicit gating via vercel.json keeps the order
 *            unambiguous.
 *
 * Flow per VM (PRD §15.6 transcribed):
 *   1. Acquire freeze-thaw:<vm-id> lock.
 *   2. Re-read VM row inside lock. Confirm freeze_state still 'archived'.
 *      Live Stripe + credits + bankr re-checks (defense in depth — the
 *      archive was minutes/hours ago; user state may have changed).
 *   3. Conditional UPDATE → freeze_state='destroying' (CAS pattern).
 *      If 0 rows match, another op flipped state; abort cleanly.
 *   4. Linode DELETE the instance.
 *      - On Linode failure: undo state to 'archived' so next tick retries.
 *      - No instance to recover, so no Rule 52 boot-recovery dance.
 *   5. Terminal DB UPDATE: status='frozen', freeze_state='frozen',
 *      provider_server_id=null, ip_address=null, frozen_at=now().
 *      - On DB failure AFTER Linode delete: REVERSE ZOMBIE state
 *        (instance gone, DB says 'destroying'). Send P0 admin alert;
 *        operator handles by completing the DB write manually.
 *   6. Release lock.
 *
 * No SSH. No cleanup. No disk-cap gate. No retry-with-backoff for boot.
 * Rules 51 and 52 are moot for freeze-v2 — the failure modes they guarded
 * (in-flight imagize → zombie) don't exist in this design.
 *
 * Authorization: Bearer CRON_SECRET. Standard Vercel cron pattern.
 *
 * See:
 *   - PRD §15.6 (canonical design)
 *   - PRD §15.8 (failure modes — revised matrix)
 *   - CLAUDE.md "Freeze pipeline — ARCHITECTURE PIVOT 2026-05-16"
 */

import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { classifyFreezeBilling } from "@/lib/billing-status";
import { getStripe } from "@/lib/stripe";
import { sendAdminAlertEmail } from "@/lib/email";
import { deleteVMDNSRecord } from "@/lib/godaddy";
import { randomUUID } from "node:crypto";

export const dynamic = "force-dynamic";
// Per VM: lock-acquire (~50ms) + 1 DB read + 3 safety checks (~500ms each) +
// 1 CAS UPDATE + 1 Linode DELETE (~3s) + 1 terminal UPDATE ≈ 5-7s.
// MAX_FREEZE_PER_RUN=5 → ~35s worst case + cron overhead. 120s is generous.
export const maxDuration = 120;

// ─── Tunables ────────────────────────────────────────────────────────────

/** Per-cron-run cap on freeze operations. Conservative; Linode API has no
 *  per-account rate limit on instance DELETE so we could go higher, but 5
 *  matches the archive cron pace (deferred — see PRD §15.6 staging note). */
const MAX_FREEZE_PER_RUN = 5;

/** Outer cron-level lock TTL. */
const CRON_LOCK_TTL_SECONDS = 10 * 60;

/** Per-VM lock TTL. */
const PER_VM_LOCK_TTL_SECONDS = 10 * 60;

/** Archive must be fresher than this to be eligible for freeze. PRD §15.6
 *  precondition: prevents freezing on a stale archive (the user may have
 *  written more data since the archive was taken; better to re-archive
 *  first via the archive cron). */
const ARCHIVE_MAX_AGE_HOURS = 48;

/** Suspended-state grace before freeze eligibility. */
const FREEZE_GRACE_SUSPENDED_DAYS = 3;

/** Hibernating-state grace before freeze eligibility (per Rule 15). */
const FREEZE_GRACE_HIBERNATING_DAYS = 90;

// ─── Types ───────────────────────────────────────────────────────────────

interface FreezeCandidate {
  id: string;
  name: string | null;
  ip_address: string;
  provider_server_id: string | null;
  assigned_to: string | null;
  health_status: string | null;
  status: string | null;
  freeze_state: string | null;
  suspended_at: string | null;
  credit_balance: number | null;
  bankr_token_address: string | null;
  frozen_archive_path: string | null;
  frozen_archive_taken_at: string | null;
}

interface FreezeOneResult {
  vm_id: string;
  vm_name: string | null;
  outcome:
    | "frozen"
    | "skipped_lock"
    | "row_gone"
    | "state_changed"
    | "archive_stale"
    | "live_sub"
    | "has_credits"
    | "billing_unverifiable"
    | "bankr_token"
    | "cas_failed"
    | "no_provider_id"
    | "linode_delete_failed"
    | "db_terminal_failed"
    | "error";
  detail: string;
  duration_ms?: number;
}

interface RunSummary {
  run_id: string;
  attempted: number;
  frozen: number;
  skipped: number;
  failed: number;
  duration_ms: number;
  results: FreezeOneResult[];
  note?: string;
}

// ─── Route handler ───────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const runId = randomUUID();
  const tStart = Date.now();
  const supabase = getSupabase();
  // SoT billing gate (Rule 14 + Rule 82) — verify against Stripe before destroy.
  const stripe = getStripe();

  const cronLock = await tryAcquireCronLock("vm-freeze", CRON_LOCK_TTL_SECONDS, "vercel-cron");
  if (!cronLock) {
    return NextResponse.json({
      run_id: runId,
      attempted: 0,
      frozen: 0,
      skipped: 0,
      failed: 0,
      duration_ms: 0,
      results: [],
      note: "outer cron lock busy",
    } satisfies RunSummary);
  }

  const summary: RunSummary = {
    run_id: runId,
    attempted: 0,
    frozen: 0,
    skipped: 0,
    failed: 0,
    duration_ms: 0,
    results: [],
  };

  try {
    // ── Stuck-state recovery pass: rows left at 'destroying' ──
    //
    // If a previous cron tick crashed AFTER the CAS to 'destroying' but
    // BEFORE the terminal DB write to 'frozen', the row is stuck in
    // 'destroying'. The normal candidate query (freeze_state='archived')
    // won't pick it up. Worse: the reverse-zombie alert only fires if
    // the function reaches the if(termErr) branch — a Vercel function
    // hard-kill (OOM, timeout) skips that path entirely.
    //
    // Recovery: query rows at 'destroying' older than the lock TTL (10
    // min). For each, probe Linode for the instance. If 404 → instance
    // is gone (Linode delete succeeded); complete the terminal DB write.
    // If exists → freeze was aborted before delete; revert to 'archived'
    // so the normal flow retries.
    //
    // Probing Linode is the load-bearing safety check — without it, we'd
    // either (a) skip rows that should be finished, leaving permanent
    // zombies, or (b) revert rows whose instance is already gone,
    // making the DB-row→Linode pointer permanently lying.
    const stuckCutoff = new Date(
      Date.now() - PER_VM_LOCK_TTL_SECONDS * 1000,
    ).toISOString();
    const { data: stuckRows } = await supabase
      .from("instaclaw_vms")
      .select(
        "id, name, provider_server_id, frozen_archive_path, frozen_at",
      )
      .eq("freeze_state", "destroying")
      .lt("updated_at", stuckCutoff)
      .limit(5);

    for (const row of stuckRows ?? []) {
      const recovered = await recoverStuckDestroying(supabase, row, runId);
      summary.results.push(recovered);
      if (recovered.outcome === "frozen") summary.frozen++;
      else if (recovered.outcome === "error" || recovered.outcome === "linode_delete_failed" || recovered.outcome === "db_terminal_failed") {
        summary.failed++;
      } else {
        summary.skipped++;
      }
    }

    // ── Candidate query ──
    //
    // Eligible: freeze_state='archived', archive fresh (≤48h old),
    // past grace period, provider_server_id set.
    //
    // Health-state-specific grace: suspended → 3d, hibernating → 90d.
    // PostgREST can't express compound (X AND grace_X) OR (Y AND grace_Y)
    // cleanly without nested OR. Simpler: filter at the broader gate (≥3d
    // suspended_at, which catches all eligible suspended AND any
    // hibernating ≥3d, including ones that are NOT yet 90d) and re-check
    // per-state in code.
    const archiveCutoff = new Date(
      Date.now() - ARCHIVE_MAX_AGE_HOURS * 60 * 60 * 1000,
    ).toISOString();
    const minGraceCutoff = new Date(
      Date.now() - FREEZE_GRACE_SUSPENDED_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data: candidates, error: queryErr } = await supabase
      .from("instaclaw_vms")
      .select(
        "id, name, ip_address, provider_server_id, assigned_to, health_status, status, freeze_state, suspended_at, credit_balance, bankr_token_address, frozen_archive_path, frozen_archive_taken_at",
      )
      .eq("freeze_state", "archived")
      .gte("frozen_archive_taken_at", archiveCutoff)
      .not("provider_server_id", "is", null)
      .not("frozen_archive_path", "is", null)
      .in("health_status", ["suspended", "hibernating"])
      .lt("suspended_at", minGraceCutoff)
      .order("frozen_archive_taken_at", { ascending: true })
      .limit(MAX_FREEZE_PER_RUN * 3); // grab extra; some may be filtered by per-state grace

    if (queryErr) {
      logger.error("vm-freeze: candidate query failed", {
        runId,
        error: queryErr.message,
      });
      throw queryErr;
    }

    logger.info("vm-freeze: candidates", {
      runId,
      count: candidates?.length ?? 0,
      max_per_run: MAX_FREEZE_PER_RUN,
    });

    // ── Process ──
    let processed = 0;
    for (const vm of (candidates ?? []) as FreezeCandidate[]) {
      if (processed >= MAX_FREEZE_PER_RUN) break;

      // Per-state grace re-check (DB filter only covered the 3d minimum).
      const suspendedAt = new Date(vm.suspended_at ?? Date.now());
      const daysSince = (Date.now() - suspendedAt.getTime()) / (24 * 60 * 60 * 1000);
      const requiredGrace =
        vm.health_status === "hibernating"
          ? FREEZE_GRACE_HIBERNATING_DAYS
          : FREEZE_GRACE_SUSPENDED_DAYS;
      if (daysSince < requiredGrace) {
        // Don't count against attempted — this is a SQL-filter-coarser-than-
        // policy artifact, not a real attempt.
        continue;
      }

      summary.attempted++;
      const tVm = Date.now();
      const result = await freezeOne(supabase, stripe, vm, runId);
      result.duration_ms = Date.now() - tVm;
      summary.results.push(result);

      if (result.outcome === "frozen") {
        summary.frozen++;
        processed++;
      } else if (result.outcome === "billing_unverifiable") {
        // SoT billing read could not be Stripe-verified (outage on a sub-bearing
        // user). Halt the WHOLE pass this tick — a Stripe outage must never cause
        // a freeze spree on possibly-paying customers (Lesson 2). Next tick retries.
        summary.skipped++;
        logger.error("vm-freeze: billing UNVERIFIABLE — skipping ALL candidates this tick", {
          route: "cron/vm-freeze", runId, vmId: vm.id, vmName: vm.name, detail: result.detail,
        });
        sendAdminAlertEmail(
          "Freeze-v2 pass halted — billing unverifiable (Stripe outage?)",
          `vm-freeze skipped ALL candidates this tick: SoT billing not Stripe-verified for ${vm.name ?? vm.id}.\n${result.detail}\nRun ID: ${runId}\n\nFail-closed (Lesson 2) — nothing destroyed.`,
        ).catch(() => {});
        break;
      } else if (
        result.outcome === "skipped_lock" ||
        result.outcome === "state_changed" ||
        result.outcome === "live_sub" ||
        result.outcome === "has_credits" ||
        result.outcome === "bankr_token" ||
        result.outcome === "archive_stale" ||
        result.outcome === "row_gone"
      ) {
        summary.skipped++;
      } else {
        summary.failed++;
        // Failed attempts count toward per-run cap — back off if structurally broken.
        processed++;
      }
    }

    summary.duration_ms = Date.now() - tStart;
    logger.info("vm-freeze: run complete", { runId, ...summary });
    return NextResponse.json(summary);
  } catch (err) {
    summary.duration_ms = Date.now() - tStart;
    logger.error("vm-freeze: run threw", {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ...summary, fatal: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  } finally {
    await releaseCronLock("vm-freeze");
  }
}

// ─── Per-VM freeze flow (the ~15-line PRD §15.6 core) ────────────────────

async function freezeOne(
  supabase: ReturnType<typeof getSupabase>,
  stripe: ReturnType<typeof getStripe>,
  vm: FreezeCandidate,
  runId: string,
): Promise<FreezeOneResult> {
  const base: Pick<FreezeOneResult, "vm_id" | "vm_name"> = {
    vm_id: vm.id,
    vm_name: vm.name,
  };
  const lockKey = `freeze-thaw:${vm.id}`;

  // 1. Lock.
  const acquired = await tryAcquireCronLock(
    lockKey,
    PER_VM_LOCK_TTL_SECONDS,
    `vm-freeze/${runId}`,
  );
  if (!acquired) {
    return { ...base, outcome: "skipped_lock", detail: `${lockKey} busy` };
  }

  try {
    // 2. Re-read row inside lock + safety re-checks.
    const { data: fresh, error: readErr } = await supabase
      .from("instaclaw_vms")
      .select(
        "id, name, freeze_state, assigned_to, credit_balance, bankr_token_address, provider_server_id, frozen_archive_path, frozen_archive_taken_at",
      )
      .eq("id", vm.id)
      .single();

    if (readErr || !fresh) {
      return { ...base, outcome: "row_gone", detail: readErr?.message ?? "no row" };
    }
    if (fresh.freeze_state !== "archived") {
      return {
        ...base,
        outcome: "state_changed",
        detail: `freeze_state is '${fresh.freeze_state}'; aborting`,
      };
    }
    if (!fresh.provider_server_id) {
      return {
        ...base,
        outcome: "no_provider_id",
        detail: "provider_server_id cleared between query and lock; row is already frozen?",
      };
    }
    // Archive freshness re-check (the SQL filter checked it but state could
    // have changed between query and now).
    const archAge = Date.now() - new Date(fresh.frozen_archive_taken_at ?? 0).getTime();
    if (archAge > ARCHIVE_MAX_AGE_HOURS * 60 * 60 * 1000) {
      return {
        ...base,
        outcome: "archive_stale",
        detail: `archive ${Math.floor(archAge / (60 * 60 * 1000))}h old; archive cron will re-snapshot`,
      };
    }
    // SoT billing re-check (Rule 14 + Rule 82 + PRD §15.6 step 2). Replaces the
    // prior reinvented active/trialing + credits checks with the single SoT
    // primitive, which also covers partner / past_due-grace / all-inclusive and
    // verifies against Stripe ground truth before this destructive op (Lesson 2).
    //   - "paying":       user resubscribed / still pays → skip (live_sub).
    //   - "unverifiable": Stripe unreachable on a sub-bearing user → skip ALL this
    //                     tick (the loop halts on this outcome); never destroy on
    //                     an untrustworthy non-paying signal.
    const billingVerdict = await classifyFreezeBilling(supabase, stripe, fresh.id);
    if (billingVerdict === "paying") {
      return { ...base, outcome: "live_sub", detail: "owner isPaying per SoT (Rule 14) since archive" };
    }
    if (billingVerdict === "unverifiable") {
      return { ...base, outcome: "billing_unverifiable", detail: "SoT billing not Stripe-verified — skip ALL this tick (Lesson 2)" };
    }
    if (fresh.bankr_token_address) {
      return {
        ...base,
        outcome: "bankr_token",
        detail: `active bankr_token=${fresh.bankr_token_address.slice(0, 10)}...`,
      };
    }

    // 3. Conditional UPDATE → 'destroying'. CAS pattern — only update if
    //    state is STILL 'archived' (could have raced with thaw webhook).
    {
      const { data: updated, error: casErr } = await supabase
        .from("instaclaw_vms")
        .update({ freeze_state: "destroying" })
        .eq("id", fresh.id)
        .eq("freeze_state", "archived")
        .select("id");
      if (casErr) {
        return {
          ...base,
          outcome: "cas_failed",
          detail: `CAS UPDATE errored: ${casErr.message}`,
        };
      }
      if (!updated || updated.length === 0) {
        // Another op flipped state between re-read and now. Abort cleanly.
        return {
          ...base,
          outcome: "cas_failed",
          detail: "CAS UPDATE matched 0 rows — state flipped concurrently",
        };
      }
    }

    // 4. Linode DELETE. No SSH. No graceful shutdown. The instance is going.
    try {
      await linodeDeleteInstance(fresh.provider_server_id);
    } catch (err) {
      // Linode delete failed — UNDO state back to 'archived' so next cron
      // tick retries cleanly. The archive is still in R2; nothing lost.
      const undoErr = await supabase
        .from("instaclaw_vms")
        .update({ freeze_state: "archived" })
        .eq("id", fresh.id);
      logger.warn("vm-freeze: Linode DELETE failed; reverted freeze_state", {
        runId,
        vmId: fresh.id,
        linode_id: fresh.provider_server_id,
        error: err instanceof Error ? err.message : String(err),
        undo_error: undoErr.error?.message,
      });
      return {
        ...base,
        outcome: "linode_delete_failed",
        detail: `Linode DELETE: ${String(err).slice(0, 200)} (state reverted to 'archived')`,
      };
    }

    // 5. Terminal DB write. status='frozen', clear instance pointers, mark frozen_at.
    //    This is the load-bearing write — if it fails AFTER the Linode delete,
    //    we have a "reverse zombie" (instance gone, DB still says 'destroying').
    //    Alert P0 so an operator can fix the DB row manually.
    const nowIso = new Date().toISOString();
    const { error: termErr } = await supabase
      .from("instaclaw_vms")
      .update({
        status: "frozen",
        health_status: "frozen",
        freeze_state: "frozen",
        provider_server_id: null,
        ip_address: null,
        frozen_at: nowIso,
      })
      .eq("id", fresh.id)
      .eq("freeze_state", "destroying"); // CAS on terminal too

    if (termErr) {
      // Reverse zombie. Alert + return.
      logger.error("vm-freeze: terminal DB write FAILED AFTER Linode delete — REVERSE ZOMBIE", {
        runId,
        vmId: fresh.id,
        archive_path: fresh.frozen_archive_path,
        error: termErr.message,
      });
      try {
        await sendAdminAlertEmail(
          `[P0] vm-freeze: reverse zombie on ${fresh.name ?? fresh.id}`,
          `Linode instance ${fresh.provider_server_id} was DELETED successfully but the terminal DB write failed.\n\n` +
            `DB now in inconsistent state: freeze_state='destroying' but instance is gone.\n` +
            `Archive is safe at: ${fresh.frozen_archive_path}\n` +
            `\n` +
            `Manual fix:\n` +
            `  UPDATE instaclaw_vms\n` +
            `  SET status='frozen', health_status='frozen', freeze_state='frozen',\n` +
            `      provider_server_id=null, ip_address=null, frozen_at='${nowIso}'\n` +
            `  WHERE id='${fresh.id}' AND freeze_state='destroying';\n` +
            `\n` +
            `Run ID: ${runId}\n` +
            `Underlying error: ${termErr.message}\n`,
        );
      } catch (alertErr) {
        logger.error("vm-freeze: admin alert send failed", {
          runId,
          vmId: fresh.id,
          error: alertErr instanceof Error ? alertErr.message : String(alertErr),
        });
      }
      return {
        ...base,
        outcome: "db_terminal_failed",
        detail: `Linode deleted but DB terminal write failed: ${termErr.message}; P0 alert sent`,
      };
    }

    // Instance deleted + DB terminal write committed → the <vm.id>.vm DNS
    // record is now stale. Clean it up so the zone doesn't refill to its
    // cap. Best-effort; never throws. Re-created on thaw via configureOpenClaw.
    await deleteVMDNSRecord(fresh.id);

    // Lifecycle log — operator visibility.
    await logLifecycle(supabase, fresh, "frozen", `archive=${fresh.frozen_archive_path}`, runId);

    return {
      ...base,
      outcome: "frozen",
      detail: `Linode ${vm.provider_server_id} deleted; archive preserved at ${fresh.frozen_archive_path}`,
    };
  } finally {
    await releaseCronLock(lockKey);
  }
}

// ─── Linode DELETE helper ────────────────────────────────────────────────

async function linodeDeleteInstance(instanceId: string): Promise<void> {
  const res = await fetch(`https://api.linode.com/v4/linode/instances/${instanceId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${process.env.LINODE_API_TOKEN}`,
      "Content-Type": "application/json",
    },
  });
  // Linode returns 200 on success (returns {} body). 204 also acceptable per
  // their API conventions. 404 means instance is ALREADY gone — for the
  // freeze path that's actually success (idempotent).
  if (res.ok || res.status === 204 || res.status === 404) {
    return;
  }
  const body = await res.text().catch(() => "");
  throw new Error(
    `Linode DELETE /linode/instances/${instanceId} → HTTP ${res.status}: ${body.slice(0, 200)}`,
  );
}

// ─── Stuck-'destroying' recovery ─────────────────────────────────────────

/**
 * Recover a row left at freeze_state='destroying'. Cause: a previous cron
 * tick crashed between the CAS-to-destroying and the terminal write.
 * Recovery: probe Linode for the instance.
 *   - 404 → Linode deleted; complete the terminal DB write (mark frozen).
 *   - exists → DELETE never fired; revert to 'archived' so normal flow retries.
 *   - error → log + leave row alone; next cron tick retries.
 *
 * The per-VM lock is acquired first to prevent racing with another freeze
 * cron tick that might be in flight (though unlikely — that's exactly the
 * scenario we're recovering from).
 */
async function recoverStuckDestroying(
  supabase: ReturnType<typeof getSupabase>,
  row: { id: string; name: string | null; provider_server_id: string | null; frozen_archive_path: string | null; frozen_at: string | null },
  runId: string,
): Promise<FreezeOneResult> {
  const base: Pick<FreezeOneResult, "vm_id" | "vm_name"> = {
    vm_id: row.id,
    vm_name: row.name,
  };
  const lockKey = `freeze-thaw:${row.id}`;
  const acquired = await tryAcquireCronLock(
    lockKey,
    PER_VM_LOCK_TTL_SECONDS,
    `vm-freeze-recovery/${runId}`,
  );
  if (!acquired) {
    return { ...base, outcome: "skipped_lock", detail: "another op holds the lock" };
  }

  try {
    // Re-read inside lock — state may have advanced since the stuck-row query.
    const { data: fresh } = await supabase
      .from("instaclaw_vms")
      .select("freeze_state, provider_server_id, frozen_archive_path")
      .eq("id", row.id)
      .single();
    if (!fresh || fresh.freeze_state !== "destroying") {
      return { ...base, outcome: "state_changed", detail: `state is now '${fresh?.freeze_state ?? "<missing>"}'` };
    }
    if (!fresh.provider_server_id) {
      // Already cleared — terminal write half-completed; finish it.
      // (Unlikely but handle for completeness.)
      const { error: termErr } = await supabase
        .from("instaclaw_vms")
        .update({
          status: "frozen",
          health_status: "frozen",
          freeze_state: "frozen",
          frozen_at: row.frozen_at ?? new Date().toISOString(),
        })
        .eq("id", row.id)
        .eq("freeze_state", "destroying");
      if (termErr) {
        return { ...base, outcome: "db_terminal_failed", detail: `recovery terminal write: ${termErr.message}` };
      }
      return { ...base, outcome: "frozen", detail: "recovery: provider_server_id was null; completed terminal write" };
    }

    // Probe Linode. 404 = instance gone (DELETE succeeded). 2xx = still there.
    let linodeAlive: boolean;
    try {
      const res = await fetch(
        `https://api.linode.com/v4/linode/instances/${fresh.provider_server_id}`,
        { headers: { Authorization: `Bearer ${process.env.LINODE_API_TOKEN}` } },
      );
      if (res.status === 404) {
        linodeAlive = false;
      } else if (res.ok) {
        linodeAlive = true;
      } else {
        // Transient Linode error. Leave row alone; next cron retries.
        return {
          ...base,
          outcome: "error",
          detail: `recovery: Linode probe HTTP ${res.status}; will retry next cron`,
        };
      }
    } catch (err) {
      return {
        ...base,
        outcome: "error",
        detail: `recovery: Linode probe threw: ${String(err).slice(0, 150)}`,
      };
    }

    if (linodeAlive) {
      // Linode still exists → DELETE never fired. Revert state to 'archived'
      // so the normal freeze flow retries cleanly.
      const { error: revErr } = await supabase
        .from("instaclaw_vms")
        .update({ freeze_state: "archived" })
        .eq("id", row.id)
        .eq("freeze_state", "destroying");
      if (revErr) {
        return { ...base, outcome: "error", detail: `recovery revert UPDATE failed: ${revErr.message}` };
      }
      logger.info("vm-freeze: stuck-destroying recovered (reverted to archived)", {
        runId,
        vmId: row.id,
        linodeId: fresh.provider_server_id,
      });
      return { ...base, outcome: "state_changed", detail: "recovery: Linode alive; reverted to 'archived'" };
    }

    // Linode 404 → instance is gone. Complete the terminal DB write.
    const nowIso = new Date().toISOString();
    const { error: termErr } = await supabase
      .from("instaclaw_vms")
      .update({
        status: "frozen",
        health_status: "frozen",
        freeze_state: "frozen",
        provider_server_id: null,
        ip_address: null,
        frozen_at: row.frozen_at ?? nowIso,
      })
      .eq("id", row.id)
      .eq("freeze_state", "destroying");
    if (termErr) {
      return { ...base, outcome: "db_terminal_failed", detail: `recovery terminal write failed: ${termErr.message}` };
    }
    logger.info("vm-freeze: stuck-destroying recovered (completed to frozen)", {
      runId,
      vmId: row.id,
      archivePath: fresh.frozen_archive_path,
    });
    await logLifecycle(
      supabase,
      { id: row.id, name: row.name },
      "frozen",
      `RECOVERY from stuck-destroying: Linode 404 confirmed instance gone; archive=${fresh.frozen_archive_path}`,
      runId,
    );
    return {
      ...base,
      outcome: "frozen",
      detail: "recovery: Linode 404; completed terminal write",
    };
  } finally {
    await releaseCronLock(lockKey);
  }
}

// ─── Lifecycle log ───────────────────────────────────────────────────────

async function logLifecycle(
  supabase: ReturnType<typeof getSupabase>,
  vm: { id: string; name: string | null },
  action: string,
  reason: string,
  runId: string,
): Promise<void> {
  try {
    await supabase.from("instaclaw_vm_lifecycle_log").insert({
      vm_id: vm.id,
      vm_name: vm.name,
      ip_address: null,
      user_id: null,
      user_email: "(freeze-v2)",
      subscription_status: null,
      credit_balance: 0,
      action,
      reason: `[${runId.slice(0, 8)}] ${reason}`,
      provider_server_id: null,
    });
  } catch (err) {
    logger.error("vm-freeze: lifecycle log insert failed (non-fatal)", {
      vmId: vm.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
