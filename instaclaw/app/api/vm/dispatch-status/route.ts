import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";
import { connectSSH } from "@/lib/ssh";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

// In-memory cache: userId → { result, timestamp }
// Prevents SSH hammering when polling every 5s
const statusCache = new Map<string, { result: Record<string, unknown>; ts: number }>();
const CACHE_TTL_MS = 4000; // 4s cache — allows 5s polling without duplicate SSH

/**
 * GET /api/vm/dispatch-status
 *
 * Returns the status of the dispatch relay (user's computer connection).
 * Checks the dispatch-server Unix socket on the user's VM.
 * Cached for 4s to support fast polling without SSH overhead.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;

    // Check cache
    const cached = statusCache.get(userId);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return NextResponse.json(cached.result);
    }

    const supabase = getSupabase();
    const { data: vm } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, tier")
      .eq("assigned_to", userId)
      .eq("status", "assigned")
      .single();

    if (!vm) {
      const result = { connected: false, dispatchServer: false, relayConnected: false, error: "No VM assigned" };
      statusCache.set(userId, { result, ts: Date.now() });
      return NextResponse.json(result);
    }

    // SSH into VM and check dispatch status via Unix socket
    let ssh;
    try {
      ssh = await connectSSH(vm);
      const sshResult = await ssh.execCommand(
        'echo \'{"type":"status"}\' | nc -U -w 3 /tmp/dispatch.sock 2>/dev/null || echo \'{"connected":false,"error":"dispatch server not running"}\''
      );

      const status = JSON.parse(sshResult.stdout.trim() || '{"connected":false}');

      const result = {
        dispatchServer: true,
        relayConnected: status.connected ?? false,
        pendingCommands: status.pendingCommands ?? 0,
        uptime: status.uptime ?? 0,
      };
      statusCache.set(userId, { result, ts: Date.now() });
      return NextResponse.json(result);
    } catch (err) {
      logger.warn("Dispatch status check failed", {
        error: String(err),
        vmId: vm.id,
        route: "vm/dispatch-status",
      });
      const result = { connected: false, dispatchServer: false, relayConnected: false, error: "VM unreachable" };
      statusCache.set(userId, { result, ts: Date.now() });
      return NextResponse.json(result);
    } finally {
      ssh?.dispose();
    }
  } catch (err) {
    logger.error("Dispatch status error", {
      error: String(err),
      route: "vm/dispatch-status",
    });
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
