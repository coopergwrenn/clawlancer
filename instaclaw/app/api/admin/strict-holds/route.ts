import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { validateAdminKey } from "@/lib/security";
import { VM_MANIFEST } from "@/lib/vm-manifest";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Persistent-hold surface threshold. A VM with at least this many consecutive
// strict failures is flagged. Matches the escalation email threshold so the
// endpoint stays consistent with alerting.
const PERSISTENT_THRESHOLD = 3;

/**
 * GET /api/admin/strict-holds
 *
 * Read-only observability into the Phase 2c strict-mode rollout.
 *
 * Surfaces four things in one call so callers don't have to stitch:
 *   1. persistently_held   — VMs currently failing strict ≥3 cycles in a row
 *   2. top_5_offenders     — VMs with most hold events in the last 24h
 *   3. manifest_version_gap — distribution of held VMs by their config_version
 *                              (answers "is the manifest bump stuck at v55?")
 *   4. daily_stats          — last 7 days of strict_daily_stats aggregate
 *                              (answers "is strict mode still running at all?")
 *
 * Optional query params:
 *   ?vmId={uuid} — return full hold history for one VM (last 50 events)
 *
 * Auth: X-Admin-Key (same as other admin endpoints).
 */
export async function GET(req: NextRequest) {
  if (!validateAdminKey(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const vmId = req.nextUrl.searchParams.get("vmId");

  try {
    // Single-VM deep history mode.
    if (vmId) {
      const { data: vmRow } = await supabase
        .from("instaclaw_vms")
        .select("id, name, config_version, strict_hold_streak")
        .eq("id", vmId)
        .maybeSingle();
      if (!vmRow) {
        return NextResponse.json({ error: "VM not found" }, { status: 404 });
      }
      const { data: holds } = await supabase
        .from("instaclaw_strict_holds")
        .select("event_time, strict_errors, canary_healthy, at_version, manifest_version, strict_hold_streak")
        .eq("vm_id", vmId)
        .order("event_time", { ascending: false })
        .limit(50);
      return NextResponse.json({
        vm: vmRow,
        manifest_version: VM_MANIFEST.version,
        holds: holds ?? [],
      });
    }

    // Fleet summary mode. Four parallel queries.
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    const [persistentRes, recentHoldsRes, statsRes, settingsRes] = await Promise.all([
      // 1. Persistently held — VMs currently holding ≥ threshold.
      supabase
        .from("instaclaw_vms")
        .select("id, name, config_version, strict_hold_streak")
        .gte("strict_hold_streak", PERSISTENT_THRESHOLD)
        .order("strict_hold_streak", { ascending: false })
        .limit(50),
      // 2. Recent holds for top-5 + manifest gap computation.
      supabase
        .from("instaclaw_strict_holds")
        .select("vm_id, at_version, strict_errors, event_time")
        .gte("event_time", twentyFourHoursAgo),
      // 3. Last 7 days of aggregate stats.
      supabase
        .from("instaclaw_strict_daily_stats")
        .select("*")
        .order("stat_date", { ascending: false })
        .limit(7),
      // 4. Kill-switch current state.
      supabase
        .from("instaclaw_admin_settings")
        .select("setting_key, bool_value, updated_at")
        .in("setting_key", ["strict_mode_enabled", "canary_enabled"]),
    ]);

    // Enrich persistently-held rows with their latest error set.
    const persistent = persistentRes.data ?? [];
    const persistentWithErrors: Array<{
      vmId: string;
      vmName: string | null;
      streak: number;
      atVersion: number | null;
      latestErrors: string[];
      lastHeldAt: string | null;
    }> = [];
    for (const v of persistent) {
      const { data: lastHold } = await supabase
        .from("instaclaw_strict_holds")
        .select("strict_errors, event_time")
        .eq("vm_id", v.id)
        .order("event_time", { ascending: false })
        .limit(1)
        .maybeSingle();
      persistentWithErrors.push({
        vmId: v.id,
        vmName: v.name,
        streak: v.strict_hold_streak,
        atVersion: v.config_version,
        latestErrors: lastHold?.strict_errors ?? [],
        lastHeldAt: lastHold?.event_time ?? null,
      });
    }

    // Top-5 offenders by 24h hold count.
    const holdsByVm = new Map<string, number>();
    for (const h of recentHoldsRes.data ?? []) {
      holdsByVm.set(h.vm_id, (holdsByVm.get(h.vm_id) ?? 0) + 1);
    }
    const top5Ids = Array.from(holdsByVm.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const top5: Array<{ vmId: string; vmName: string | null; holdsLast24h: number; streak: number }> = [];
    if (top5Ids.length > 0) {
      const { data: vmNames } = await supabase
        .from("instaclaw_vms")
        .select("id, name, strict_hold_streak")
        .in("id", top5Ids.map(([id]) => id));
      const nameMap = new Map<string, { name: string | null; streak: number }>();
      for (const n of vmNames ?? []) nameMap.set(n.id, { name: n.name, streak: n.strict_hold_streak ?? 0 });
      for (const [id, count] of top5Ids) {
        const n = nameMap.get(id);
        top5.push({ vmId: id, vmName: n?.name ?? null, holdsLast24h: count, streak: n?.streak ?? 0 });
      }
    }

    // Manifest version gap — histogram of at_version among 24h holds.
    const versionGap = new Map<number, number>();
    for (const h of recentHoldsRes.data ?? []) {
      const v = h.at_version ?? 0;
      versionGap.set(v, (versionGap.get(v) ?? 0) + 1);
    }
    const manifestVersionGap = Array.from(versionGap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([version, count]) => ({ version, count }));

    // Totals.
    const totalHoldEventsLast24h = recentHoldsRes.data?.length ?? 0;
    const vmsWithActiveStreak = persistent.length;

    // Kill-switch state.
    const settingMap = new Map<string, { bool_value: boolean | null; updated_at: string }>();
    for (const s of settingsRes.data ?? []) {
      settingMap.set(s.setting_key, { bool_value: s.bool_value, updated_at: s.updated_at });
    }

    // "Is strict mode still running?" — yesterday's probes_run row.
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const yesterdayStats = (statsRes.data ?? []).find((s) => s.stat_date === yesterday);
    const strictModeAlive =
      (settingMap.get("strict_mode_enabled")?.bool_value !== false) &&
      (yesterdayStats ? (yesterdayStats.probes_run ?? 0) > 0 : null); // null = no data yet

    return NextResponse.json({
      generated_at: now.toISOString(),
      manifest_version: VM_MANIFEST.version,
      kill_switches: {
        strict_mode_enabled: settingMap.get("strict_mode_enabled")?.bool_value !== false,
        canary_enabled: settingMap.get("canary_enabled")?.bool_value !== false,
        strict_mode_updated_at: settingMap.get("strict_mode_enabled")?.updated_at ?? null,
        canary_updated_at: settingMap.get("canary_enabled")?.updated_at ?? null,
      },
      persistently_held: persistentWithErrors,
      top_5_offenders: top5,
      manifest_version_gap: manifestVersionGap,
      daily_stats: statsRes.data ?? [],
      totals: {
        total_hold_events_last_24h: totalHoldEventsLast24h,
        vms_with_active_streak: vmsWithActiveStreak,
        persistent_threshold: PERSISTENT_THRESHOLD,
      },
      liveness: {
        strict_mode_alive: strictModeAlive,
        note: "strict_mode_alive is null when no probe data exists yet (e.g., first day of rollout).",
      },
    });
  } catch (err) {
    logger.error("admin/strict-holds: failed", {
      route: "admin/strict-holds",
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
