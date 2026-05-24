import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { assignOrProvisionUserVm } from "@/lib/createUserVM";
import { logger } from "@/lib/logger";
import { logOnboardingEvent } from "@/lib/onboarding-events";
import { provisionBankrWallet } from "@/lib/bankr-provision";
import { provisionCdpWallet } from "@/lib/cdp-wallet";
import { sendAdminAlertEmail } from "@/lib/email";

export async function POST(req: NextRequest) {
  try {
    // Dual auth: NextAuth session OR X-Mini-App-Token
    const session = await auth();
    let targetUserId = session?.user?.id;
    let isMiniApp = false;

    if (!targetUserId) {
      const { validateMiniAppToken } = await import("@/lib/security");
      targetUserId = await validateMiniAppToken(req) ?? undefined;
      isMiniApp = !!targetUserId;
    }

    if (!targetUserId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // If from mini app, also accept userId from body (with match enforcement)
    if (isMiniApp) {
      try {
        const body = await req.clone().json();
        if (body.userId && body.userId !== targetUserId) {
          return NextResponse.json({ error: "userId mismatch" }, { status: 403 });
        }
      } catch { /* no body — fine */ }
    }

    const supabase = getSupabase();

    // C9 FIX (revised): Detect trial abuse via World ID nullifier matching.
    // - First-time trial signups are ALWAYS allowed (zero friction).
    // - If user has World ID, check if another account with the same nullifier
    //   already had a trial/subscription → block (same human, second trial).
    // - If user has no World ID, allow (can't detect abuse, that's the tradeoff).
    if (!isMiniApp) {
      const { data: subscription } = await supabase
        .from("instaclaw_subscriptions")
        .select("status")
        .eq("user_id", targetUserId)
        .single();

      // Standard subscription check first
      if (!subscription || !["active", "trialing"].includes(subscription.status)) {
        return NextResponse.json(
          { error: "Active subscription required. Please subscribe to a plan first." },
          { status: 403 }
        );
      }

      // Trial abuse detection: only for trialing users with World ID
      if (subscription.status === "trialing") {
        const { data: user } = await supabase
          .from("instaclaw_users")
          .select("world_id_verified, world_id_nullifier_hash")
          .eq("id", targetUserId)
          .single();

        if (user?.world_id_verified && user?.world_id_nullifier_hash) {
          // Check if any OTHER account with this nullifier already had a subscription
          const { data: otherAccounts } = await supabase
            .from("instaclaw_users")
            .select("id")
            .eq("world_id_nullifier_hash", user.world_id_nullifier_hash)
            .neq("id", targetUserId);

          if (otherAccounts && otherAccounts.length > 0) {
            // Check if any of those other accounts ever had a subscription
            const otherIds = otherAccounts.map((a) => a.id);
            const { data: otherSubs } = await supabase
              .from("instaclaw_subscriptions")
              .select("user_id, status")
              .in("user_id", otherIds);

            if (otherSubs && otherSubs.length > 0) {
              logger.warn("Trial abuse detected: same World ID nullifier on multiple accounts", {
                route: "vm/assign",
                userId: targetUserId,
                nullifier: user.world_id_nullifier_hash.slice(0, 12) + "...",
                otherAccountCount: otherAccounts.length,
              });
              return NextResponse.json(
                { error: "A trial has already been used with this identity. Please subscribe to continue." },
                { status: 403 }
              );
            }
          }
        }
        // No World ID or no matching accounts → first-time trial, allow through
      }
    }

    // Mini app users skip subscription check (they pay with WLD)

    // Check if user already has a VM
    const { data: existing } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, gateway_url, control_ui_url, status")
      .eq("assigned_to", targetUserId)
      .single();

    if (existing) {
      return NextResponse.json({
        assigned: true,
        vm: existing,
      });
    }

    // ── Phase 1B-1: assignment goes through assignOrProvisionUserVm. ──
    // Flag-gated branch between pool path (legacy) and cloud-init path
    // (per CLOUD_INIT_ONDEMAND_ENABLED). Throws on permanent / transient
    // errors; caller's try/catch normalizes both to "no VMs available".
    let assignResult: Awaited<ReturnType<typeof assignOrProvisionUserVm>> = null;
    try {
      assignResult = await assignOrProvisionUserVm(targetUserId, { supabase });
    } catch (assignErr) {
      logger.error("vm/assign: assignOrProvisionUserVm threw — returning queued response", {
        route: "vm/assign",
        userId: targetUserId,
        error: assignErr instanceof Error ? assignErr.message : String(assignErr),
      });
      // assignResult stays null → returns assigned:false below.
    }

    if (!assignResult) {
      return NextResponse.json({
        assigned: false,
        message: "No VMs available. You've been added to the queue.",
      });
    }

    // Keep the `vm` name alive for the downstream code that references it
    // (initial credits, onboarding event, Bankr provision). The compatibility
    // shim is intentional — minimizes the diff and risk in this load-bearing
    // WLD mini-app path.
    const vm = assignResult.vm;

    // Set initial credits if provided (from WLD delegation) — use RPC for audit trail
    try {
      const body = await req.clone().json().catch(() => ({}));
      if (body.initialCredits && typeof body.initialCredits === "number") {
        const { error: creditErr } = await supabase.rpc("instaclaw_add_credits", {
          p_vm_id: vm.id,
          p_credits: body.initialCredits,
          p_reference_id: `initial_wld_${targetUserId}`,
          p_source: "wld",
        });
        if (creditErr) {
          // Fallback if p_source not yet supported
          if (creditErr.message?.includes("p_source")) {
            await supabase.rpc("instaclaw_add_credits", {
              p_vm_id: vm.id,
              p_credits: body.initialCredits,
              p_reference_id: `initial_wld_${targetUserId}`,
            });
          } else {
            logger.error("Initial credits RPC failed, falling back to direct update", {
              error: String(creditErr), vmId: vm.id, route: "vm/assign",
            });
            await supabase.from("instaclaw_vms")
              .update({ credit_balance: body.initialCredits })
              .eq("id", vm.id);
          }
        }
        logger.info("Initial credits set on new VM", {
          vmId: vm.id,
          credits: body.initialCredits,
          route: "vm/assign",
        });
      }
    } catch { /* body parse failed — fine, no credits */ }

    // Onboarding journey event: a fresh VM has been bound to this user.
    // Only fires on NEW assignment (the existing-VM short-circuit above
    // returns early without reaching here).
    await logOnboardingEvent({
      userId: targetUserId,
      eventType: "vm_assigned",
      vmId: vm.id,
      metadata: {
        vm_name: (vm as { name?: string }).name ?? null,
        is_mini_app: isMiniApp,
      },
    });

    // Provision Bankr wallet for this agent. Mirrors the Stripe webhook
    // path (app/api/billing/webhook/route.ts) so mini-app signups (which
    // never go through Stripe) also get an InstaClaw-managed Bankr wallet.
    // Without this, a 79% fleet coverage gap built up over months —
    // every mini-app user ended up agent-less for token launches and
    // had to either give up or `bankr login` with a personal user-key
    // that lacks token-launch permissions (403s on the launch endpoint).
    //
    // Idempotency key `instaclaw_user_${userId}` means re-runs (any path,
    // any retry) return the SAME wallet via Bankr's 409 → success flow.
    // Non-fatal: returns null on Bankr API hiccup or missing partner key;
    // the every-30-min /api/cron/provision-missing-bankr-wallets safety
    // net catches anything that slipped through.
    //
    // Post-assignment ownership re-check mirrors the webhook's pattern
    // — guards against the (very narrow) race where two assigns happen
    // for the same user concurrently and the row's owner gets reassigned
    // mid-call. We refuse to provision a wallet for a user who isn't
    // actually the row's owner anymore.
    try {
      const { data: assignedCheck } = await supabase
        .from("instaclaw_vms")
        .select("assigned_to, ip_address")
        .eq("id", vm.id)
        .single();

      if (assignedCheck?.assigned_to !== targetUserId) {
        logger.error("CRITICAL: VM ownership mismatch in /api/vm/assign — skipping bankr provision", {
          route: "vm/assign",
          userId: targetUserId,
          vmId: vm.id,
          actualOwner: assignedCheck?.assigned_to,
        });
        sendAdminAlertEmail(
          "VM ownership race in /api/vm/assign",
          `VM ${vm.id} was assigned to ${targetUserId} but immediately re-read shows owner=${assignedCheck?.assigned_to}. Bankr provisioning skipped — manual reconciliation needed.`
        ).catch(() => {});
      } else if (assignedCheck.ip_address) {
        // ── CDP backup wallet (runs FIRST as reliable baseline) ──
        // Coinbase Developer Platform MPC wallet — server-managed.
        // Independent of Bankr; runs even during Bankr maintenance so
        // every agent always has a working EVM receive address. The
        // address is written to ~/.openclaw/.env + WALLET.md by the
        // downstream configureOpenClaw / cloud-init tarball.
        //
        // Idempotent: provisionCdpWallet SELECTs cdp_wallet_address
        // FIRST and short-circuits if present (CDP has no idempotency
        // key like Bankr's 409; re-runs would orphan accounts).
        //
        // Wrapped in its own try/catch so a CDP failure NEVER blocks
        // Bankr provisioning. Cron safety net (provision-missing-
        // cdp-wallets) catches anything that slipped through.
        try {
          await provisionCdpWallet({
            vmId: vm.id,
            userId: targetUserId,
          });
        } catch (cdpErr) {
          logger.error("CDP backup wallet provision failed in /api/vm/assign (non-fatal)", {
            route: "vm/assign",
            error: cdpErr instanceof Error ? cdpErr.message : String(cdpErr),
            vmId: vm.id,
            userId: targetUserId,
          });
          // Non-fatal: cron safety net catches on next cycle. Continue
          // to Bankr provisioning regardless.
        }

        await provisionBankrWallet({
          vmId: vm.id,
          userId: targetUserId,
          vmIp: assignedCheck.ip_address,
          idempotencyKey: `instaclaw_user_${targetUserId}`,
        });
      }
    } catch (provisionErr) {
      logger.error("Bankr provision failed in /api/vm/assign (non-fatal)", {
        route: "vm/assign",
        error: provisionErr instanceof Error ? provisionErr.message : String(provisionErr),
        vmId: vm.id,
        userId: targetUserId,
      });
      // Non-fatal: cron safety net catches it on the next cycle.
    }

    return NextResponse.json({ assigned: true, vm });
  } catch (err) {
    logger.error("VM assign error", { error: String(err), route: "vm/assign" });
    return NextResponse.json(
      { error: "Failed to assign VM" },
      { status: 500 }
    );
  }
}
