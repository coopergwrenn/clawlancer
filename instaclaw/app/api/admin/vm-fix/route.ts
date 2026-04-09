import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { connectSSH } from "@/lib/ssh";
import { SOUL_MD_MEMORY_FILING_SYSTEM } from "@/lib/agent-intelligence";
import type { VMRecord } from "@/lib/ssh";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const WS = "/home/openclaw/.openclaw/workspace";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { vmId, action } = await req.json();
  if (!vmId || !action) {
    return NextResponse.json({ error: "vmId and action required" }, { status: 400 });
  }

  const supabase = getSupabase();
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, name")
    .eq("id", vmId)
    .single();

  if (!vm) return NextResponse.json({ error: "VM not found" }, { status: 404 });

  const ssh = await connectSSH(vm as unknown as VMRecord, { skipDuplicateIPCheck: true });

  try {
    switch (action) {
      case "list-crons": {
        const result = await ssh.execCommand("crontab -l 2>/dev/null");
        const lines = result.stdout.split("\n").filter((l: string) => l.trim() && !l.startsWith("#"));
        return NextResponse.json({ vm: vm.name, cronCount: lines.length, crons: lines });
      }

      case "fix-soul-memory-filing": {
        // Check if already present
        const check = await ssh.execCommand(`grep -c "MEMORY_FILING_SYSTEM" "${WS}/SOUL.md" 2>/dev/null || echo 0`);
        if (parseInt(check.stdout.trim()) > 0) {
          return NextResponse.json({ vm: vm.name, status: "already_present" });
        }
        // Append the memory filing system section
        const b64 = Buffer.from(SOUL_MD_MEMORY_FILING_SYSTEM, "utf-8").toString("base64");
        await ssh.execCommand(`echo '${b64}' | base64 -d >> "${WS}/SOUL.md"`);
        // Verify
        const verify = await ssh.execCommand(`grep -c "MEMORY_FILING_SYSTEM" "${WS}/SOUL.md" 2>/dev/null || echo 0`);
        const success = parseInt(verify.stdout.trim()) > 0;
        return NextResponse.json({ vm: vm.name, status: success ? "fixed" : "failed" });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } finally {
    ssh.dispose();
  }
}
