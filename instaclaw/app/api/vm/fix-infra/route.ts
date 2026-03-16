import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { connectSSH, NVM_PREAMBLE } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DBUS_PREAMBLE = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"';

/**
 * Fix infrastructure-level issues on a VM: systemd override, swap, etc.
 * These are things reconcileVM doesn't handle because they need sudo or
 * specific systemd user configuration.
 *
 * POST /api/vm/fix-infra
 * Body: { vmId: string, fixes: ("systemd-override" | "swap")[] }
 * Auth: CRON_SECRET
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { vmId, fixes } = (await req.json()) as {
    vmId: string;
    fixes: string[];
  };

  if (!vmId || !fixes?.length) {
    return NextResponse.json({ error: "vmId and fixes required" }, { status: 400 });
  }

  const supabase = getSupabase();
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, name")
    .eq("id", vmId)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "VM not found" }, { status: 404 });
  }

  const results: Record<string, string> = {};
  let ssh;
  try {
    ssh = await connectSSH(vm);
  } catch (err) {
    return NextResponse.json({ error: `SSH failed: ${String(err)}` }, { status: 500 });
  }

  try {
    for (const fix of fixes) {
      switch (fix) {
        case "systemd-override": {
          // Check if already present
          const check = await ssh.execCommand(
            "grep -c MemoryHigh ~/.config/systemd/user/openclaw-gateway.service.d/override.conf 2>/dev/null || echo 0"
          );
          if (parseInt(check.stdout.trim()) > 0) {
            results["systemd-override"] = "already-present";
            break;
          }

          // Write override.conf via heredoc
          const writeCmd =
            "mkdir -p ~/.config/systemd/user/openclaw-gateway.service.d && " +
            "cat > ~/.config/systemd/user/openclaw-gateway.service.d/override.conf << 'HEREDOC'\n" +
            "[Service]\n" +
            "KillMode=mixed\n" +
            "RestartSec=10\n" +
            "StartLimitBurst=10\n" +
            "StartLimitIntervalSec=300\n" +
            "StartLimitAction=stop\n" +
            "MemoryHigh=3G\n" +
            "MemoryMax=3500M\n" +
            "TasksMax=150\n" +
            "OOMScoreAdjust=500\n" +
            "RuntimeMaxSec=86400\n" +
            "RuntimeRandomizedExtraSec=3600\n" +
            "HEREDOC";
          await ssh.execCommand(writeCmd);

          // daemon-reload
          await ssh.execCommand(`${DBUS_PREAMBLE} && systemctl --user daemon-reload 2>/dev/null || true`);

          // Verify
          const verify = await ssh.execCommand(
            "grep -c MemoryHigh ~/.config/systemd/user/openclaw-gateway.service.d/override.conf 2>/dev/null || echo 0"
          );
          results["systemd-override"] = parseInt(verify.stdout.trim()) > 0 ? "fixed" : "failed";
          break;
        }

        case "swap": {
          // Check if swap already active
          const check = await ssh.execCommand("swapon --show 2>/dev/null | grep -c swapfile || echo 0");
          if (parseInt(check.stdout.trim()) > 0) {
            results["swap"] = "already-active";
            break;
          }

          // Create 2GB swap
          const swapCmd = [
            "sudo fallocate -l 2G /swapfile",
            "sudo chmod 600 /swapfile",
            "sudo mkswap /swapfile",
            "sudo swapon /swapfile",
            "grep -q swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab",
          ].join(" && ");
          const r = await ssh.execCommand(swapCmd);

          // Verify
          const verify = await ssh.execCommand("swapon --show 2>/dev/null | grep -c swapfile || echo 0");
          results["swap"] = parseInt(verify.stdout.trim()) > 0 ? "fixed" : `failed: ${r.stderr?.slice(0, 200)}`;
          break;
        }

        default:
          results[fix] = "unknown-fix";
      }
    }
  } finally {
    ssh.dispose();
  }

  logger.info("fix-infra completed", { vm: vm.name, results });
  return NextResponse.json({ vm: vm.name, results });
}
