import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { setupTLSBackground, type VMRecord } from "@/lib/ssh";
import { logger } from "@/lib/logger";

/**
 * /api/cron/tls-retry — every 15 min, attempt to upgrade any VM stuck on
 * `http://{ip}:18789` to `https://{vm.id}.vm.instaclaw.io` by re-invoking
 * setupTLSBackground.
 *
 * Why this exists
 * ---------------
 * setupTLSBackground fires once at provision time:
 *   - Pool path: configure/route.ts:681 — after() block in /api/vm/configure
 *   - Cloud-init: cloud-init-callback/route.ts — after() block (added 2026-05-16)
 *
 * Both fire-and-forget via Next.js after(). If the install fails (Caddy apt
 * package fetch error, GoDaddy DNS API 500, Linode firewall blip, etc.), the
 * VM stays on `http://{ip}:18789` indefinitely. There was no retry mechanism
 * before this cron. The Phase 5 risk assessment from 2026-05-16 flagged this
 * as a P2; Cooper bumped it to a Phase 1C deliverable after finding zero TLS
 * retry coverage during the polling-review.
 *
 * What it does
 * ------------
 * 1. Query: status='assigned', health='healthy', gateway_url LIKE 'http://%',
 *    ip_address NOT NULL, created within 24h, ordered oldest-first, limit 3.
 *    The 3-VM cap × ~90s per setupTLSBackground (Caddy install dominated) =
 *    ~270s, within the 300s Vercel maxDuration (Rule 11).
 * 2. For each candidate: invoke setupTLSBackground(vm, `${vm.id}.vm.instaclaw.io`).
 *    Idempotent — fast-path-skip if Caddy is already running (lib/ssh.ts:9691).
 *    Failure-safe — never throws (lib/ssh.ts:9746).
 * 3. Re-read gateway_url to classify upgraded vs still-http.
 * 4. Separate sweep: any VM still on http:// past 24h gets a deduped (12h
 *    per-VM) admin alert. After 24h, this cron stops processing it via
 *    the `created_at > cutoff` filter — operator picks it up manually.
 *
 * Safety
 * ------
 * - No data mutation other than gateway_url + control_ui_url (via the helper)
 *   and an audit-log row (admin_alert_log on stuck-cohort alert).
 * - Path-agnostic: works for both pool-path VMs (where original after()
 *   failed) and cloud-init VMs equally. Both reach `http://` the same way.
 * - No cron-lock — race-with-self impossible (15-min schedule, ~5-min work);
 *   race-with-reconcile-fleet is acceptable (reconciler doesn't write
 *   gateway_url; setupTLSBackground only writes the column when its own work
 *   succeeded).
 * - Per Rule 18, this route runs ON Vercel (not locally), so the SSH key
 *   is loaded from env automatically — no `.env.ssh-key` file needed.
 */
export const dynamic = "force-dynamic";
// Rule 11: setupTLSBackground includes apt-get install caddy which can run
// 60-120s on a cold Linode (apt index fetch + caddy package + restart). At
// MAX_VMS_PER_TICK=3 serial, worst case ≈ 270s. Stays within Vercel Pro's
// 300s ceiling with ~30s headroom.
export const maxDuration = 300;

const MAX_VMS_PER_TICK = 3;
const TLS_GIVE_UP_AFTER_HOURS = 24;
const STUCK_HTTP_ALERT_DEDUP_HOURS = 12;

