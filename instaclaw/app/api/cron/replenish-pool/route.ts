import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { linodeProvider } from "@/lib/providers/linode";
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
    let provisioned: ProvisionResult[] = [];
    if (decision.action === "provision") {
      provisioned = await provisionVMs(decision.toProvision);
    }

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

async function provisionVMs(count: number): Promise<ProvisionResult[]> {
  const supabase = getSupabase();
  const provisioned: ProvisionResult[] = [];

  // Find the next available VM number
  const { data: existingVms } = await supabase
    .from("instaclaw_vms")
    .select("name")
    .order("created_at", { ascending: false })
    .limit(500);
  const existingNames = (existingVms ?? []).map(
    (v: { name: string | null }) => v.name
  );
  const startNum = getNextVmNumber(existingNames);

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
        // Don't await — fire and forget alert
        sendAdminAlertEmail(
          "Replenish-Pool: Duplicate IP Blocked",
          `Tried to insert ${vmName} with IP ${created.ip}, but it's already used by: ${desc}.\n\n` +
            `The Linode was created but NOT inserted into the DB. Manual cleanup needed:\n` +
            `  - Linode ID: ${created.providerId}\n` +
            `  - IP: ${created.ip}`
        ).catch(() => {});
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
        sendAdminAlertEmail(
          "Replenish-Pool: DB Insert Failed",
          `Linode created ${vmName} but DB insert failed.\n\n` +
            `Error: ${insertError.message}\n` +
            `Linode ID: ${created.providerId}\n` +
            `IP: ${created.ip}\n\n` +
            `This is an orphan — manual cleanup needed.`
        ).catch(() => {});
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
      logger.error("replenish-pool: provision failed", {
        route: "cron/replenish-pool",
        vmName,
        error: err instanceof Error ? err.message : String(err),
      });
      sendAdminAlertEmail(
        "Replenish-Pool: Linode API Failure",
        `Failed to provision ${vmName} via Linode API.\n\n` +
          `Error: ${err instanceof Error ? err.message : String(err)}\n\n` +
          `Replenish-pool aborted this batch. Provisioned ${provisioned.length} of ${count} before failure.`
      ).catch(() => {});
      // Abort batch on first error to prevent cascade
      break;
    }
  }

  return provisioned;
}
