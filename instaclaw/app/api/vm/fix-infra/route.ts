import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { connectSSH, NVM_PREAMBLE, type VMRecord } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const DBUS_PREAMBLE = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"';

/**
 * Apply infrastructure fixes to a single VM over SSH.
 * Reused for both single-VM and fleet modes.
 */
async function applyFixes(
  vm: Pick<VMRecord, "id" | "ip_address" | "ssh_port" | "ssh_user"> & { name?: string },
  fixes: string[],
): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  const ssh = await connectSSH(vm);

  try {
    for (const fix of fixes) {
      switch (fix) {
        case "systemd-override": {
          const check = await ssh.execCommand(
            "grep -c MemoryHigh ~/.config/systemd/user/openclaw-gateway.service.d/override.conf 2>/dev/null || echo 0"
          );
          if (parseInt(check.stdout.trim()) > 0) {
            results["systemd-override"] = "already-present";
            break;
          }
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
          await ssh.execCommand(`${DBUS_PREAMBLE} && systemctl --user daemon-reload 2>/dev/null || true`);
          const verify = await ssh.execCommand(
            "grep -c MemoryHigh ~/.config/systemd/user/openclaw-gateway.service.d/override.conf 2>/dev/null || echo 0"
          );
          results["systemd-override"] = parseInt(verify.stdout.trim()) > 0 ? "fixed" : "failed";
          break;
        }

        case "swap": {
          const check = await ssh.execCommand("swapon --show 2>/dev/null | grep -c swapfile || echo 0");
          if (parseInt(check.stdout.trim()) > 0) {
            results["swap"] = "already-active";
            break;
          }
          const swapCmd = [
            "sudo fallocate -l 2G /swapfile",
            "sudo chmod 600 /swapfile",
            "sudo mkswap /swapfile",
            "sudo swapon /swapfile",
            "grep -q swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab",
          ].join(" && ");
          const r = await ssh.execCommand(swapCmd);
          const verify = await ssh.execCommand("swapon --show 2>/dev/null | grep -c swapfile || echo 0");
          results["swap"] = parseInt(verify.stdout.trim()) > 0 ? "fixed" : `failed: ${r.stderr?.slice(0, 200)}`;
          break;
        }

        case "pip3": {
          const check = await ssh.execCommand("which pip3 2>/dev/null && echo OK || echo MISSING");
          if (check.stdout.trim().includes("OK")) {
            await ssh.execCommand("pip3 install --break-system-packages --quiet openai 2>/dev/null || true");
            results["pip3"] = "already-present-openai-installed";
            break;
          }
          const installCmd = [
            "sudo apt-get update -qq",
            "sudo apt-get install -y -qq python3-pip",
            "pip3 install --break-system-packages --quiet openai",
          ].join(" && ");
          const r = await ssh.execCommand(installCmd);
          const verify = await ssh.execCommand("pip3 show openai 2>/dev/null | grep -q Name && echo OK || echo MISSING");
          results["pip3"] = verify.stdout.trim() === "OK" ? "fixed" : `failed: ${r.stderr?.slice(0, 200)}`;
          break;
        }

        case "playwright": {
          const check = await ssh.execCommand(
            'find ~/.cache/ms-playwright -name "chrome" -type f 2>/dev/null | grep chrome-linux64/chrome | head -1'
          );
          if (check.stdout.trim()) {
            await ssh.execCommand(`sudo ln -sfn "${check.stdout.trim()}" /usr/local/bin/chromium-browser`);
            results["playwright"] = "already-present-symlink-fixed";
            break;
          }
          await ssh.execCommand(`${NVM_PREAMBLE} && npx playwright install chromium`);
          const chromeCheck = await ssh.execCommand(
            'find ~/.cache/ms-playwright -name "chrome" -type f 2>/dev/null | grep chrome-linux64/chrome | head -1'
          );
          if (chromeCheck.stdout.trim()) {
            await ssh.execCommand(`sudo ln -sfn "${chromeCheck.stdout.trim()}" /usr/local/bin/chromium-browser`);
            results["playwright"] = "fixed";
          } else {
            results["playwright"] = "failed-no-chrome-found";
          }
          break;
        }

        default:
          results[fix] = "unknown-fix";
      }
    }
  } finally {
    ssh.dispose();
  }

  return results;
}

/**
 * POST /api/vm/fix-infra
 *
 * Single VM:  { vmId: string, fixes: string[] }
 * Fleet mode: { fleet: true, dryRun?: true, fixes: string[] }
 * Auth: CRON_SECRET
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json()) as {
    vmId?: string;
    fleet?: boolean;
    dryRun?: boolean;
    fixes: string[];
  };
  const { vmId, fleet, dryRun, fixes } = body;

  if (!fixes?.length) {
    return NextResponse.json({ error: "fixes required" }, { status: 400 });
  }

  const supabase = getSupabase();

  // Fleet mode
  if (fleet) {
    const { data: vms } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, name")
      .eq("status", "assigned")
      .not("ip_address", "is", null);

    if (!vms?.length) {
      return NextResponse.json({ message: "No assigned VMs", results: [] });
    }

    if (dryRun) {
      return NextResponse.json({
        dryRun: true,
        vmCount: vms.length,
        fixes,
        vms: vms.map((v) => v.name),
      });
    }

    const fleetResults: Array<{ vm: string; results: Record<string, string> }> = [];
    const BATCH = 10;
    for (let i = 0; i < vms.length; i += BATCH) {
      const batch = vms.slice(i, i + BATCH);
      const batchResults = await Promise.allSettled(
        batch.map(async (vm) => {
          try {
            const r = await applyFixes(vm, fixes);
            return { vm: vm.name ?? vm.id, results: r };
          } catch (err) {
            return { vm: vm.name ?? vm.id, results: { error: String(err).slice(0, 200) } };
          }
        })
      );
      for (const r of batchResults) {
        if (r.status === "fulfilled") {
          fleetResults.push(r.value);
        } else {
          fleetResults.push({ vm: "unknown", results: { error: String(r.reason).slice(0, 200) } });
        }
      }
    }

    const summary = {
      total: fleetResults.length,
      fixed: fleetResults.filter((r) => Object.values(r.results).some((v) => v === "fixed")).length,
      alreadyOk: fleetResults.filter((r) => Object.values(r.results).every((v) => v.startsWith("already"))).length,
      failed: fleetResults.filter((r) => Object.values(r.results).some((v) => v.startsWith("failed") || v === "error")).length,
    };

    logger.info("Fleet fix-infra completed", { summary, fixes });
    return NextResponse.json({ summary, results: fleetResults });
  }

  // Single VM mode
  if (!vmId) {
    return NextResponse.json({ error: "vmId or fleet required" }, { status: 400 });
  }

  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, name")
    .eq("id", vmId)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "VM not found" }, { status: 404 });
  }

  try {
    const results = await applyFixes(vm, fixes);
    logger.info("fix-infra completed", { vm: vm.name, results });
    return NextResponse.json({ vm: vm.name, results });
  } catch (err) {
    return NextResponse.json({ error: `SSH failed: ${String(err)}` }, { status: 500 });
  }
}