export async function GET(req: NextRequest) {
  // Auth — matches the pattern used by every other cron in app/api/cron/
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  const cutoffIso = new Date(
    Date.now() - TLS_GIVE_UP_AFTER_HOURS * 3600 * 1000,
  ).toISOString();

  // ── 1. Candidates: VMs that should retry TLS ──
  // LIKE 'http://%' specifically excludes https:// — patterns are
  // case-sensitive prefix matches; "https://" starts with "http" + "s"
  // which doesn't match the literal ":" required by the pattern at
  // position 5.
  const { data: candidates, error } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, gateway_url, name, created_at, assigned_to")
    .eq("status", "assigned")
    .eq("health_status", "healthy")
    .not("assigned_to", "is", null)
    .not("ip_address", "is", null)
    .like("gateway_url", "http://%")
    .gt("created_at", cutoffIso)
    .order("created_at", { ascending: true })
    .limit(MAX_VMS_PER_TICK);

  if (error) {
    logger.error("tls-retry: candidate query failed", {
      route: "cron/tls-retry",
      error: error.message,
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // ── 2. Per-VM retry ──
  let upgraded = 0;
  let stillHttp = 0;
  const perVmResults: Array<{ vmId: string; name: string | null; outcome: "upgraded" | "still-http" | "threw" }> = [];

  for (const vm of candidates ?? []) {
    const vmRecord: VMRecord = {
      id: vm.id,
      ip_address: vm.ip_address!,
      ssh_port: vm.ssh_port ?? 22,
      ssh_user: vm.ssh_user ?? "openclaw",
      assigned_to: vm.assigned_to!,
    };
    const hostname = `${vm.id}.vm.instaclaw.io`;

    try {
      await setupTLSBackground(vmRecord, hostname);
    } catch (e) {
      // setupTLSBackground's contract is "never throws" (lib/ssh.ts:9746)
      // but defensive against future regressions or unhandled rejections.
      logger.error("tls-retry: setupTLSBackground threw (contract violation)", {
        route: "cron/tls-retry",
        vmId: vm.id,
        vmName: vm.name,
        error: e instanceof Error ? e.message : String(e),
      });
      stillHttp++;
      perVmResults.push({ vmId: vm.id, name: vm.name, outcome: "threw" });
      continue;
    }

    // ── 3. Verify the upgrade landed ──
    const { data: post } = await supabase
      .from("instaclaw_vms")
      .select("gateway_url")
      .eq("id", vm.id)
      .maybeSingle();
    const newUrl = (post as { gateway_url?: string | null } | null)?.gateway_url ?? "";
    if (newUrl.startsWith("https://")) {
      upgraded++;
      perVmResults.push({ vmId: vm.id, name: vm.name, outcome: "upgraded" });
      logger.info("tls-retry: VM upgraded to HTTPS", {
        route: "cron/tls-retry",
        vmId: vm.id,
        vmName: vm.name,
        newGatewayUrl: newUrl,
      });
    } else {
      stillHttp++;
      perVmResults.push({ vmId: vm.id, name: vm.name, outcome: "still-http" });
      logger.warn("tls-retry: setupTLSBackground completed but gateway_url not upgraded", {
        route: "cron/tls-retry",
        vmId: vm.id,
        vmName: vm.name,
        currentGatewayUrl: newUrl,
      });
    }
  }

  // ── 4. Stuck-on-HTTP alert sweep (VMs past 24h cap) ──
  // These are NO LONGER eligible for retry (filtered out by created_at>cutoff
  // above). One-shot alert per VM per 12h to surface the manual-fix need
  // without spamming on every cron tick.
  const { data: ancientHttp, error: ancientErr } = await supabase
    .from("instaclaw_vms")
    .select("id, name, created_at")
    .eq("status", "assigned")
    .eq("health_status", "healthy")
    .not("assigned_to", "is", null)
    .like("gateway_url", "http://%")
    .lt("created_at", cutoffIso)
    .order("created_at", { ascending: true })
    .limit(20);

  if (ancientErr) {
    logger.warn("tls-retry: ancient-http query failed (non-fatal)", {
      route: "cron/tls-retry",
      error: ancientErr.message,
    });
  }

  let alertsSent = 0;
  if (ancientHttp && ancientHttp.length > 0) {
    const { sendAdminAlertEmail } = await import("@/lib/email");
    const dedupCutoff = new Date(
      Date.now() - STUCK_HTTP_ALERT_DEDUP_HOURS * 3600 * 1000,
    ).toISOString();

    for (const vm of ancientHttp) {
      const alertKey = `tls-stuck-http:${vm.id}`;
      try {
        // Dedup check — mirrors lib/email.ts:sendVMReadyEmail pattern
        const { data: prev } = await supabase
          .from("instaclaw_admin_alert_log")
          .select("id")
          .eq("alert_key", alertKey)
          .gte("sent_at", dedupCutoff)
          .limit(1);
        if (prev && prev.length > 0) continue;

        // Record BEFORE send (race-safe with near-simultaneous cron ticks
        // — though our 15-min schedule rules out this race; pattern parity
        // with lib/enospc-guard.ts:sendEnospcAlertDeduped is the rationale).
        await supabase.from("instaclaw_admin_alert_log").insert({
          alert_key: alertKey,
          vm_count: 1,
          details: `TLS upgrade has not landed for ${vm.name ?? vm.id} (created ${vm.created_at}). Manual investigation needed.`,
        });

        await sendAdminAlertEmail(
          `[P1] TLS stuck on HTTP — ${vm.name ?? vm.id}`,
          `VM ${vm.name ?? "(unnamed)"} (${vm.id}) created at ${vm.created_at} is still on http:// after ${TLS_GIVE_UP_AFTER_HOURS}h.\n\nThe 15-min TLS retry cron has stopped processing this VM (cutoff: ${TLS_GIVE_UP_AFTER_HOURS}h since created_at).\n\nManual investigation:\n  1. SSH to VM: \`systemctl status caddy\`\n  2. Check GoDaddy DNS records for ${vm.id}.vm.instaclaw.io\n  3. Caddy logs: \`journalctl -u caddy --no-pager | tail -50\`\n  4. Once Caddy is up + DNS resolves, manually flip gateway_url via SQL.\n  5. If TLS permanently broken on this VM: leaving on HTTP is functional, just not encrypted.`,
        );
        alertsSent++;
      } catch (e) {
        logger.warn("tls-retry: stuck-http alert failed (non-fatal)", {
          route: "cron/tls-retry",
          vmId: vm.id,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  return NextResponse.json({
    processed: candidates?.length ?? 0,
    upgraded,
    stillHttp,
    ancientHttpCount: ancientHttp?.length ?? 0,
    alertsSent,
    results: perVmResults,
  });
}
