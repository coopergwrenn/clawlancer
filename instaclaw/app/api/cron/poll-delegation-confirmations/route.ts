import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";

// Prevent Vercel CDN from caching cron responses
export const dynamic = "force-dynamic";

// Per-run cap on rows processed. World developer-portal API call per row is
// the bottleneck (~250ms each) — 40 rows × 250ms ≈ 10s, well under the
// Vercel cron 60s ceiling.
const MAX_ROWS_PER_RUN = 40;

// Ms between World API calls — courtesy spacing, not a hard rate limit.
const INTER_CALL_DELAY_MS = 150;

// Don't poll rows newer than this — the in-band confirm route still has a
// chance to reach them first. Avoids racing the user-facing flow.
const MIN_AGE_SECONDS = 30;

// Max attempts the in-band poller already burned (8 × 2.5s) before flipping
// to pending_confirmation. The World API typically mines within seconds of
// MiniKit returning success — we use one slow retry per cron tick.
const POLL_ATTEMPTS = 1;

interface TxPollResult {
  status: "mined" | "failed" | "pending";
  hash?: string;
  amount?: string;
}

/**
 * Inline copy of pollTransactionStatus from instaclaw-mini/app/api/delegate/
 * confirm/route.ts. Kept here because this cron lives in the instaclaw/ app,
 * not the mini app; pulling the helper across project boundaries adds more
 * coupling than copying ~30 lines. If a third caller appears, hoist this
 * to a shared package.
 */
async function pollTransactionStatus(
  transactionId: string,
  appId: string,
  apiKey: string,
): Promise<TxPollResult> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    try {
      const res = await fetch(
        `https://developer.worldcoin.org/api/v2/minikit/transaction/${transactionId}?app_id=${appId}&type=payment`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (data.transaction_status === "mined") {
        return {
          status: "mined",
          hash: data.transactionHash,
          amount: data.token_amount ?? data.amount ?? undefined,
        };
      }
      if (data.transaction_status === "failed") {
        return { status: "failed" };
      }
    } catch {
      /* network error → fall through to "pending" */
    }
  }
  return { status: "pending" };
}

/**
 * Verify on-chain WLD amount matches expected. Same tolerance and graceful
 * degradation as the in-band confirm route. Returns true unless we can
 * confirm the amount is wrong (false-positives would block legit payments).
 */
