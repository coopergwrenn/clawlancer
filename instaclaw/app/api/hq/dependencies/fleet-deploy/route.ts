import { NextRequest, NextResponse } from "next/server";
import { verifyHQAuth } from "@/lib/hq-auth";
import { getSupabase } from "@/lib/supabase";
import { connectSSH } from "@/lib/ssh";
import type { VMRecord } from "@/lib/ssh";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

const BATCH_SIZE = 10;

export async function POST(req: NextRequest) {
  if (!(await verifyHQAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { depId } = await req.json();
  if (!depId || typeof depId !== "string") {
    return NextResponse.json({ error: "depId required" }, { status: 400 });
  }

  const supabase = getSupabase();

  // Fetch dep record
  const { data: dep, error: depError } = await supabase
    .from("instaclaw_dependencies")
    .select("id, name, check_type, check_target, latest_version")
    .eq("id", depId)
    .single();

  if (depError || !dep) {
    return NextResponse.json({ error: "Dependency not found" }, { status: 404 });
  }

  if (!dep.latest_version) {
    return NextResponse.json({ error: "No latest_version set — run check first" }, { status: 400 });
  }

  const pipPackage = dep.check_target;
  const version = dep.latest_version;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(new TextEncoder().encode(sseEvent(data)));
      };

      try {
        send({ step: "query_vms", status: "running", detail: "Fetching fleet..." });

        const { data: vms, error } = await supabase
          .from("instaclaw_vms")
          .select("id, ip_address, ssh_port, ssh_user")
          .not("assigned_to", "is", null);

        if (error || !vms || vms.length === 0) {
          send({ step: "query_vms", status: "error", error: error?.message ?? "No assigned VMs found" });
          controller.close();
          return;
        }

        send({
          step: "query_vms",
          status: "done",
          detail: `${vms.length} VMs to deploy to`,
        });

        let succeeded = 0;
        let failed = 0;
        const failedVms: { id: string; ip: string; error: string }[] = [];

        const totalBatches = Math.ceil(vms.length / BATCH_SIZE);
        for (let b = 0; b < totalBatches; b++) {
          const batch = vms.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
          send({
            step: "batch",
            status: "running",
            batchNum: b + 1,
            totalBatches,
            detail: `Batch ${b + 1}/${totalBatches}: deploying to ${batch.length} VMs`,
          });

          await Promise.all(batch.map(async (vm) => {
            send({
              step: "vm_deploy",
              status: "running",
              vmId: vm.id,
              ip: vm.ip_address,
              detail: `Installing ${pipPackage}==${version} on ${vm.ip_address}...`,
            });

            try {
              const ssh = await connectSSH(vm as VMRecord);
              try {
                const result = await ssh.execCommand(
                  `python3 -m pip install --break-system-packages "${pipPackage}==${version}" 2>&1`,
                );
                const output = result.stdout + result.stderr;

                if (result.code === 0 || output.includes("Successfully installed")) {
                  succeeded++;
                  send({
                    step: "vm_deploy",
                    status: "done",
                    vmId: vm.id,
                    ip: vm.ip_address,
                    detail: `Installed ${pipPackage}==${version}`,
                  });
                } else {
                  failed++;
                  const errMsg = output.slice(0, 200);
                  failedVms.push({ id: vm.id, ip: vm.ip_address, error: errMsg });
                  send({
                    step: "vm_deploy",
                    status: "error",
                    vmId: vm.id,
                    ip: vm.ip_address,
                    error: errMsg,
                  });
                }
              } finally {
                ssh.dispose();
              }
            } catch (err) {
              failed++;
              const errMsg = err instanceof Error ? err.message : String(err);
              failedVms.push({ id: vm.id, ip: vm.ip_address, error: errMsg });
              send({
                step: "vm_deploy",
                status: "error",
                vmId: vm.id,
                ip: vm.ip_address,
                error: errMsg,
              });
            }
          }));

          send({
            step: "batch",
            status: "done",
            batchNum: b + 1,
            totalBatches,
            detail: `Batch ${b + 1}/${totalBatches} complete`,
            succeeded,
            failed,
          });

          // Pause between batches
          if (b < totalBatches - 1) {
            await new Promise((r) => setTimeout(r, 500));
          }
        }

        // Update DB if majority succeeded
        if (succeeded > failed) {
          await supabase
            .from("instaclaw_dependencies")
            .update({
              our_version: version,
              is_behind: false,
              status: "current",
              last_checked_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("id", depId);
        }

        send({
          step: "complete",
          status: "done",
          succeeded,
          failed,
          totalVms: vms.length,
          detail: `Fleet deploy complete: ${succeeded} succeeded, ${failed} failed`,
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
