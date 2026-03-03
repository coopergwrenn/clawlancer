import { NextRequest, NextResponse } from "next/server";
import { verifyHQAuth } from "@/lib/hq-auth";
import { getSupabase } from "@/lib/supabase";
import { upgradeOpenClaw, connectSSH, NVM_PREAMBLE } from "@/lib/ssh";
import { logger } from "@/lib/logger";
import type { VMRecord } from "@/lib/ssh";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function sseEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export async function POST(req: NextRequest) {
  if (!(await verifyHQAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { version } = await req.json();
  if (!version || typeof version !== "string") {
    return NextResponse.json({ error: "version required" }, { status: 400 });
  }

  if (!/^\d{4}\.\d+\.\d+/.test(version)) {
    return NextResponse.json({ error: "Invalid version format" }, { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: Record<string, unknown>) => {
        controller.enqueue(new TextEncoder().encode(sseEvent(data)));
      };

      try {
        // Step 1: Find Cooper's VM (admin user)
        send({ step: "find_vm", status: "running", detail: "Finding canary VM..." });

        const supabase = getSupabase();

        // Find the admin's VM — pick the first assigned VM owned by any known admin email
        const adminEmails = (process.env.ADMIN_EMAILS ?? "")
          .split(",")
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean);

        logger.info("Canary upgrade: admin email lookup", {
          route: "hq/openclaw/upgrade-canary",
          adminEmails,
          envRaw: process.env.ADMIN_EMAILS ?? "(unset)",
        });

        let user: { id: string } | null = null;
        for (const email of adminEmails) {
          const { data, error } = await supabase
            .from("instaclaw_users")
            .select("id")
            .ilike("email", email)
            .single();
          logger.info("Canary upgrade: email query result", {
            route: "hq/openclaw/upgrade-canary",
            email,
            found: !!data,
            userId: data?.id ?? null,
            error: error?.message ?? null,
          });
          if (data) { user = data; break; }
        }

        // Fallback: grab the first assigned VM if no admin email matched
        if (!user) {
          const { data: fallbackVm, error: fallbackErr } = await supabase
            .from("instaclaw_vms")
            .select("assigned_to")
            .eq("status", "assigned")
            .not("assigned_to", "is", null)
            .limit(1)
            .single();
          logger.info("Canary upgrade: fallback VM lookup", {
            route: "hq/openclaw/upgrade-canary",
            found: !!fallbackVm,
            assignedTo: fallbackVm?.assigned_to ?? null,
            error: fallbackErr?.message ?? null,
          });
          if (fallbackVm?.assigned_to) {
            user = { id: fallbackVm.assigned_to };
          }
        }

        if (!user) {
          send({ step: "find_vm", status: "error", error: "Admin user not found — checked: " + adminEmails.join(", ") + " (env: " + (process.env.ADMIN_EMAILS ?? "unset") + ")" });
          controller.close();
          return;
        }

        const { data: vm } = await supabase
          .from("instaclaw_vms")
          .select("id, ip_address, ssh_port, ssh_user, assigned_to, gateway_token, api_mode")
          .eq("assigned_to", user.id)
          .single();

        if (!vm) {
          send({ step: "find_vm", status: "error", error: "No VM assigned to admin" });
          controller.close();
          return;
        }

        send({ step: "find_vm", status: "done", detail: `VM ${vm.id} (${vm.ip_address})` });

        // Step 2: Upgrade using the hardened upgradeOpenClaw() function
        // (handles orphan cleanup, config settings, token sync, auth test)
        send({ step: "ssh_upgrade", status: "running", detail: "Starting upgrade..." });

        const result = await upgradeOpenClaw(
          vm as VMRecord & { gateway_token?: string; api_mode?: string },
          version,
          (msg) => {
            send({ step: "ssh_upgrade", status: "running", detail: msg });
          },
        );

        if (!result.success) {
          throw new Error(result.error ?? "Upgrade failed");
        }

        send({ step: "ssh_upgrade", status: "done", detail: "Upgrade complete" });

        // Step 3: Version verify
        send({ step: "verify", status: "running", detail: "Verifying version..." });
        const ssh = await connectSSH(vm as VMRecord);
        try {
          const vResult = await ssh.execCommand(`${NVM_PREAMBLE} && openclaw --version`);
          const installedVersion = vResult.stdout.trim();
          send({ step: "verify", status: "done", detail: `Running: ${installedVersion}`, version: installedVersion });
        } finally {
          ssh.dispose();
        }

        send({ step: "complete", status: "done", detail: "Canary upgrade complete", vmId: vm.id });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        send({ step: "error", status: "error", error: errorMsg });
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