function amountMatchesExpected(onChainAmount: string | undefined, expectedWld: number): boolean {
  if (!onChainAmount) return true;
  try {
    const expectedRaw = BigInt(expectedWld) * BigInt(10 ** 18);
    const actualRaw = BigInt(onChainAmount);
    const tolerance = expectedRaw / BigInt(1000);
    const diff = actualRaw > expectedRaw ? actualRaw - expectedRaw : expectedRaw - actualRaw;
    return diff <= tolerance;
  } catch {
    return true;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Background confirmation poller for instaclaw_wld_delegations.
 *
 * Why this exists: the user-facing /api/delegate/confirm route polls the
 * World developer-portal for at most 8 × 2.5s = 20s before bailing. If the
 * on-chain transaction takes longer to mine OR the user closes the app
 * before confirm fires, the row sits in `pending` (or `pending_confirmation`)
 * forever. The investigation 2026-04-30 found 64/112 confirmed rows had
 * NO transaction_hash — they got confirmed via the provision-side bypass,
 * not via genuine on-chain verification. This cron is the missing piece
 * confirm/route.ts:161 already promised: "a background job can retry
 * verification."
 *
 * What it does:
 *   - Picks rows in (pending OR pending_confirmation) with transaction_id
 *     set, age 30s..6h (post-MiniKit, pre-TTL).
 *   - Calls developer.worldcoin.org/api/v2/minikit/transaction/{id}.
 *   - On `mined`: grants credits via instaclaw_add_credits RPC IF the user
 *     has an assigned VM, then flips status='confirmed' + transaction_hash.
 *     If no VM exists, only flips status — the existing assign/configure
 *     flow will pick up the confirmed row when the user next opens the app.
 *   - On `failed`: flips to status='failed'.
 *   - Otherwise: leaves for next tick.
 *
 * Idempotent: re-running on already-confirmed rows is a no-op (filter
 * excludes them). The credit RPC is itself idempotent on `p_reference_id`.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";

  const appId = process.env.NEXT_PUBLIC_APP_ID || "";
  const apiKey = process.env.DEV_PORTAL_API_KEY || "";
  if (!appId || !apiKey) {
    logger.error("poll-delegation-confirmations: missing env vars", {
      route: "cron/poll-delegation-confirmations",
      hasAppId: !!appId,
      hasApiKey: !!apiKey,
    });
    return NextResponse.json(
      {
        error: "missing env vars",
        detail: "NEXT_PUBLIC_APP_ID and DEV_PORTAL_API_KEY must be set on this Vercel project",
        hasAppId: !!appId,
        hasApiKey: !!apiKey,
      },
      { status: 500 },
    );
  }

  const supabase = getSupabase();
  const now = Date.now();
  const minAgeCutoff = new Date(now - MIN_AGE_SECONDS * 1000).toISOString();
  const maxAgeCutoff = new Date(now - 6 * 60 * 60 * 1000).toISOString();

  const { data: candidates, error: selErr } = await supabase
    .from("instaclaw_wld_delegations")
    .select("id, user_id, vm_id, transaction_id, amount_wld, credits_granted, status, delegated_at")
    .in("status", ["pending", "pending_confirmation"])
    .not("transaction_id", "is", null)
    .lt("delegated_at", minAgeCutoff)
    .gt("delegated_at", maxAgeCutoff)
    .order("status", { ascending: false }) // pending_confirmation before pending
    .order("delegated_at", { ascending: true })
    .limit(MAX_ROWS_PER_RUN);

  if (selErr) {
    logger.error("poll-delegation-confirmations: select failed", {
      route: "cron/poll-delegation-confirmations",
      error: selErr.message,
      code: selErr.code,
    });
    return NextResponse.json({ error: "select failed", detail: selErr.message }, { status: 500 });
  }

  const candidateCount = candidates?.length ?? 0;

  if (dryRun) {
    return NextResponse.json({
      dryRun: true,
      window: { from: maxAgeCutoff, to: minAgeCutoff },
      maxRowsPerRun: MAX_ROWS_PER_RUN,
      candidateCount,
      sample: (candidates ?? []).slice(0, 10).map((c) => ({
        id: c.id,
        status: c.status,
        delegatedAt: c.delegated_at,
        hasVm: !!c.vm_id,
      })),
    });
  }

  let mined = 0;
  let confirmedFlipped = 0;
  let creditsGranted = 0;
  let failed = 0;
  let stillPending = 0;
  let amountMismatch = 0;
  let errors = 0;

  for (let i = 0; i < (candidates ?? []).length; i++) {
    const row = candidates![i];
    if (i > 0) await sleep(INTER_CALL_DELAY_MS);

    let result: TxPollResult;
    try {
      result = await pollTransactionStatus(row.transaction_id, appId, apiKey);
    } catch (err) {
      errors++;
      logger.warn("poll-delegation-confirmations: World API threw", {
        route: "cron/poll-delegation-confirmations",
        delegationId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (result.status === "pending") {
      stillPending++;
      continue;
    }

    if (result.status === "failed") {
      const { error: updErr } = await supabase
        .from("instaclaw_wld_delegations")
        .update({ status: "failed" })
        .eq("id", row.id)
        .in("status", ["pending", "pending_confirmation"]); // race-safe
      if (updErr) {
        errors++;
        logger.warn("poll-delegation-confirmations: failed-flip update errored", {
          route: "cron/poll-delegation-confirmations",
          delegationId: row.id,
          error: updErr.message,
        });
      } else {
        failed++;
      }
      continue;
    }

    // result.status === "mined"
    mined++;

    if (!amountMatchesExpected(result.amount, row.amount_wld)) {
      amountMismatch++;
      await supabase
        .from("instaclaw_wld_delegations")
        .update({ status: "amount_mismatch", transaction_hash: result.hash ?? null })
        .eq("id", row.id)
        .in("status", ["pending", "pending_confirmation"]);
      logger.warn("poll-delegation-confirmations: amount mismatch", {
        route: "cron/poll-delegation-confirmations",
        delegationId: row.id,
        expected: row.amount_wld,
        actual: result.amount,
      });
      continue;
    }

    // If the user has an assigned VM, grant credits via the same RPC the
    // confirm route uses. Idempotent on p_reference_id.
    let vmIdForUpdate = row.vm_id as string | null;
    if (!vmIdForUpdate) {
      const { data: vm } = await supabase
        .from("instaclaw_vms")
        .select("id")
        .eq("assigned_to", row.user_id)
        .maybeSingle();
      vmIdForUpdate = vm?.id ?? null;
    }

    if (vmIdForUpdate) {
      const { error: rpcErr } = await supabase.rpc("instaclaw_add_credits", {
        p_vm_id: vmIdForUpdate,
        p_credits: row.credits_granted,
        p_reference_id: `wld_delegation_${row.id}`,
        p_source: "wld",
      });
      if (rpcErr) {
        // Fallback for the older RPC signature (no p_source) — same as
        // confirm route. If this also fails, we mark credit_failed and
        // bail; ops can retry manually.
        if (rpcErr.message?.includes("p_source")) {
          const { error: rpcErr2 } = await supabase.rpc("instaclaw_add_credits", {
            p_vm_id: vmIdForUpdate,
            p_credits: row.credits_granted,
            p_reference_id: `wld_delegation_${row.id}`,
          });
          if (rpcErr2) {
            errors++;
            await supabase
              .from("instaclaw_wld_delegations")
              .update({ status: "credit_failed", transaction_hash: result.hash ?? null })
              .eq("id", row.id);
            logger.error("poll-delegation-confirmations: credit RPC failed (fallback)", {
              route: "cron/poll-delegation-confirmations",
              delegationId: row.id,
              error: rpcErr2.message,
            });
            continue;
          }
          creditsGranted += row.credits_granted;
        } else {
          errors++;
          await supabase
            .from("instaclaw_wld_delegations")
            .update({ status: "credit_failed", transaction_hash: result.hash ?? null })
            .eq("id", row.id);
          logger.error("poll-delegation-confirmations: credit RPC failed", {
            route: "cron/poll-delegation-confirmations",
            delegationId: row.id,
            error: rpcErr.message,
          });
          continue;
        }
      } else {
        creditsGranted += row.credits_granted;
      }
    }

    const { error: updErr } = await supabase
      .from("instaclaw_wld_delegations")
      .update({
        status: "confirmed",
        transaction_hash: result.hash ?? null,
        confirmed_at: new Date().toISOString(),
        ...(vmIdForUpdate ? { vm_id: vmIdForUpdate } : {}),
      })
      .eq("id", row.id)
      .in("status", ["pending", "pending_confirmation"]);

    if (updErr) {
      errors++;
      logger.error("poll-delegation-confirmations: confirmed-flip update errored", {
        route: "cron/poll-delegation-confirmations",
        delegationId: row.id,
        error: updErr.message,
      });
      continue;
    }
    confirmedFlipped++;
  }

  logger.info("poll-delegation-confirmations: completed", {
    route: "cron/poll-delegation-confirmations",
    candidateCount,
    mined,
    confirmedFlipped,
    creditsGranted,
    failed,
    amountMismatch,
    stillPending,
    errors,
  });

  return NextResponse.json({
    candidateCount,
    mined,
    confirmedFlipped,
    creditsGranted,
    failed,
    amountMismatch,
    stillPending,
    errors,
  });
}
