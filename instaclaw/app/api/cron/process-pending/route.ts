import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { assignOrProvisionUserVm } from "@/lib/createUserVM";
import { sendVMReadyEmail, sendAdminAlertEmail } from "@/lib/email";
import { wipeVMForNextUser, type VMRecord } from "@/lib/ssh";
import { isUserBillableForVmAssignment, getBillingStatusVerified, fetchBillingExempt } from "@/lib/billing-status";
import { getStripe } from "@/lib/stripe";
import { logger } from "@/lib/logger";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

const MAX_CONFIGURE_ATTEMPTS = 3;

export async function GET(req: NextRequest) {
  // Verify cron secret
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const dryRun = req.nextUrl.searchParams.get("dryRun") === "1";
  let assigned = 0;
  let retried = 0;
  let pass0Recovered = 0;
  const pass0Preview: Array<{ userId: string; email: string; tier: string; subStatus: string }> = [];

  // -----------------------------------------------------------------
  // Pass 0: Recover paid users with no VM + onboarding_complete=false
  //
  // Authoritative source: instaclaw_subscriptions (they paid).
  // Catches orphans whose pending_users row was deleted by Pass 4 before
  // Pass 1 could assign a VM — e.g., pool was empty when their webhook fired.
  //
  // Only active/trialing are auto-recovered. past_due subs are intentionally
  // excluded: they need payment resolution first. Once payment succeeds, the
  // customer.subscription.updated webhook flips status=active and this pass
  // picks them up on the next cron cycle.
  //
  // Does NOT use pending_users as a staging area because:
  //   - telegram_bot_token is NOT NULL in the schema (blocks null-inserts)
  //   - configure route already handles "no pending row" case with defaults
  //     derived from the subscription (see app/api/vm/configure/route.ts:106-178)
  //
  // Dry-run: GET /api/cron/process-pending?dryRun=1 — returns preview list,
  // no DB writes, no VM assignments.
  //
  // 2026-05-12 starvation + scale + fairness fix. Khomenko89 incident: she
  // paid 2026-04-30, the pool was empty when her webhook fired, her pending
  // row was deleted by Pass 4, Pass 0 should have recovered her. Instead
  // .limit(3) with NO ORDER BY returned 3 random orphans, all "soft-incomplete"
  // (paid + have VM + onboarding_complete=false because configureOpenClaw
  // didn't finish writing supplemental state). The in-loop existingVm check
  // skipped them, the loop exited, zero recoveries. The cron ran every 5 min
  // for 12 days — 3,456 firings — and never picked her up.
  //
  // ── Architecture orientation ─────────────────────────────────────────
  //
  // The HAPPY PATH for ~95% of signups does NOT touch this cron:
  //
  //   user pays → Stripe webhook (billing/webhook:225 checkout.session.completed)
  //     → assignVMWithSSHCheck (inline, lines 464-487 — SKIP LOCKED RPC)
  //     → provisionBankrWallet (idempotent by user_id, line 492)
  //     → fetch /api/vm/configure × 3 retries × 5s backoff (lines 503-548)
  //     → user has a working Telegram bot in 60-180s
  //
  // This route is the BACKSTOP for the ~5% where the webhook path can't
  // complete: pool drained at webhook time, transient Stripe-retry, configure
  // throws in a way the inline retries can't recover, or — historically —
  // Pass 4 deletes the pending row before Pass 1 sees it. Six passes layered
  // for resilience:
  //
  //   Pass 0  — paid orphans, no VM yet (THIS block)
  //   Pass 1  — pending_users rows, no VM yet
  //   Pass 2  — health_status="configure_failed" + attempts<MAX (retry)
  //   Pass 2b — gateway_url=null + attempts>0 (retry gateway-up)
  //   Pass 2c — attempts>=MAX → release VM, requeue user
  //   Pass 3  — assigned VMs with configure_attempts=0 + health=unknown
  //   Pass 3b — assigned >5min with gateway_url=null (catch-all)
  //   Pass 4  — clean up stale pending_users >10min with no VM
  //   Pass 5  — purge consumed pending_users >24h
  //
  // ── Three Pass 0 fixes ───────────────────────────────────────────────
  //
  //   1. Pre-fetch user_ids that already have a VM and EXCLUDE at the query
  //      level via .not("user_id","in",...). The limit budget now goes
  //      entirely to true orphans, not soft-incompletes.
  //   2. ORDER BY instaclaw_users(partner) DESC NULLS LAST, then created_at
  //      ASC. Partners (edge_city, consensus_2026) jump the queue — they
  //      signed up via partner portals with negotiated SLAs. Within a
  //      partner tier, oldest waiters get served first (SLA fairness).
  //   3. Dynamic batch sizing. limit raised from 3 → 30 (the upper cap; the
  //      loop's `if (!vm) break` naturally throttles to pool_ready_count
  //      when the pool drains). count:"exact" returns total row count
  //      alongside the limit(30) slice so we can log queue depth for
  //      backlog alerting without a second roundtrip. Intuition: the
  //      effective batch size is min(queue_depth, pool_ready, 30).
  //
  // ── Scale ceilings (where the architecture breaks) ───────────────────
  //
  //   Steady state (~20 signups/day): webhook path. Pool stays at 15.
  //   Busy day (10 signups in 5 min): all served by webhook path.
  //   Burst (100 signups in 1 hour): webhook drains pool to 0, subsequent
  //     signups fall back to Pass 0. With dynamic batching Pass 0 drains
  //     backlog at pool_ready_per_cycle. replenish-pool's MAX_PER_RUN=10
  //     caps refill at 96/hour. Demand=100/hour → balanced.
  //   Viral (500 in 1 hour): replenish-pool can't keep up. POOL_TARGET=15
  //     becomes the bottleneck. Pre-warm the pool before known events
  //     (Edge Esmeralda 2026-05-30) or auto-scale POOL_TARGET by hour.
  //     See "Scale follow-ups" below.
  //
  // ── Future: event-driven path (eliminate this cron's failure tail) ───
  //
  //   The 5-min cron cadence adds up-to-10-min p99 latency to the
  //   webhook-failure cases. To shrink it:
  //
  //     1. Supabase pg_notify("orphan_paid_user", user_id) when:
  //          (a) instaclaw_subscriptions.status transitions to
  //              active/trialing AND instaclaw_users.onboarding_complete=
  //              false AND no VM
  //          (b) instaclaw_vms.health_status flips to "configure_failed"
  //          (c) pending_users row inserted with no VM after 30s
  //     2. Edge function subscribes via supabase-js realtime, picks up
  //        each notification, calls the same recovery path Pass 0 uses
  //        (assignVMWithSSHCheck + fetch /api/vm/configure).
  //     3. Cron remains as the periodic reconciliation backstop for any
  //        events the realtime path missed (defense in depth, current
  //        role).
  //
  //   Latency target: paid user → working Telegram bot in <30s. Cron
  //   becomes belt-and-suspenders. NOT built today — ORDER BY + dynamic
  //   batch is sufficient for current scale.
  //
  // ── Scale follow-ups (track these for Edge Esmeralda 2026-05-30) ─────
  //
  //   F1. replenish-pool MAX_PER_RUN=10 is too low for sustained bursts.
  //       Make it dynamic based on recent signup velocity.
  //   F2. POOL_TARGET=15 is too low for known event days. Pre-warm or
  //       auto-scale by hour-of-day (or by signup velocity).
  //   F3. Event-driven recovery (above) once cron latency becomes the
  //       dominant bottleneck (today it's MAX_PER_RUN, not cron lag).
  //   F4. Stripe webhook can fail to fire (rare). Add a periodic
  //       reconciliation against Stripe API as a second backstop.
  // -----------------------------------------------------------------
  {
    // (1) Pre-fetch user_ids that already have a VM. These are NOT orphans —
    // they're soft-incomplete users whose state is fixed elsewhere
    // (reconciler stepTelegramTokenVerify syncs disk; manual support
    // intervention fixes onboarding_complete=true). Excluding here prevents
    // Pass 0's budget from getting wasted on rows the in-loop existingVm
    // check would skip anyway.
    const { data: assignedUsers } = await supabase
      .from("instaclaw_vms")
      .select("assigned_to")
      .not("assigned_to", "is", null);
    const assignedUserIds = Array.from(new Set(
      (assignedUsers ?? [])
        .map((r) => (r as { assigned_to: string | null }).assigned_to)
        .filter((id): id is string => !!id),
    ));

    // (2) + (3) Build the query. count:"exact" returns total queue depth
    // alongside the limit(30) slice so we can log a backlog signal without
    // a second roundtrip. ORDER BY partner DESC NULLS LAST puts paying
    // partners (edge_city, consensus_2026) ahead of non-partner users.
    // Within each tier we order by sub.created_at ASC — oldest paying
    // waiter served first.
    const PASS0_MAX_BATCH = 30;
    let orphansQuery = supabase
      .from("instaclaw_subscriptions")
      .select(
        "user_id, tier, status, created_at, instaclaw_users!inner(email, onboarding_complete, partner)",
        { count: "exact" },
      )
      .in("status", ["active", "trialing"])
      .eq("instaclaw_users.onboarding_complete", false)
      // Partner priority — non-null partners first (edge_city, consensus_2026).
      // PostgREST foreign-table column syntax: "table(column)".
      .order("instaclaw_users(partner)", { ascending: false, nullsFirst: false })
      // Fairness tiebreaker — oldest paying waiter served first.
      .order("created_at", { ascending: true })
      .limit(PASS0_MAX_BATCH);

    if (assignedUserIds.length > 0) {
      // PostgREST NOT IN. UUIDs don't need quoting. URL length scales with
      // active-VM count; at ~250 VMs the IN list is ~9KB which fits under
      // standard URL limits (PostgREST/Vercel ~16KB). Move to an RPC if
      // this ever approaches the limit (~400 UUIDs).
      orphansQuery = orphansQuery.not(
        "user_id",
        "in",
        `(${assignedUserIds.join(",")})`,
      );
    }

    // Snapshot pool readiness in parallel with the orphan fetch. This is
    // purely observability — the actual throttling happens via the loop's
    // "if (!vm) break" when assignVMWithSSHCheck returns null. Knowing
    // pool_ready lets us log expected-assignments-this-cycle and surface
    // "queue depth > pool" as a backlog signal for Edge-Esmeralda-class
    // bursts where replenish-pool can't keep up.
    const [{ data: orphans, count: orphanQueueDepth, error: orphanErr }, { count: poolReadyCount }] =
      await Promise.all([
        orphansQuery,
        supabase
          .from("instaclaw_vms")
          .select("id", { count: "exact", head: true })
          .eq("status", "ready")
          .eq("provider", "linode")
          .eq("health_status", "healthy"),
      ]);

    const queueDepth = orphanQueueDepth ?? 0;
    const poolReady = poolReadyCount ?? 0;
    const expectedAssignments = Math.min(queueDepth, poolReady, PASS0_MAX_BATCH);

    if (queueDepth > 0) {
      logger.info("Pass 0: orphan batch", {
        route: "cron/process-pending",
        queueDepth,
        poolReady,
        batchFetched: orphans?.length ?? 0,
        expectedAssignments,
      });
    }

    if (queueDepth > poolReady) {
      // Backlog: more true orphans than ready VMs. Replenish-pool needs to
      // catch up. At 100+/hour bursts this is where MAX_PER_RUN=10 becomes
      // the dominant bottleneck (see follow-up F1 above).
      logger.warn("Pass 0: queue depth exceeds pool capacity — backlog forming", {
        route: "cron/process-pending",
        queueDepth,
        poolReady,
        cyclesToDrainAtCurrentReplenish: Math.ceil(
          (queueDepth - poolReady) / 8, // replenish provisions ~8/cycle (5 min)
        ),
      });
    }

    if (orphanErr) {
      logger.error("Pass 0: orphan query failed", {
        route: "cron/process-pending",
        error: String(orphanErr),
      });
    }

    for (const o of orphans ?? []) {
      // Safety: the pre-fetch + NOT IN should keep VM-having users out of
      // this loop, but races (a user gets assigned a VM between the
      // pre-fetch and this iteration) are possible. Keep the explicit
      // check as defense in depth.
      const { data: existingVm } = await supabase
        .from("instaclaw_vms")
        .select("id")
        .eq("assigned_to", o.user_id)
        .maybeSingle();
      if (existingVm) continue;

      const email = (o as { instaclaw_users?: { email?: string } }).instaclaw_users?.email ?? "(unknown)";
      pass0Preview.push({ userId: o.user_id, email, tier: o.tier, subStatus: o.status });

      if (dryRun) continue;

      logger.warn("Pass 0: orphaned paid user — attempting recovery", {
        route: "cron/process-pending",
        userId: o.user_id,
        tier: o.tier,
        email,
      });

      // Clear any stale deployment_lock_at so assignment proceeds cleanly.
      await supabase
        .from("instaclaw_users")
        .update({ deployment_lock_at: null })
        .eq("id", o.user_id);

      // ── Phase 1B-1: wrapper gates on CLOUD_INIT_ONDEMAND_ENABLED ──
      // Throws on permanent errors (missing pending_users / missing
      // telegram_bot_*) and transient errors (Linode rate-limit). Caller's
      // try/catch normalizes both to "no result this cycle, retry next".
      let assignResult: Awaited<ReturnType<typeof assignOrProvisionUserVm>> = null;
      try {
        assignResult = await assignOrProvisionUserVm(o.user_id, { supabase });
      } catch (assignErr) {
        logger.error("Pass 0: assignOrProvisionUserVm threw — skipping this orphan, retry next cycle", {
          route: "cron/process-pending",
          userId: o.user_id,
          error: assignErr instanceof Error ? assignErr.message : String(assignErr),
        });
        continue;
      }
      if (!assignResult) break; // pool empty — bail, retry next cycle

      if (assignResult.path === "pool") {
        // Pool path: call /api/vm/configure to SSH-personalize the VM.
        try {
          const configRes = await fetch(
            `${process.env.NEXTAUTH_URL}/api/vm/configure`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
              },
              body: JSON.stringify({ userId: o.user_id }),
            }
          );
          if (configRes.ok) {
            pass0Recovered++;
            logger.info("Pass 0: orphan recovered (pool path)", {
              route: "cron/process-pending",
              userId: o.user_id,
              vmId: assignResult.vmId,
            });
            if (email !== "(unknown)") {
              try {
                await sendVMReadyEmail(
                  email,
                  `${process.env.NEXTAUTH_URL}/dashboard`
                );
              } catch (emailErr) {
                logger.warn("Pass 0: VM ready email failed (non-fatal)", {
                  route: "cron/process-pending",
                  userId: o.user_id,
                  error: String(emailErr),
                });
              }
            }
          } else {
            logger.error("Pass 0: configure returned non-OK", {
              route: "cron/process-pending",
              userId: o.user_id,
              vmId: assignResult.vmId,
              status: configRes.status,
            });
          }
        } catch (err) {
          logger.error("Pass 0: configure call threw", {
            error: String(err),
            route: "cron/process-pending",
            userId: o.user_id,
            vmId: assignResult.vmId,
          });
        }
      } else {
        // Cloud-init path: setup.sh handles configure on-VM; cloud-init-callback
        // marks the row healthy when done. No fetch /api/vm/configure here.
        // VM-ready email deferred until the cloud-init-callback email enhancement
        // ships (Phase 1B-1 follow-up).
        pass0Recovered++;
        logger.info("Pass 0: orphan recovered (cloud-init path — provisioning)", {
          route: "cron/process-pending",
          userId: o.user_id,
          vmId: assignResult.vmId,
          ipAddress: assignResult.ipAddress,
        });
      }
    }
  }

  // -----------------------------------------------------------------
  // Pass 1: Assign VMs to pending users who don't have one yet
  // -----------------------------------------------------------------
  const { data: pending } = await supabase
    .from("instaclaw_pending_users")
    .select("*, instaclaw_users!inner(email)")
    .is("consumed_at", null) // Skip already-consumed records
    .order("created_at", { ascending: true })
    .limit(10);

  if (pending?.length) {
    for (const p of pending) {
      // Skip if user already has a VM assigned (they're waiting on configure, not assignment)
      const { data: existingVm } = await supabase
        .from("instaclaw_vms")
        .select("id")
        .eq("assigned_to", p.user_id)
        .single();

      if (existingVm) continue;

      // BILLING CHECK (Pass 1): Never assign a VM without a valid billing
      // signal. Without this, anyone who completes the onboarding wizard
      // (creating a pending_users row) but skips Stripe checkout gets a
      // free VM.
      //
      // Per CLAUDE.md Rule 14 + P0-3 fix (2026-05-27): treat partner-tagged
      // users (edge_city sponsored cohort, future Eclipse/Devcon, etc) as
      // billable even without a Stripe sub. Edge channel-first users go
      // /auth → /onboarding/done with no Stripe round-trip; the prior
      // sub-only check skipped them on every retry, leaving them with no
      // VM if /auth's after() failed.
      const billing = await isUserBillableForVmAssignment(supabase, p.user_id);
      if (!billing.billable) {
        logger.warn("Skipping VM assignment — not billable", {
          route: "cron/process-pending",
          pass: "1",
          userId: p.user_id,
          reason: billing.reason,
        });
        continue;
      }

      // ── Phase 1B-1: wrapper gates on CLOUD_INIT_ONDEMAND_ENABLED ──
      let assignResult: Awaited<ReturnType<typeof assignOrProvisionUserVm>> = null;
      try {
        assignResult = await assignOrProvisionUserVm(p.user_id, { supabase });
      } catch (assignErr) {
        logger.error("Pass 1: assignOrProvisionUserVm threw — skipping this user, retry next cycle", {
          route: "cron/process-pending",
          userId: p.user_id,
          error: assignErr instanceof Error ? assignErr.message : String(assignErr),
        });
        continue;
      }
      if (!assignResult) break; // No more VMs available (pool empty)

      if (assignResult.path === "pool") {
        // Pool path: trigger configure + send VM-ready email
        try {
          const configRes = await fetch(
            `${process.env.NEXTAUTH_URL}/api/vm/configure`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
              },
              body: JSON.stringify({ userId: p.user_id }),
            }
          );
          if (configRes.ok) {
            const userEmail = (p as Record<string, unknown>).instaclaw_users as {
              email: string;
            };
            if (userEmail?.email) {
              await sendVMReadyEmail(
                userEmail.email,
                `${process.env.NEXTAUTH_URL}/dashboard`,
                p.telegram_bot_username ?? undefined
              );
            }
            assigned++;
          }
        } catch (err) {
          logger.error("Failed to configure VM for user", { error: String(err), route: "cron/process-pending", userId: p.user_id });
        }
      } else {
        // Cloud-init path: setup.sh handles configure on-VM. VM-ready email
        // deferred to cloud-init-callback enhancement (Phase 1B-1 follow-up).
        assigned++;
        logger.info("Pass 1: VM provisioning via cloud-init", {
          route: "cron/process-pending",
          userId: p.user_id,
          vmId: assignResult.vmId,
          ipAddress: assignResult.ipAddress,
        });
      }
    }
  }

  // -----------------------------------------------------------------
  // Pass 2: Retry failed configurations (max 3 attempts)
  // -----------------------------------------------------------------
  const { data: failedVms } = await supabase
    .from("instaclaw_vms")
    .select("assigned_to, configure_attempts, telegram_bot_username")
    .eq("health_status", "configure_failed")
    .not("status", "in", '("terminated","destroyed","failed")')
    .lt("configure_attempts", MAX_CONFIGURE_ATTEMPTS)
    .not("assigned_to", "is", null)
    .limit(10);

  if (failedVms?.length) {
    for (const vm of failedVms) {
      // Verify pending config still exists (needed by configure endpoint)
      const { data: hasPending } = await supabase
        .from("instaclaw_pending_users")
        .select("id")
        .eq("user_id", vm.assigned_to)
        .is("consumed_at", null)
        .single();

      if (!hasPending) continue;

      try {
        const configRes = await fetch(
          `${process.env.NEXTAUTH_URL}/api/vm/configure`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
            },
            body: JSON.stringify({ userId: vm.assigned_to }),
          }
        );

        if (configRes.ok) {
          retried++;

          // Send notification email
          const { data: user } = await supabase
            .from("instaclaw_users")
            .select("email")
            .eq("id", vm.assigned_to)
            .single();

          if (user?.email) {
            await sendVMReadyEmail(
              user.email,
              `${process.env.NEXTAUTH_URL}/dashboard`,
              vm.telegram_bot_username ?? undefined
            );
          }
        }
      } catch (err) {
        logger.error("Failed to retry configure for user", { error: String(err), route: "cron/process-pending", userId: vm.assigned_to });
      }
    }
  }

  // -----------------------------------------------------------------
  // Pass 2b: Retry VMs that were assigned + configured but gateway never
  // came up (gateway_url is null). This catches the case where configure
  // ran but the gateway didn't start — our new gateway verification logic
  // sets gateway_url to null in that case.
  // -----------------------------------------------------------------
  let gatewayRetried = 0;
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const { data: noGatewayVms } = await supabase
    .from("instaclaw_vms")
    .select("id, assigned_to, configure_attempts")
    .not("assigned_to", "is", null)
    .not("status", "in", '("terminated","destroyed","failed")')
    .is("gateway_url", null)
    .gt("configure_attempts", 0)
    .lt("configure_attempts", MAX_CONFIGURE_ATTEMPTS)
    .lt("last_health_check", fiveMinutesAgo)
    .limit(5);

  if (noGatewayVms?.length) {
    for (const vm of noGatewayVms) {
      try {
        const configRes = await fetch(
          `${process.env.NEXTAUTH_URL}/api/vm/configure`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
            },
            body: JSON.stringify({ userId: vm.assigned_to }),
          }
        );

        if (configRes.ok) {
          gatewayRetried++;
          logger.info("Retried configure for VM with no gateway_url", {
            route: "cron/process-pending",
            vmId: vm.id,
            userId: vm.assigned_to,
            attempt: vm.configure_attempts + 1,
          });
        }
      } catch (err) {
        logger.error("Failed to retry configure for no-gateway VM", {
          error: String(err),
          route: "cron/process-pending",
          vmId: vm.id,
        });
      }
    }
  }

  // -----------------------------------------------------------------
  // Pass 2c: Release VMs that exhausted configure retries.
  // Belt+suspenders for the auto-release in configure route — catches any
  // exhausted VMs the configure endpoint missed.
  // -----------------------------------------------------------------
  let released = 0;
  const { data: exhaustedVms } = await supabase
    .from("instaclaw_vms")
    .select("id, assigned_to, configure_attempts")
    .eq("health_status", "configure_failed")
    .not("status", "in", '("terminated","destroyed","failed")')
    .gte("configure_attempts", MAX_CONFIGURE_ATTEMPTS)
    .not("assigned_to", "is", null)
    .limit(5);

  if (exhaustedVms?.length) {
    for (const evm of exhaustedVms) {
      logger.error("Pass 2c: releasing exhausted VM", {
        route: "cron/process-pending",
        vmId: evm.id,
        userId: evm.assigned_to,
        configureAttempts: evm.configure_attempts,
      });
      await supabase.from("instaclaw_vms").update({
        status: "failed", health_status: "unhealthy",
        assigned_to: null, assigned_at: null,
        gateway_url: null, gateway_token: null, configure_lock_at: null,
        // Rule 34: clear per-user channel state so the next assignee doesn't
        // inherit the prior user's Telegram identity from the DB.
        telegram_bot_token: null, telegram_bot_username: null, telegram_chat_id: null,
        // Option B (defense-in-depth): null IP at failed-flip — see
        // cron/health-check/route.ts:336 for full rationale. Prevents the
        // resurrection probe from re-selecting this row after Linode reuses
        // its IP for a different machine.
        ip_address: null,
      }).eq("id", evm.id);
      await supabase.from("instaclaw_users").update({
        onboarding_complete: false, deployment_lock_at: null,
      }).eq("id", evm.assigned_to);
      await supabase.from("instaclaw_pending_users")
        .update({ consumed_at: null }).eq("user_id", evm.assigned_to);
      released++;
    }
  }

  // -----------------------------------------------------------------
  // Pass 3: Auto-configure orphaned VMs (assigned but never configured)
  // Users who paid but never completed the onboarding wizard end up with
  // a VM assigned but configure_attempts = 0 and no pending config.
  // After 10 minutes, configure them with defaults so the gateway runs.
  // -----------------------------------------------------------------
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  let autoConfigured = 0;

  // 2026-05-12 fairness: ORDER BY assigned_at DESC so the most-recently-
  // assigned VMs get configured first. Old "zombie" assignments (assigned
  // long ago, never configured) tend to be terminated/cancelled users whose
  // configure was never going to succeed anyway. Newly-paid customers
  // shouldn't wait behind those zombies — without ORDER BY, the previous
  // .limit(10) with no ordering could return a random mix that buried real
  // customers behind dead VMs.
  const { data: orphanedVms } = await supabase
    .from("instaclaw_vms")
    .select("id, assigned_to, assigned_at, telegram_bot_username")
    .not("assigned_to", "is", null)
    .not("status", "in", '("terminated","destroyed","failed")')
    .eq("configure_attempts", 0)
    .in("health_status", ["unknown", "unhealthy"])
    .lt("assigned_at", tenMinutesAgo)
    .order("assigned_at", { ascending: false })
    .limit(10);

  if (orphanedVms?.length) {
    for (const vm of orphanedVms) {
      // Skip if there's a pending config (standard retry logic will handle it)
      const { data: hasPending } = await supabase
        .from("instaclaw_pending_users")
        .select("id")
        .eq("user_id", vm.assigned_to)
        .is("consumed_at", null)
        .single();

      if (hasPending) continue;

      // Verify user is billable (don't configure for cancelled users).
      // P0-3 fix: extended from "active sub only" to include partner-tagged
      // sponsored users + trialing subs. Same rationale as Pass 1.
      const billing3 = await isUserBillableForVmAssignment(supabase, vm.assigned_to);
      if (!billing3.billable) {
        logger.info("Pass 3: skipping orphan auto-configure — not billable", {
          route: "cron/process-pending",
          userId: vm.assigned_to,
          vmId: vm.id,
          reason: billing3.reason,
        });
        continue;
      }

      logger.info("Auto-configuring orphaned VM with defaults", {
        route: "cron/process-pending",
        userId: vm.assigned_to,
        vmId: vm.id,
        assignedAt: vm.assigned_at,
      });

      try {
        const configRes = await fetch(
          `${process.env.NEXTAUTH_URL}/api/vm/configure`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
            },
            body: JSON.stringify({ userId: vm.assigned_to }),
          }
        );

        if (configRes.ok) {
          autoConfigured++;

          const { data: user } = await supabase
            .from("instaclaw_users")
            .select("email")
            .eq("id", vm.assigned_to)
            .single();

          if (user?.email) {
            await sendVMReadyEmail(
              user.email,
              `${process.env.NEXTAUTH_URL}/dashboard`,
              vm.telegram_bot_username ?? undefined
            );
          }
        }
      } catch (err) {
        logger.error("Failed to auto-configure orphaned VM", {
          error: String(err),
          route: "cron/process-pending",
          userId: vm.assigned_to,
        });
      }
    }
  }

  // -----------------------------------------------------------------
  // Pass 3b: Catch-all for stuck deployments — VMs assigned >5 min with
  // no gateway_url, regardless of configure_attempts or health_status.
  // This is the ultimate safety net: if verify, webhook, AND all other
  // passes failed, this will still trigger configure.
  // -----------------------------------------------------------------
  let stuckDeployFixed = 0;

  const { data: stuckDeployVms } = await supabase
    .from("instaclaw_vms")
    .select("id, assigned_to, configure_attempts, assigned_at, telegram_bot_username")
    .eq("status", "assigned")
    .not("assigned_to", "is", null)
    .is("gateway_url", null)
    .lt("assigned_at", fiveMinutesAgo)
    .limit(10);

  if (stuckDeployVms?.length) {
    for (const vm of stuckDeployVms) {
      // Verify user is billable (P0-3 fix: includes partner-tagged sponsored
      // users like edge_city who never get a Stripe sub).
      const billing3b = await isUserBillableForVmAssignment(supabase, vm.assigned_to);
      if (!billing3b.billable) {
        logger.info("Pass 3b: skipping stuck-deploy retry — not billable", {
          route: "cron/process-pending",
          userId: vm.assigned_to,
          vmId: vm.id,
          reason: billing3b.reason,
        });
        continue;
      }

      logger.info("Stuck deployment detected — triggering configure (catch-all)", {
        route: "cron/process-pending",
        vmId: vm.id,
        userId: vm.assigned_to,
        configureAttempts: vm.configure_attempts,
        assignedAt: vm.assigned_at,
      });

      try {
        const configRes = await fetch(
          `${process.env.NEXTAUTH_URL}/api/vm/configure`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
            },
            body: JSON.stringify({ userId: vm.assigned_to }),
          }
        );

        if (configRes.ok) {
          stuckDeployFixed++;

          const { data: user } = await supabase
            .from("instaclaw_users")
            .select("email")
            .eq("id", vm.assigned_to)
            .single();

          if (user?.email) {
            await sendVMReadyEmail(
              user.email,
              `${process.env.NEXTAUTH_URL}/dashboard`,
              vm.telegram_bot_username ?? undefined
            );
          }
        }
      } catch (err) {
        logger.error("Failed to fix stuck deployment", {
          error: String(err),
          route: "cron/process-pending",
          vmId: vm.id,
          userId: vm.assigned_to,
        });
      }
    }
  }

  // -----------------------------------------------------------------
  // Pass 4: Clean up stale pending_users (stuck for more than 10 minutes)
  // -----------------------------------------------------------------
  const { data: stalePending } = await supabase
    .from("instaclaw_pending_users")
    .select("user_id, created_at")
    .is("consumed_at", null) // Only clean up non-consumed stale records
    .lt("created_at", tenMinutesAgo)
    .limit(10);

  let cleaned = 0;
  if (stalePending?.length) {
    for (const p of stalePending) {
      // Check if they have a VM assigned (if so, don't clean up - they're just waiting for configure)
      const { data: hasVm } = await supabase
        .from("instaclaw_vms")
        .select("id")
        .eq("assigned_to", p.user_id)
        .single();

      if (hasVm) continue; // VM assigned, let retry logic handle it

      // No VM after 10 minutes - clean up and let them retry
      await supabase
        .from("instaclaw_pending_users")
        .delete()
        .eq("user_id", p.user_id);

      cleaned++;
      logger.info("Cleaned up stale pending user", {
        route: "cron/process-pending",
        userId: p.user_id,
        staleDuration: Math.floor((Date.now() - new Date(p.created_at).getTime()) / 1000 / 60),
      });
    }
  }

  // -----------------------------------------------------------------
  // Pass 5: Clean up consumed pending_users older than 24 hours.
  // Consumed records are kept as a safety net for re-configure scenarios
  // but serve no purpose after 24h.
  // -----------------------------------------------------------------
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { error: consumedErr } = await supabase
    .from("instaclaw_pending_users")
    .delete()
    .not("consumed_at", "is", null)
    .lt("consumed_at", oneDayAgo);

  if (consumedErr) {
    logger.error("Failed to clean consumed pending records", {
      route: "cron/process-pending",
      error: String(consumedErr),
    });
  }

  // -----------------------------------------------------------------
  // Pass 6: Reclaim abandoned-after-OAuth VMs (per spec §6.5.10).
  //
  // Catches the new failure mode introduced by the 2026-05-26
  // onboarding redesign: VM assignment fires at OAuth-complete (not
  // card-complete). If the user abandons between OAuth and submitting
  // /onboarding/done, we'd otherwise hold a $29/mo Linode VM forever.
  //
  // Predicate:
  //   channel IS NOT NULL    — channel-onboarding (BYOB has channel
  //                            NULL and is handled by Pass 4)
  //   consumed_at IS NULL    — not already onboarded or reclaimed
  //   created_at < 10min ago — give the web flow plenty of time
  //
  // Race-safe via compare-and-swap on consumed_at. Three writers
  // (form-submit handler, m-return sweep, this cron) all use the same
  // predicate; whoever's UPDATE returns a row wins. If form-submit
  // beats us by 1ms, our UPDATE returns 0 rows and we skip.
  //
  // For each reclaimed row:
  //   - User had a VM (the common case): wipe via wipeVMForNextUser,
  //     return VM to pool with all per-user fields cleared.
  //   - User had no VM (OAuth completed but assignment failed): just
  //     mark pending row consumed+reclaimed, no VM work needed.
  //   - Wipe failed: quarantine the VM (status='failed') so it's not
  //     re-used, alert ops. Never silently leak — could expose prior
  //     user's data to the next assignee.
  // -----------------------------------------------------------------
  let pass6Reclaimed = 0;
  let pass6WipeFailed = 0;
  let pass6NoVm = 0;
  let pass6SkippedRace = 0;
  let pass6SkippedProtected = 0;

  // Widened from 10 → 30 min on 2026-05-27 (P1-D fix). Pre-launch sizing
  // for ~1000 Edge attendees who may take a phone call mid-flow, walk
  // away for a coffee, or get distracted by a poster conversation. The
  // 10-min window was too aggressive — it produced "{kind: expired}"
  // form-submit responses for any thoughtful user. M_RETURN sweep's
  // CLOSED_TAB_MAX_AGE_MS bumped to match (see m-return-sweep route)
  // so we don't leave a 10-30 min dead zone where the closed-tab catch-up
  // doesn't fire AND reclaim hasn't yet kicked in.
  const PASS_6_RECLAIM_WINDOW_MS = 30 * 60 * 1000;
  const pass6Threshold = new Date(Date.now() - PASS_6_RECLAIM_WINDOW_MS).toISOString();

  const { data: pass6Candidates, error: pass6CandErr } = await supabase
    .from("instaclaw_pending_users")
    .select("*")
    .not("channel", "is", null)
    .is("consumed_at", null)
    .lt("created_at", pass6Threshold)
    .limit(10);

  if (pass6CandErr) {
    logger.error("Pass 6: candidate query failed", {
      route: "cron/process-pending",
      error: pass6CandErr.message,
    });
  } else if (pass6Candidates && pass6Candidates.length > 0) {
    for (const pending of pass6Candidates) {
      const ageMinutes = Math.floor(
        (Date.now() - new Date(pending.created_at).getTime()) / 1000 / 60,
      );

      if (dryRun) {
        // In dry-run mode, just count what we WOULD do without writing.
        logger.info("Pass 6: [dry-run] would reclaim", {
          route: "cron/process-pending",
          pendingId: pending.id,
          channel: pending.channel,
          userId: pending.user_id,
          ageMinutes,
        });
        pass6Reclaimed++;
        continue;
      }

      // ─── Lookup VM BEFORE claiming the row ──
      // Order matters here: if the VM lookup fails (DB hiccup, Rule-41
      // multi-VM violation), we DON'T want a claimed-but-not-wiped
      // pending row. That would create exactly the silent-leak the
      // reclaim-health cron (item 6) can't catch, because its predicate
      // looks for consumed_at IS NULL.
      //
      // Doing the read first is race-free (it's read-only). The atomic
      // claim happens after we know whether there's a VM to wipe.
      const userId = pending.user_id;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let vm: any = null;

      if (userId) {
        const { data, error: vmLookupErr } = await supabase
          .from("instaclaw_vms")
          .select("*")
          .eq("assigned_to", userId)
          .eq("status", "assigned")
          .maybeSingle();

        if (vmLookupErr) {
          // Could be a Rule-41 violation (>1 VM per user) or DB hiccup.
          // Skip without claiming — next cron tick will retry.
          logger.error("Pass 6: VM lookup failed; skipping reclaim", {
            route: "cron/process-pending",
            pendingId: pending.id,
            userId,
            error: vmLookupErr.message,
          });
          continue;
        }
        vm = data;
      }

      // ─── Atomic claim via compare-and-swap on consumed_at ──
      // Race-safety per spec §6.5.10. If another writer (form submit,
      // m-return sweep) set consumed_at since our SELECT, this UPDATE
      // returns 0 rows and we skip the row.
      const nowIso = new Date().toISOString();
      const { data: claimed, error: claimErr } = await supabase
        .from("instaclaw_pending_users")
        .update({
          consumed_at: nowIso,
          reclaimed_at: nowIso,
        })
        .eq("id", pending.id)
        .is("consumed_at", null)
        .select()
        .maybeSingle();

      if (claimErr) {
        logger.error("Pass 6: claim UPDATE failed", {
          route: "cron/process-pending",
          pendingId: pending.id,
          error: claimErr.message,
        });
        continue;
      }

      if (!claimed) {
        // Race lost — another writer beat us. Not an error.
        logger.info("Pass 6: race lost on consumed_at; skipping", {
          route: "cron/process-pending",
          pendingId: pending.id,
        });
        pass6SkippedRace++;
        continue;
      }

      // ─── Branch on whether we have a VM to wipe ──
      if (!userId) {
        // OAuth never completed — pending row was created by the
        // inbound webhook but the user never reached /auth. Just
        // mark reclaimed (already done above). No VM, no user state.
        logger.info("Pass 6: reclaimed pending row with no user_id", {
          route: "cron/process-pending",
          pendingId: pending.id,
          channel: pending.channel,
          ageMinutes,
        });
        pass6NoVm++;
        continue;
      }

      if (!vm) {
        // OAuth completed, but no VM was ever assigned (pool empty +
        // cloud-init failed, or assignOrProvisionUserVm errored).
        // Reset user onboarding flags so they can retry cleanly.
        await supabase
          .from("instaclaw_users")
          .update({ onboarding_complete: false, deployment_lock_at: null })
          .eq("id", userId);
        logger.info("Pass 6: reclaimed pending row with no assigned VM", {
          route: "cron/process-pending",
          pendingId: pending.id,
          userId,
          channel: pending.channel,
          ageMinutes,
        });
        pass6NoVm++;
        continue;
      }

      // ─── Rule 14 + Rule 33 guard (2026-06-10 audit): never wipe a working VM ──
      // Pass 6 selects purely on consumed_at IS NULL + age — NO health or
      // billing check. The Rule-33 trap state (configure's supplemental write
      // failed, leaving a HEALTHY, serving VM with consumed_at still NULL) means
      // a working / paying / billing_exempt user's VM could be irreversibly
      // wiped here. Before the (irreversible) wipe, confirm the owner truly
      // abandoned: skip if Stripe-verified paying (fail-CLOSED on unverifiable,
      // Rule 14) OR if the user has real recent activity (last_user_activity_at
      // within 7 days). The pending row stays claimed (consumed_at set above) —
      // a working user IS effectively settled; that just stops Pass 6 looping.
      const wipeBilling = await getBillingStatusVerified(supabase, getStripe(), vm.id);
      // Finding B (2026-06-11 audit): getBillingStatusVerified's internal
      // exempt-read is grant-side (verified discarded by classify), so for an
      // exempt-only user a transient blip yields isPaying=false. Direct verified
      // check so this irreversible wipe fails CLOSED on an unverifiable exemption.
      const wipeExempt = await fetchBillingExempt(supabase, vm.assigned_to);
      const lastActivityMs = vm.last_user_activity_at
        ? new Date(vm.last_user_activity_at).getTime()
        : 0;
      const recentlyActive =
        lastActivityMs > 0 && Date.now() - lastActivityMs < 7 * 24 * 60 * 60 * 1000;
      if (!wipeBilling || wipeBilling.isPaying || recentlyActive || !wipeExempt.verified) {
        logger.warn("Pass 6: WIPE SKIPPED — billing-protected / active / unverifiable (Rule-33 trap guard)", {
          route: "cron/process-pending",
          pendingId: pending.id,
          userId,
          vmId: vm.id,
          vmName: vm.name,
          isPaying: wipeBilling?.isPaying ?? null,
          recentlyActive,
          exemptVerified: wipeExempt.verified,
          reasons: wipeBilling?.reasons ?? ["unverifiable"],
        });
        pass6SkippedProtected++;
        continue;
      }

      // ─── Wipe the VM ──
      // wipeVMForNextUser is the same 15-step SSH-side wipe used by
      // the manual reclaim flow (lib/ssh.ts) — stops gateway, removes
      // workspace/sessions/backups/media/wallet state, kills browser
      // processes, clears bash history. Idempotent on retry.
      const wipeResult = await wipeVMForNextUser(vm as VMRecord);

      if (!wipeResult.success) {
        // Wipe failed. Quarantine the VM (status='failed') so it's
        // not picked up by the pool. Linode instance is still running
        // and billing until ops manually destroys it — but better
        // that than silently returning a VM with prior user's data
        // to the pool.
        logger.error("Pass 6: wipe failed; quarantining VM", {
          route: "cron/process-pending",
          pendingId: pending.id,
          vmId: vm.id,
          vmName: vm.name,
          userId,
          wipeError: wipeResult.error,
        });

        await supabase
          .from("instaclaw_vms")
          .update({
            status: "failed",
            health_status: "unhealthy",
            assigned_to: null,
            assigned_at: null,
            gateway_url: null,
            gateway_token: null,
            telegram_bot_token: null,
            telegram_bot_username: null,
            telegram_chat_id: null,
          })
          .eq("id", vm.id);

        // Reset user so they can retry with a fresh signup.
        await supabase
          .from("instaclaw_users")
          .update({ onboarding_complete: false, deployment_lock_at: null })
          .eq("id", userId);

        // Admin alert with paste-ready next steps. Best-effort —
        // don't let a Resend failure crash the cron.
        sendAdminAlertEmail(
          "[P1] Pass 6 reclaim wipe failed — VM quarantined",
          [
            `VM ${vm.name} (id=${vm.id}) wipe failed during Pass 6 reclaim.`,
            `Status set to 'failed' for safety. Linode instance still billing.`,
            ``,
            `User: ${userId}`,
            `Channel: ${pending.channel}`,
            `Age at reclaim: ${ageMinutes} min`,
            `Wipe error: ${wipeResult.error || "(no error message)"}`,
            ``,
            `Action required:`,
            `  1. SSH to ${vm.ip_address || "(no ip recorded)"}:`,
            `     ssh -i /tmp/ic_ssh_key openclaw@${vm.ip_address || "<ip>"}`,
            `  2. Inspect VM state, decide destroy vs recover.`,
            `  3. To destroy:`,
            `     curl -X DELETE -H "Authorization: Bearer $LINODE_API_TOKEN" \\`,
            `       "https://api.linode.com/v4/linode/instances/${vm.provider_server_id || "<id>"}"`,
          ].join("\n"),
        ).catch((err) => {
          logger.error("Pass 6: admin alert failed to send", {
            route: "cron/process-pending",
            error: String(err),
          });
        });

        pass6WipeFailed++;
        continue;
      }

      // ─── Wipe succeeded. Return VM to pool. ──
      // Matches Pass 2c's field-clearing surface so the recycled VM
      // doesn't carry per-user state into the next assignee.
      // Per spec §6.5.10: partner field cleared so a recycled Edge VM
      // doesn't carry Edge identity into a non-Edge next-user.
      await supabase
        .from("instaclaw_vms")
        .update({
          status: "ready",
          health_status: "healthy",
          assigned_to: null,
          assigned_at: null,
          gateway_url: null,
          gateway_token: null,
          configure_lock_at: null,
          configure_attempts: 0,
          telegram_bot_token: null,
          telegram_bot_username: null,
          telegram_chat_id: null,
          partner: null,
        })
        .eq("id", vm.id);

      // Reset user onboarding flags so they can retry cleanly.
      await supabase
        .from("instaclaw_users")
        .update({ onboarding_complete: false, deployment_lock_at: null })
        .eq("id", userId);

      logger.info("Pass 6: reclaimed abandoned VM", {
        route: "cron/process-pending",
        pendingId: pending.id,
        vmId: vm.id,
        vmName: vm.name,
        userId,
        channel: pending.channel,
        ageMinutes,
      });

      pass6Reclaimed++;
    }
  }

  return NextResponse.json({
    dryRun: dryRun || undefined,
    pass0: {
      recovered: pass0Recovered,
      // Preview is only populated in dryRun mode to keep normal responses lean.
      preview: dryRun ? pass0Preview : undefined,
      wouldRecover: dryRun ? pass0Preview.length : undefined,
    },
    pending: pending?.length ?? 0,
    assigned,
    retried,
    gatewayRetried,
    released,
    autoConfigured,
    stuckDeployFixed,
    cleaned,
    pass6: {
      reclaimed: pass6Reclaimed,
      wipeFailed: pass6WipeFailed,
      noVm: pass6NoVm,
      skippedRace: pass6SkippedRace,
      skippedProtected: pass6SkippedProtected,
    },
  });
}
