import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import { CLOUD_INIT_SENTINEL } from "@/lib/cloud-init";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Cron job: polls VMs stuck in "provisioning" status.
 *
 * SSHes into each as root (cloud-init runs as root, so root access is
 * available immediately; the "openclaw" user may not exist yet) and
 * checks for the cloud-init sentinel file. When found, flips the VM
 * status to "ready" so it can be assigned to users.
 *
 * Schedule: every 2 minutes via Vercel cron or external cron service.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Find all VMs still in "provisioning" status
  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, name, provider, created_at")
    .eq("status", "provisioning");

  if (error) {
    logger.error("Failed to query provisioning VMs", {
      error: error.message,
      route: "cron/cloud-init-poll",
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!vms || vms.length === 0) {
    return NextResponse.json({
      checked: 0,
      ready: 0,
      message: "No VMs in provisioning status",
    });
  }

  // Skip VMs older than 30 minutes — something went wrong, don't keep polling
  const MAX_AGE_MS = 30 * 60 * 1000;
  const now = Date.now();

  const toCheck = vms.filter((vm) => {
    const age = now - new Date(vm.created_at).getTime();
    if (age > MAX_AGE_MS) {
      logger.warn("Provisioning VM exceeded 30 min — marking as failed", {
        route: "cron/cloud-init-poll",
        vmId: vm.id,
        name: vm.name,
        ageMinutes: Math.round(age / 60_000),
      });
      // Mark as failed so we stop polling
      supabase
        .from("instaclaw_vms")
        .update({ status: "failed" })
        .eq("id", vm.id)
        .then(() => {});
      return false;
    }
    return true;
  });

  if (toCheck.length === 0) {
    return NextResponse.json({
      checked: 0,
      ready: 0,
      timedOut: vms.length,
      message: "All provisioning VMs timed out (>30 min)",
    });
  }

  if (!process.env.SSH_PRIVATE_KEY_B64) {
    logger.error("SSH_PRIVATE_KEY_B64 not set — cannot poll VMs", {
      route: "cron/cloud-init-poll",
    });
    return NextResponse.json(
      { error: "SSH key not configured" },
      { status: 500 }
    );
  }

  // Dynamic import to avoid bundling issues
  const { NodeSSH } = await import("node-ssh");
  const privateKey = Buffer.from(
    process.env.SSH_PRIVATE_KEY_B64,
    "base64"
  ).toString("utf-8");

  let readyCount = 0;
  const results: { name: string; status: string }[] = [];

  // Check each VM in parallel (bounded)
  await Promise.all(
    toCheck.map(async (vm) => {
      const ssh = new NodeSSH();
      try {
        // SSH as root — the openclaw user may not exist yet during cloud-init
        await ssh.connect({
          host: vm.ip_address,
          port: 22,
          username: "root",
          privateKey,
          readyTimeout: 10_000,
        });

        const result = await ssh.execCommand(
          `test -f ${CLOUD_INIT_SENTINEL} && echo READY || echo PENDING`
        );

        if (result.stdout.trim() === "READY") {
          // Cloud-init finished — flip to ready
          await supabase
            .from("instaclaw_vms")
            .update({ status: "ready" })
            .eq("id", vm.id);

          logger.info("VM cloud-init complete, status → ready", {
            route: "cron/cloud-init-poll",
            vmId: vm.id,
            name: vm.name,
            ip: vm.ip_address,
          });

          readyCount++;
          results.push({ name: vm.name, status: "ready" });
        } else {
          results.push({ name: vm.name, status: "pending" });
        }
      } catch (err) {
        // SSH not available yet — VM still booting, that's normal
        logger.info("SSH not ready yet for provisioning VM", {
          route: "cron/cloud-init-poll",
          vmId: vm.id,
          name: vm.name,
          error: err instanceof Error ? err.message : String(err),
        });
        results.push({ name: vm.name, status: "ssh_unavailable" });
      } finally {
        ssh.dispose();
      }
    })
  );

  return NextResponse.json({
    checked: toCheck.length,
    ready: readyCount,
    results,
  });
}
