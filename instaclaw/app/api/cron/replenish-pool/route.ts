import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";
import { AlertCollector } from "@/lib/admin-alert";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import {
  linodeProvider,
  listInstanceLabelsMatching,
} from "@/lib/providers/linode";
import { getNextVmNumber, formatVmName } from "@/lib/providers/hetzner";
import { checkDuplicateIP } from "@/lib/ssh";
import {
  decideAction,
  type PoolConfig,
  type PoolState,
} from "@/lib/replenish-pool-logic";

// Vercel cron config
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min ceiling — covers worst-case 10 VMs

// ─── Constants ─────────────────────────────────────────────────────────────

const CRON_NAME = "replenish-pool";
// Lock TTL must EXCEED maxDuration so the lock cannot expire while a slow run
// is still in progress (which would let the next cron acquire and start a
// concurrent batch). 360 > 300 = maxDuration with 60s of headroom.
const LOCK_TTL_SECONDS = 360;
const STUCK_THRESHOLD_MINUTES = 15;

// ─── Config (env-overridable) ──────────────────────────────────────────────

const CONFIG: PoolConfig = {
  POOL_FLOOR: parseInt(process.env.POOL_FLOOR ?? "10", 10),
  POOL_TARGET: parseInt(process.env.POOL_TARGET ?? "15", 10),
  POOL_CEILING: parseInt(process.env.POOL_CEILING ?? "30", 10),
  POOL_CRITICAL: parseInt(process.env.POOL_CRITICAL ?? "3", 10),
  MAX_PER_RUN: parseInt(process.env.MAX_PER_RUN ?? "10", 10),
  MAX_TOTAL_VMS: parseInt(process.env.MAX_TOTAL_VMS ?? "500", 10),
};

// ─── Route handler ─────────────────────────────────────────────────────────

interface ProvisionResult {
  name: string;
  ip: string;
  providerId: string;
}

