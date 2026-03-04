import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { connectSSH } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { privateKey } = body as { privateKey: unknown };

    if (typeof privateKey !== "string" || !privateKey.trim()) {
      return NextResponse.json(
        { error: "privateKey is required (base58 string)" },
        { status: 400 }
      );
    }

    // Basic base58 validation (Solana private keys are 64 bytes = ~88 base58 chars)
    const trimmed = privateKey.trim();
    if (trimmed.length < 80 || trimmed.length > 100) {
      return NextResponse.json(
        { error: "Invalid private key length. Expected a base58-encoded Solana keypair (64 bytes)." },
        { status: 400 }
      );
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)) {
      return NextResponse.json(
        { error: "Invalid base58 characters in private key." },
        { status: 400 }
      );
    }

    const supabase = getSupabase();

    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, solana_defi_enabled")
      .eq("assigned_to", session.user.id)
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    if (!vm.solana_defi_enabled) {
      return NextResponse.json(
        { error: "Solana DeFi skill is not enabled. Enable it first." },
        { status: 400 }
      );
    }

    // SSH into VM, pass private key via base64-encoded stdin (NEVER as shell arg)
    const keyB64 = Buffer.from(trimmed, "utf-8").toString("base64");
    const ssh = await connectSSH(vm);
    try {
      const result = await ssh.execCommand(
        `echo '${keyB64}' | base64 -d | python3 ~/scripts/setup-solana-wallet.py import --json 2>&1`
      );

      if (result.code !== 0) {
        logger.warn("Solana wallet import failed", {
          vmId: vm.id,
          stderr: result.stderr?.slice(0, 200),
          route: "api/skills/solana-defi/import-wallet",
        });
        return NextResponse.json(
          { error: "Wallet import failed", detail: result.stderr?.slice(0, 200) },
          { status: 500 }
        );
      }

      const importData = JSON.parse(result.stdout.trim());
      const walletAddress = importData.address;

      if (walletAddress) {
        // Update Supabase with new wallet address
        await supabase
          .from("instaclaw_vms")
          .update({ solana_wallet_address: walletAddress })
          .eq("id", vm.id);
      }

      logger.info("Solana wallet imported", {
        vmId: vm.id,
        walletAddress,
        userId: session.user.id,
        route: "api/skills/solana-defi/import-wallet",
      });

      return NextResponse.json({ success: true, walletAddress });
    } finally {
      ssh.dispose();
    }
  } catch (err) {
    logger.error("Solana wallet import error", {
      error: String(err),
      route: "api/skills/solana-defi/import-wallet",
    });
    return NextResponse.json(
      { error: "Failed to import wallet" },
      { status: 500 }
    );
  }
}
