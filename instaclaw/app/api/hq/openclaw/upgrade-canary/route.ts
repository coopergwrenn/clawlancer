import { NextRequest, NextResponse } from "next/server";
import { verifyHQAuth } from "@/lib/hq-auth";
import { getSupabase } from "@/lib/supabase";
import { connectSSH, NVM_PREAMBLE, GATEWAY_PORT } from "@/lib/ssh";
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

        const adminEmail = "coop@valtlabs.com";
        const supabase = getSupabase();

        const { data: user } = await supabase
          .from("instaclaw_users")
          .select("id")
          .eq("email", adminEmail)
          .single();

        if (!user) {
          send({ step: "find_vm", status: "error", error: "Admin user not found" });
          controller.close();
          return;
        }

        const { data: vm } = await supabase
          .from("instaclaw_vms")
          .select("id, ip_address, ssh_port, ssh_user, assigned_to")
          .eq("assigned_to", user.id)
          .single();

        if (!vm) {
          send({ step: "find_vm", status: "error", error: "No VM assigned to admin" });
          controller.close();
          return;
        }

        send({ step: "find_vm", status: "done", detail: `VM ${vm.id} (${vm.ip_address})` });

        // Step 2: SSH upgrade — install new version
        send({ step: "ssh_upgrade", status: "running", detail: `Installing openclaw@${version}...` });

        const ssh = await connectSSH(vm as VMRecord);
        try {
          const install = await ssh.execCommand(
            `${NVM_PREAMBLE} && npm install -g openclaw@${version}`,
          );
          if (install.code !== 0) {
            throw new Error(`npm install failed: ${install.stderr.slice(0, 300)}`);
          }

          send({ step: "ssh_upgrade", status: "running", detail: "Updating systemd service..." });
          await ssh.execCommand(
            `sed -i 's/^Description=.*/Description=OpenClaw Gateway v${version}/' ~/.config/systemd/user/openclaw-gateway.service && systemctl --user daemon-reload`,
          );

          send({ step: "ssh_upgrade", status: "running", detail: "Restarting gateway..." });
          await ssh.execCommand("systemctl --user stop openclaw-gateway 2>/dev/null || true");
          await new Promise((r) => setTimeout(r, 2000));
          await ssh.execCommand("systemctl --user start openclaw-gateway");

          send({ step: "ssh_upgrade", status: "done", detail: "Gateway restarted" });

          // Step 3: Health check — 6 attempts x 5s = 30s max (CLAUDE.md Rule 5)
          send({ step: "health_check", status: "running", detail: "Waiting for health..." });
          let healthy = false;
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 5000));
            const hc = await ssh.execCommand(
              `curl -sf -m 5 -o /dev/null -w '%{http_code}' http://localhost:${GATEWAY_PORT}/health`,
            );
            if (hc.stdout.trim() === "200") {
              healthy = true;
              break;
            }
            send({ step: "health_check", status: "running", detail: `Attempt ${i + 1}/6 — not ready` });
          }

          if (!healthy) {
            throw new Error("Gateway did not become healthy within 30s");
          }
          send({ step: "health_check", status: "done", detail: "Health check passed" });

          // Step 4: Version verify
          send({ step: "verify", status: "running", detail: "Verifying version..." });
          const vResult = await ssh.execCommand(`${NVM_PREAMBLE} && openclaw --version`);
          const installedVersion = vResult.stdout.trim();
          send({ step: "verify", status: "done", detail: `Running: ${installedVersion}`, version: installedVersion });

          send({ step: "complete", status: "done", detail: "Canary upgrade complete", vmId: vm.id });
        } finally {
          ssh.dispose();
        }
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
