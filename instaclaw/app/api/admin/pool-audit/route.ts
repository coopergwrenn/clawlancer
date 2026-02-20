import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { checkSSHConnectivity } from "@/lib/ssh";
import { validateAdminKey } from "@/lib/security";
import { logger } from "@/lib/logger";

export const maxDuration = 300;

const CONCURRENCY = 25;
const SSH_TIMEOUT_OVERRIDE = 5_000; // 5s — faster than default 10s for bulk audit

export async function POST(req: NextRequest) {
  if (!validateAdminKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Get all ready (unassigned) VMs
  const { data: vms, error } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, name")
    .eq("status", "ready")
    .order("name", { ascending: true });

  if (error || !vms) {
    return NextResponse.json({ error: "Failed to fetch VMs" }, { status: 500 });
  }

  const alive: string[] = [];
  const dead: string[] = [];
  const deadDetails: { id: string; name: string; ip: string }[] = [];

  // Process in batches of CONCURRENCY
  for (let i = 0; i < vms.length; i += CONCURRENCY) {
    const batch = vms.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (vm) => {
        const ok = await checkSSHConnectivity({
          id: vm.id,
          ip_address: vm.ip_address,
          ssh_port: vm.ssh_port ?? 22,
          ssh_user: vm.ssh_user ?? "openclaw",
        });
        return { vm, ok };
      })
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value.ok) {
        alive.push(result.value.vm.name);
      } else {
        const vm = result.status === "fulfilled" ? result.value.vm : null;
        if (vm) {
          dead.push(vm.name);
          deadDetails.push({ id: vm.id, name: vm.name, ip: vm.ip_address });
        }
      }
    }
  }

  // Quarantine dead VMs
  if (deadDetails.length > 0) {
    for (const d of deadDetails) {
      await supabase
        .from("instaclaw_vms")
        .update({
          status: "failed" as const,
          health_status: "unhealthy",
        })
        .eq("id", d.id);
    }

    logger.error("Pool audit: quarantined dead VMs", {
      route: "admin/pool-audit",
      count: deadDetails.length,
      vms: deadDetails.map((d) => `${d.name} (${d.ip})`),
    });
  }

  const summary = {
    total: vms.length,
    alive: alive.length,
    dead: dead.length,
    deadVMs: deadDetails,
    alivePercentage: `${((alive.length / vms.length) * 100).toFixed(1)}%`,
  };

  logger.info("Pool audit complete", { route: "admin/pool-audit", ...summary });

  return NextResponse.json(summary);
}
