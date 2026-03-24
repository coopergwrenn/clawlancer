import { NextResponse } from "next/server";
import { verifyHQAuth } from "@/lib/hq-auth";
import { getSupabase } from "@/lib/supabase";
import { connectSSH } from "@/lib/ssh";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface VMRecord {
  id: string;
  name: string;
  ip_address: string;
  ssh_port: number;
  ssh_user: string;
  status: string;
}

interface VMMemoryStats {
  vmName: string;
  memSizeBytes: number;
  memAgeHours: number;
  sessionsJsonBytes: number;
  sessionFileCount: number;
  hygieneAgeHours: number;
  activeTasksExists: boolean;
  earnMdExists: boolean;
}

export async function GET() {
  if (!(await verifyHQAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Get all assigned VMs
  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, status")
    .eq("status", "assigned")
    .order("name");

  const vmList = (vms ?? []) as VMRecord[];

  // Sample up to 15 VMs (spread across fleet for representative stats)
  const step = Math.max(1, Math.floor(vmList.length / 15));
  const sampled: VMRecord[] = [];
  for (let i = 0; i < vmList.length && sampled.length < 15; i += step) {
    sampled.push(vmList[i]);
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  const stats: VMMemoryStats[] = [];
  let sshErrors = 0;

  for (const vm of sampled) {
    try {
      const ssh = await connectSSH(vm);
      try {
        // Single SSH command to collect all stats
        const result = await ssh.execCommand(
          [
            // MEMORY.md size and mtime
            "stat -c '%s %Y' ~/.openclaw/workspace/MEMORY.md 2>/dev/null || echo '0 0'",
            // sessions.json size
            "stat -c '%s' ~/.openclaw/agents/main/sessions/sessions.json 2>/dev/null || echo '0'",
            // session file count
            "ls -1 ~/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | wc -l",
            // hygiene marker mtime
            "stat -c '%Y' ~/.openclaw/agents/main/sessions/.last-session-cleanup 2>/dev/null || echo '0'",
            // active-tasks.md exists
            "test -f ~/.openclaw/workspace/memory/active-tasks.md && echo 'YES' || echo 'NO'",
            // EARN.md exists
            "test -f ~/.openclaw/workspace/EARN.md && echo 'YES' || echo 'NO'",
          ].join("; ")
        );

        const lines = result.stdout.trim().split("\n");
        const [memSize, memMtime] = (lines[0] || "0 0").split(" ");
        const sjSize = parseInt(lines[1] || "0", 10) || 0;
        const sessionCount = parseInt(lines[2] || "0", 10) || 0;
        const hygieneEpoch = parseInt(lines[3] || "0", 10) || 0;
        const activeTasksExists = (lines[4] || "NO").trim() === "YES";
        const earnMdExists = (lines[5] || "NO").trim() === "YES";

        const memMtimeEpoch = parseInt(memMtime, 10) || 0;

        stats.push({
          vmName: vm.name,
          memSizeBytes: parseInt(memSize, 10) || 0,
          memAgeHours: memMtimeEpoch > 0 ? (nowEpoch - memMtimeEpoch) / 3600 : -1,
          sessionsJsonBytes: sjSize,
          sessionFileCount: sessionCount,
          hygieneAgeHours: hygieneEpoch > 0 ? (nowEpoch - hygieneEpoch) / 3600 : -1,
          activeTasksExists,
          earnMdExists,
        });
      } finally {
        ssh.dispose();
      }
    } catch {
      sshErrors++;
    }
  }

  // Compute fleet-wide aggregates
  const valid = stats.filter((s) => s.memSizeBytes > 0 || s.sessionsJsonBytes > 0);
  const memSizes = valid.map((s) => s.memSizeBytes).sort((a, b) => a - b);
  const sjSizes = valid.map((s) => s.sessionsJsonBytes).sort((a, b) => a - b);
  const sessionCounts = valid.map((s) => s.sessionFileCount).sort((a, b) => a - b);

  const p95 = (arr: number[]) => (arr.length > 0 ? arr[Math.floor(arr.length * 0.95)] : 0);
  const avg = (arr: number[]) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  const hygieneOk = stats.filter((s) => s.hygieneAgeHours >= 0 && s.hygieneAgeHours <= 48).length;
  const hygieneStale = stats.filter((s) => s.hygieneAgeHours > 48).length;
  const hygieneNever = stats.filter((s) => s.hygieneAgeHours < 0).length;

  const memoryEmpty = stats.filter((s) => s.memSizeBytes < 200).length;
  const memoryOversized = stats.filter((s) => s.memSizeBytes > 25000).length;
  const memoryStale = stats.filter((s) => s.memAgeHours > 72).length;
  const sjBloated = stats.filter((s) => s.sessionsJsonBytes > 100000).length;

  return NextResponse.json({
    fleetTotal: vmList.length,
    sampled: sampled.length,
    sshErrors,
    aggregates: {
      memoryMdAvgBytes: Math.round(avg(memSizes)),
      memoryMdP95Bytes: p95(memSizes),
      sessionsJsonAvgBytes: Math.round(avg(sjSizes)),
      sessionsJsonP95Bytes: p95(sjSizes),
      avgSessionFiles: Math.round(avg(sessionCounts) * 10) / 10,
      p95SessionFiles: p95(sessionCounts),
    },
    health: {
      hygieneOk,
      hygieneStale,
      hygieneNever,
      memoryEmpty,
      memoryOversized,
      memoryStale,
      sjBloated,
      activeTasksPresent: stats.filter((s) => s.activeTasksExists).length,
      earnMdPresent: stats.filter((s) => s.earnMdExists).length,
    },
    vms: stats,
  });
}
