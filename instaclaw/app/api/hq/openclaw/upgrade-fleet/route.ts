import { NextRequest, NextResponse } from "next/server";
import { verifyHQAuth } from "@/lib/hq-auth";
import { getSupabase } from "@/lib/supabase";
import { upgradeOpenClaw, connectSSH, NVM_PREAMBLE } from "@/lib/ssh";
import type { VMRecord } from "@/lib/ssh";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

const BATCH_SIZE = 5;
const BATCH_PAUSE_MS = 10000;

export async function POST(req: NextRequest) {
  if (!(await verifyHQAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { version, canaryVmId } = await req.json();
  if (!version || typeof version !== "string") {
    return NextResponse.json({ error: "version required" }, { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(new TextEncoder().encode(sseEvent(data)));
      };

      try {
        // Query all assigned VMs
        send({ step: "query_vms", status: "running", detail: "Fetching fleet..." });
        const supabase = getSupabase();
        const { data: vms, error } = await supabase
          .from("instaclaw_vms")
          .select("id, ip_address, ssh_port, ssh_user, assigned_to")
          .not("assigned_to", "is", null);

        if (error || !vms) {
          send({ step: "query_vms", status: "error", error: error?.message ?? "No VMs found" });
          controller.close();
          return;
        }

        // Filter out canary VM (already upgraded)
        const fleetVms = canaryVmId
          ? vms.filter((vm) => vm.id !== canaryVmId)
          : vms;

        send({
          step: "query_vms",
          status: "done",
          detail: `${fleetVms.length} VMs to upgrade (${vms.length} total, ${canaryVmId ? "1 canary skipped" : "no canary skip"})`,
        });

        let upgraded = 0;
        let skipped = 0;
        let failed = 0;
        const failedVms: { id: string; error: string }[] = [];

        // Process in batches
        const totalBatches = Math.ceil(fleetVms.length / BATCH_SIZE);
        for (let b = 0; b < totalBatches; b++) {
          const batch = fleetVms.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
          send({
            step: "batch",
            status: "running",
            batchNum: b + 1,
            totalBatches,
            detail: `Batch ${b + 1}/${totalBatches}: starting ${batch.length} VMs`,
          });

          // Process each VM in the batch sequentially for SSH stability
          for (const vm of batch) {
            send({
              step: "vm_upgrade",
              status: "running",
              vmId: vm.id,
              ip: vm.ip_address,
              detail: `Checking version on ${vm.ip_address}...`,
            });

            try {
              // Check current version first
              const ssh = await connectSSH(vm as VMRecord);
              let currentVersion = "unknown";
              try {
                const vResult = await ssh.execCommand(
                  `${NVM_PREAMBLE} && openclaw --version`,
                );
                currentVersion = vResult.stdout.trim();
              } finally {
                ssh.dispose();
              }

              // Skip if already on target version
              if (currentVersion.includes(version)) {
                skipped++;
                send({
                  step: "vm_upgrade",
                  status: "skipped",
                  vmId: vm.id,
                  ip: vm.ip_address,
                  detail: `Already on ${version}`,
                });
                continue;
              }

              // Upgrade
              const result = await upgradeOpenClaw(
                vm as VMRecord,
                version,
                (msg) => {
                  send({
                    step: "vm_upgrade",
                    status: "running",
                    vmId: vm.id,
                    ip: vm.ip_address,
                    detail: msg,
                  });
                },
              );

              if (result.success) {
                upgraded++;
                send({
                  step: "vm_upgrade",
                  status: "done",
                  vmId: vm.id,
                  ip: vm.ip_address,
                  detail: "Upgraded successfully",
                });
              } else {
                failed++;
                failedVms.push({ id: vm.id, error: result.error ?? "Unknown error" });
                send({
                  step: "vm_upgrade",
                  status: "error",
                  vmId: vm.id,
                  ip: vm.ip_address,
                  error: result.error,
                });
              }
            } catch (err) {
              failed++;
              const errMsg = err instanceof Error ? err.message : String(err);
              failedVms.push({ id: vm.id, error: errMsg });
              send({
                step: "vm_upgrade",
                status: "error",
                vmId: vm.id,
                ip: vm.ip_address,
                error: errMsg,
              });
            }
          }

          send({
            step: "batch",
            status: "done",
            batchNum: b + 1,
            totalBatches,
            detail: `Batch ${b + 1}/${totalBatches} complete`,
            upgraded,
            skipped,
            failed,
          });

          // Pause between batches (except the last)
          if (b < totalBatches - 1) {
            send({ step: "batch_pause", status: "running", detail: "Pausing 10s before next batch..." });
            await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
          }
        }

        // Version sweep — verify all VMs
        send({ step: "sweep", status: "running", detail: "Running version sweep..." });
        let sweepMatched = 0;
        let sweepMismatched = 0;
        for (const vm of vms) {
          try {
            const ssh = await connectSSH(vm as VMRecord);
            try {
              const desc = await ssh.execCommand(
                "systemctl --user show openclaw-gateway -p Description --value",
              );
              if (desc.stdout.includes(version)) {
                sweepMatched++;
              } else {
                sweepMismatched++;
              }
            } finally {
              ssh.dispose();
            }
          } catch {
            sweepMismatched++;
          }
        }

        send({
          step: "sweep",
          status: "done",
          detail: `Sweep: ${sweepMatched}/${vms.length} on v${version}`,
          sweepMatched,
          sweepMismatched,
        });

        // Final summary
        send({
          step: "complete",
          status: "done",
          upgraded,
          skipped,
          failed,
          failedVms,
          totalVms: vms.length,
          detail: `Fleet upgrade complete: ${upgraded} upgraded, ${skipped} skipped, ${failed} failed`,
        });
      } catch (err) {
        send({
          step: "error",
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