export async function GET(req: NextRequest) {
  // 1. Auth — same Bearer pattern as all other crons
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Required env validation — fail loud if misconfigured
  if (!process.env.LINODE_SNAPSHOT_ID || !process.env.LINODE_API_TOKEN) {
    logger.error("replenish-pool: missing required env vars", {
      route: "cron/replenish-pool",
      hasSnapshotId: !!process.env.LINODE_SNAPSHOT_ID,
      hasToken: !!process.env.LINODE_API_TOKEN,
    });
    return NextResponse.json(
      { error: "Missing LINODE_SNAPSHOT_ID or LINODE_API_TOKEN" },
      { status: 500 }
    );
  }

  // 3. Distributed lock
  const lockAcquired = await tryAcquireCronLock(CRON_NAME, LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    logger.info("replenish-pool: lock held, skipping", {
      route: "cron/replenish-pool",
    });
    return NextResponse.json({ skipped: "lock_held" });
  }

  try {
    // 4. Read pool state from DB
    const state = await readPoolState();

    // 5. Decide what to do (pure function, easy to reason about)
    const decision = decideAction(state, CONFIG);

    // 6. Always log status, regardless of action
    logger.info("replenish-pool: status", {
      route: "cron/replenish-pool",
      ready: state.ready,
      provisioning: state.provisioning,
      total: state.total,
      stuckCount: state.stuckProvisioning.length,
      action: decision.action,
      toProvision: decision.toProvision,
      reason: decision.reason,
      critical: decision.criticalAlert,
    });

    // 7. Critical alert (independent of action)
    if (decision.criticalAlert) {
      try {
        await sendAdminAlertEmail(
          "Pool CRITICAL — Ready VMs Depleted",
          `Ready VM pool dropped to ${state.ready} (critical threshold: ${CONFIG.POOL_CRITICAL}).\n\n` +
            `Pool state:\n` +
            `  ready:        ${state.ready}\n` +
            `  provisioning: ${state.provisioning}\n` +
            `  total active: ${state.total}\n\n` +
            `Action: ${decision.action}\n` +
            `Reason: ${decision.reason}`
        );
      } catch (err) {
        logger.error("replenish-pool: critical alert send failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 8. Cost ceiling alert — pool needs replenishing but we can't provision more
    if (decision.action === "skip_cap") {
      try {
        await sendAdminAlertEmail(
          "Pool Replenish Blocked: Cost Ceiling Reached",
          `Cannot provision more VMs — total active VMs (${state.total}) ` +
            `at or near MAX_TOTAL_VMS (${CONFIG.MAX_TOTAL_VMS}).\n\n` +
            `Pool state:\n` +
            `  ready:        ${state.ready}\n` +
            `  provisioning: ${state.provisioning}\n` +
            `  total active: ${state.total}\n` +
            `  ceiling:      ${CONFIG.MAX_TOTAL_VMS}\n\n` +
            `Reason: ${decision.reason}\n\n` +
            `Either increase MAX_TOTAL_VMS env var or reclaim unused VMs.`
        );
      } catch (err) {
        logger.error("replenish-pool: cost ceiling alert send failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 9. Stuck VM alert
    if (state.stuckProvisioning.length > 0) {
      try {
        const stuckList = state.stuckProvisioning
          .map((s) => `  - ${s.name} (${s.minutesOld} min old)`)
          .join("\n");
        await sendAdminAlertEmail(
          "Stuck Provisioning VMs Detected",
          `${state.stuckProvisioning.length} VMs stuck in 'provisioning' status >${STUCK_THRESHOLD_MINUTES} min.\n\n` +
            `Replenish-pool is REFUSING to provision more until these are resolved\n` +
            `(prevents pile-on if cloud-init is broken or networking is down).\n\n` +
            `Stuck VMs:\n${stuckList}\n\n` +
            `Investigate: SSH into one and check cloud-init logs.`
        );
      } catch (err) {
        logger.error("replenish-pool: stuck alert send failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 10. Provision if decided
    //     The AlertCollector groups per-VM provision failures across this
    //     cron tick so the operator gets ONE digest email (+ a row in
    //     instaclaw_admin_alert_log) instead of N silent fire-and-forget
    //     emails — that was the 2026-05-12 visibility gap: vm-925 collision
    //     fired the catch block 8x/tick × 288 ticks/day with zero alerts
    //     landing in the dedup log because bare sendAdminAlertEmail() in a
    //     fire-and-forget pattern doesn't write to the log table.
    const alerts = new AlertCollector();
    let provisioned: ProvisionResult[] = [];
    if (decision.action === "provision") {
      provisioned = await provisionVMs(decision.toProvision, alerts);
    }
    // Flush the digest BEFORE returning (and before releaseCronLock — so
    // alerts are visible whether the lock release succeeds or not).
    await alerts.flush().catch((err) => {
      logger.error("replenish-pool: alert flush failed", {
        route: "cron/replenish-pool",
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return NextResponse.json({
      pool: state,
      decision,
      provisioned,
    });
  } catch (err) {
    logger.error("replenish-pool: unhandled error", {
      route: "cron/replenish-pool",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  } finally {
    // 11. Always release the lock
    await releaseCronLock(CRON_NAME);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function readPoolState(): Promise<PoolState> {
  const supabase = getSupabase();

  // Ready Linode VMs (the actual pool)
  const { count: readyCount } = await supabase
    .from("instaclaw_vms")
    .select("*", { count: "exact", head: true })
    .eq("status", "ready")
    .eq("provider", "linode");

  // Provisioning VMs — fetch full rows so we can detect stuck ones
  const { data: provisioningVms } = await supabase
    .from("instaclaw_vms")
    .select("name, created_at")
    .eq("status", "provisioning");

  // Total active VMs (cost ceiling)
  const { count: totalCount } = await supabase
    .from("instaclaw_vms")
    .select("*", { count: "exact", head: true })
    .not("status", "in", "(terminated,destroyed,failed)");

  const now = Date.now();
  const stuckThresholdMs = STUCK_THRESHOLD_MINUTES * 60 * 1000;

  const stuckProvisioning = (provisioningVms ?? [])
    .map((vm) => ({
      name: vm.name ?? "unknown",
      ageMs: now - new Date(vm.created_at).getTime(),
    }))
    .filter((vm) => vm.ageMs > stuckThresholdMs)
    .map(({ name, ageMs }) => ({
      name,
      minutesOld: Math.round(ageMs / 60000),
    }));

  return {
    ready: readyCount ?? 0,
    provisioning: provisioningVms?.length ?? 0,
    total: totalCount ?? 0,
    stuckProvisioning,
  };
}

async function provisionVMs(
  count: number,
  alerts: AlertCollector
): Promise<ProvisionResult[]> {
  const supabase = getSupabase();
  const provisioned: ProvisionResult[] = [];

  // Find the next available VM number.
  //
  // Universe = DB names ∪ Linode-side labels. Pre-2026-05-12 this was
  // DB-only and an orphan Linode instance (live in Linode, missing from DB)
  // would cause every cron tick to pick a colliding name and 400 on the
  // Linode side. vm-925 (Linode id=97369836) blocked the pool for 3 days
  // before we found it. Merging Linode labels here makes that class of
  // collision structurally impossible.
  const { data: existingVms } = await supabase
    .from("instaclaw_vms")
    .select("name")
    .order("created_at", { ascending: false })
    .limit(2000);
  const dbNames = (existingVms ?? []).map(
    (v: { name: string | null }) => v.name
  );

  let linodeLabels: string[] = [];
  try {
    linodeLabels = await listInstanceLabelsMatching(/^instaclaw-vm-\d+$/);
  } catch (err) {
    // Falling back to DB-only naming is the pre-fix behavior; the worst case
    // is the original bug pattern, which is no worse than not fixing it.
    logger.warn(
      "replenish-pool: failed to list Linode labels; falling back to DB-only naming",
      {
        route: "cron/replenish-pool",
        error: err instanceof Error ? err.message : String(err),
      }
    );
    alerts.add(
      "Replenish-Pool: Linode Label Listing Failed",
      "n/a",
      `Could not enumerate Linode-side labels for name-collision defense. ` +
        `Falling back to DB-only naming for this tick. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  const allKnownNames = [...dbNames, ...linodeLabels];
  const startNum = getNextVmNumber(allKnownNames);

  for (let i = 0; i < count; i++) {
    const vmName = formatVmName(startNum + i);

    try {
      // Use the existing linodeProvider abstraction — already handles
      // snapshot lookup, SSH key, firewall, user_data, tags.
      const created = await linodeProvider.createServer({ name: vmName });

      // Duplicate IP guard — Linode recycles IPs and we've been bitten before
      const { duplicates } = await checkDuplicateIP(created.ip);
      if (duplicates.length > 0) {
        const desc = duplicates
          .map(
            (d: { name: string | null; id: string; status: string }) =>
              `${d.name ?? d.id} (${d.status})`
          )
          .join(", ");
        logger.error("replenish-pool: DUPLICATE_IP, skipping insert", {
          route: "cron/replenish-pool",
          vmName,
          ip: created.ip,
          existingVms: desc,
        });
        alerts.add(
          "Replenish-Pool: Duplicate IP Blocked",
          vmName,
          `Tried to insert ${vmName} with IP ${created.ip}, but it's already used by: ${desc}.\n` +
            `The Linode was created but NOT inserted into the DB. Manual cleanup needed:\n` +
            `  - Linode ID: ${created.providerId}\n` +
            `  - IP: ${created.ip}`
        );
        continue; // try the next VM
      }

      // Insert into DB as "provisioning" — cloud-init-poll will flip to "ready"
      const { error: insertError } = await supabase
        .from("instaclaw_vms")
        .insert({
          name: vmName,
          ip_address: created.ip,
          provider_server_id: created.providerId,
          provider: "linode",
          ssh_port: 22,
          ssh_user: "openclaw",
          status: "provisioning",
          region: created.region,
          server_type: created.serverType,
        });

      if (insertError) {
        logger.error("replenish-pool: DB insert failed", {
          route: "cron/replenish-pool",
          vmName,
          error: insertError.message,
        });
        alerts.add(
          "Replenish-Pool: DB Insert Failed",
          vmName,
          `Linode created ${vmName} but DB insert failed.\n` +
            `Error: ${insertError.message}\n` +
            `Linode ID: ${created.providerId}\n` +
            `IP: ${created.ip}\n` +
            `This is an orphan — manual cleanup needed.`
        );
        // Abort batch to prevent cascading orphans
        break;
      }

      provisioned.push({
        name: vmName,
        ip: created.ip,
        providerId: created.providerId,
      });

      logger.info("replenish-pool: provisioned VM", {
        route: "cron/replenish-pool",
        vmName,
        ip: created.ip,
        providerId: created.providerId,
      });

      // Brief pause to avoid Linode rate limits
      if (i < count - 1) {
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("replenish-pool: provision failed", {
        route: "cron/replenish-pool",
        vmName,
        error: msg,
      });
      // Linode "Label must be unique among your linodes" — defensive
      // continue path: no Linode side-effect occurred (label collision
      // happens BEFORE provisioning), so there's no orphan risk. The
      // upstream merge with Linode labels in the name generator should
      // make this unreachable, but if a race creates a same-named instance
      // between our list call and our create call, we don't want to abort
      // the whole batch over a single name.
      const isLabelCollision = /label must be unique/i.test(msg);
      if (isLabelCollision) {
        alerts.add(
          "Replenish-Pool: Label Collision (continued)",
          vmName,
          `${vmName} already exists on Linode but not in our DB — orphan. ` +
            `Skipped this name and continuing to the next.\n` +
            `Error: ${msg.slice(0, 300)}`
        );
        continue;
      }
      alerts.add(
        "Replenish-Pool: Linode API Failure",
        vmName,
        `Failed to provision ${vmName} via Linode API.\n` +
          `Error: ${msg.slice(0, 400)}\n` +
          `Replenish-pool aborted this batch. Provisioned ${provisioned.length} of ${count} before failure.`
      );
      // Abort batch on truly unknown errors to prevent cascade
      break;
    }
  }

  return provisioned;
}
