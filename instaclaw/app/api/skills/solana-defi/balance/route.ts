import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { connectSSH } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, solana_wallet_address")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    if (!vm.solana_wallet_address) {
      return NextResponse.json({ error: "No Solana wallet configured" }, { status: 404 });
    }

    // SSH into VM and run balance check script
    const ssh = await connectSSH(vm);
    try {
      const result = await ssh.execCommand(
        'python3 ~/scripts/solana-balance.py check --json 2>&1'
      );

      if (result.code !== 0) {
        logger.warn("Solana balance check failed", {
          vmId: vm.id,
          stderr: result.stderr?.slice(0, 200),
          route: "api/skills/solana-defi/balance",
        });
        return NextResponse.json(
          { error: "Balance check failed", detail: result.stderr?.slice(0, 200) },
          { status: 500 }
        );
      }

      const balanceData = JSON.parse(result.stdout.trim());
      return NextResponse.json(balanceData);
    } finally {
      ssh.dispose();
    }
  } catch (err) {
    logger.error("Solana balance error", {
      error: String(err),
      route: "api/skills/solana-defi/balance",
    });
    return NextResponse.json(
      { error: "Failed to check balance" },
      { status: 500 }
    );
  }
}
