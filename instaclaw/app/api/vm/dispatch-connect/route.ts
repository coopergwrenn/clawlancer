import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { logger } from "@/lib/logger";
import crypto from "crypto";

export const dynamic = "force-dynamic";

function generatePairingCode(): string {
  const alpha = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const numeric = "23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += alpha[crypto.randomInt(alpha.length)];
  code += "-";
  for (let i = 0; i < 4; i++) code += numeric[crypto.randomInt(numeric.length)];
  return code;
}

/**
 * GET /api/vm/dispatch-connect?os=mac|windows|linux
 *
 * Returns a downloadable script file with a fresh pairing code baked in.
 * The user double-clicks the file and their agent connects automatically.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const osParam = req.nextUrl.searchParams.get("os") || "mac";
    const supabase = getSupabase();

    // Get user's VM
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, gateway_token, name")
      .eq("assigned_to", session.user.id)
      .eq("status", "assigned")
      .single();

    if (!vm) {
      return NextResponse.json({ error: "No VM assigned" }, { status: 404 });
    }

    // Generate pairing code
    const code = generatePairingCode();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // Try to store in DB (gracefully fail if table doesn't exist)
    try {
      await supabase.from("instaclaw_dispatch_pairing_codes").insert({
        code,
        user_id: session.user.id,
        vm_id: vm.id,
        gateway_token: vm.gateway_token,
        vm_address: vm.ip_address,
        expires_at: expiresAt,
      });
    } catch {
      // Table may not exist — fall back to direct token in script
    }

    // Build the connect command — use pairing code if table exists, direct token otherwise
    const pairCmd = `npx @instaclaw/dispatch@0.4.0 --pair ${code}`;
    const directCmd = `npx @instaclaw/dispatch@0.4.0 --token ${vm.gateway_token} --vm ${vm.ip_address}`;

    // Check if pairing table works by trying to read the code back
    let usePairing = false;
    try {
      const { data } = await supabase
        .from("instaclaw_dispatch_pairing_codes")
        .select("code")
        .eq("code", code)
        .maybeSingle();
      usePairing = !!data;
    } catch {}

    const connectCmd = usePairing ? pairCmd : directCmd;

    let script: string;
    let filename: string;
    let contentType: string;

    if (osParam === "windows") {
      filename = "instaclaw-connect.bat";
      contentType = "application/x-bat";
      script = [
        "@echo off",
        'echo.',
        'echo  InstaClaw - Connecting your computer to your agent...',
        'echo.',
        "",
        "REM Check if Node.js is installed",
        "where npx >nul 2>nul",
        "if %ERRORLEVEL% neq 0 (",
        '  echo  Node.js is required but not installed.',
        '  echo  Download it from: https://nodejs.org',
        '  echo.',
        "  pause",
        "  exit /b 1",
        ")",
        "",
        `${connectCmd}`,
        "",
        "pause",
      ].join("\r\n");
    } else {
      // Mac (.command) or Linux (.sh)
      filename = osParam === "mac" ? "instaclaw-connect.command" : "instaclaw-connect.sh";
      contentType = "application/x-sh";
      script = [
        "#!/bin/bash",
        "",
        '# Check if Node.js / npx is installed',
        "if ! command -v npx &> /dev/null; then",
        '  echo ""',
        '  echo "  Node.js is required but not installed."',
        '  echo "  Install it from: https://nodejs.org"',
        '  echo ""',
        '  read -p "  Press Enter to exit..."',
        "  exit 1",
        "fi",
        "",
        'echo ""',
        'echo "  🤠 InstaClaw — Connecting your computer to your agent..."',
        'echo ""',
        "",
        `${connectCmd}`,
      ].join("\n");
    }

    logger.info("Dispatch connect script generated", {
      userId: session.user.id,
      vmName: vm.name,
      os: osParam,
      usePairing,
    });

    return new NextResponse(script, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-cache, no-store",
      },
    });
  } catch (err) {
    logger.error("Dispatch connect error", { error: String(err) });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
