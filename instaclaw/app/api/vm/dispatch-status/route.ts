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
 *
 * Detection strategy (in order, first success wins):
 *   1. Check active TCP connections on port 8765 via `ss` (most reliable)
 *   2. Fall back to Unix socket status query (can be flaky after restarts)
 *
 * The Unix socket on dispatch-server is unreliable — it can enter a broken
 * state where lsof says LISTEN but connect() returns ECONNREFUSED. The TCP
 * check via `ss` directly measures what we care about: is a relay WebSocket
 * connected to port 8765?
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

    let ssh;
    try {
      ssh = await connectSSH(vm);

      // Primary check: count ESTABLISHED WebSocket connections on port 8765
      // This is the most reliable method — directly checks the TCP state
      const tcpResult = await ssh.execCommand(
        'ss -tnp 2>/dev/null | grep ":8765" | grep -c ESTAB 2>/dev/null || echo 0'
      );
      const estabCount = parseInt(tcpResult.stdout.trim(), 10) || 0;

      // Also check if dispatch-server process is running
      const procResult = await ssh.execCommand(
        'pgrep -f "node.*dispatch-server" > /dev/null 2>&1 && echo 1 || echo 0'
      );
      const serverRunning = procResult.stdout.trim() === "1";

      const relayConnected = estabCount > 0;

      const result = {
        dispatchServer: serverRunning,
        relayConnected,
        activeConnections: estabCount,
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
