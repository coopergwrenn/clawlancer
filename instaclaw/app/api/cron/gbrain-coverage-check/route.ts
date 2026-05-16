/**
 * GET /api/cron/gbrain-coverage-check
 *
 * Tracks gbrain coverage across partner-allowlisted VMs (currently
 * ["edge_city"]). Every 30 min, SSH-probes each allowlisted VM for
 * `gbrain --version` + `openclaw mcp show gbrain` registration, classifies
 * the result, logs a structured snapshot to instaclaw_admin_alert_log, and
 * conditionally fires admin email alerts.
 *
 * Two operational modes, gated by env var GBRAIN_COVERAGE_OPERATIONAL:
 *
 *   - Pre-go-live mode (default, GBRAIN_COVERAGE_OPERATIONAL != "true"):
 *     Logging only. No emails. The Phase 4b rollout window (May 14-23) is
 *     expected to show 4-of-5 edge_city VMs missing gbrain initially, then
 *     declining as installs land. We don't want to spam Cooper during the
 *     install phase. The structured log lets the dashboard / `_phase4-edge-city-readiness.ts`
 *     surface coverage in real-time without false-positive alerts.
 *
 *   - Operational mode (GBRAIN_COVERAGE_OPERATIONAL=true):
 *     Flip-the-switch operational alerting. Cooper sets this env var on May 23
 *     (Phase 4 go-live target). Alert escalation:
 *
 *       0 missing-gbrain:                silent
 *       1 missing-gbrain:                log only (could be in-flight install)
 *       2+ missing-gbrain:               P2 email
 *       missing > 50% of allowlist:      P1 email (incident-class)
 *
 *     Plus a separate signal: VMs missing GBRAIN_ANTHROPIC_API_KEY in .env →
 *     stepEnvVarPush is failing somewhere. Always logs; P2 email if >5 such VMs.
 *
 * Schedule: every 30 minutes (matching heartbeat-staleness-sweep cadence).
 * Lock: 10 minutes (well above expected ~30-60s runtime even at 100 allowlisted VMs).
 *
 * Cost: ~5 SSH probes per cycle today (1 per edge_city VM). Scales linearly
 * with allowlist size. Each probe is a single `ssh.execCommand` of ~3 cheap
 * shell operations — negligible Anthropic/OpenAI cost (no LLM calls).
 *
 * See PRD-gbrain-fleet-rollout-2026-05-12.md §10 (gbrain-coverage cron as the
 * 4th monitoring layer; complements heartbeat-staleness-sweep + usage-anomaly-check
 * + minimax-canary).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { tryAcquireCronLock, releaseCronLock } from "@/lib/cron-lock";
import { logger } from "@/lib/logger";
import { sendAdminAlertEmail } from "@/lib/email";
import { connectSSH } from "@/lib/ssh";

export const dynamic = "force-dynamic";
// 100 allowlisted VMs × ~3s probe each, batched 10 in parallel = ~30s. Set
// maxDuration generously to absorb future allowlist growth (consensus_2026 +
// other partners post-Esmeralda).
export const maxDuration = 120;

const CRON_NAME = "gbrain-coverage-check";
const CRON_LOCK_TTL_SECONDS = 600;
const ONE_HOUR_MS = 60 * 60 * 1000;

// Partner allowlist — must stay in sync with stepGbrain's GBRAIN_PARTNER_ALLOWLIST
// in lib/vm-reconcile.ts (currently TBD; this cron is the watcher, stepGbrain
// is the installer). For v1: edge_city only.
const COVERAGE_ALLOWLIST: string[] = ["edge_city"];

type CoverageStatus = "gbrained" | "missing_key" | "missing_gbrain" | "partial" | "ssh_err";
type Architecture = "http-sidecar" | "stdio" | "none" | "unknown";

interface VmCoverage {
  vmId: string;
  vmName: string;
  partner: string;
  status: CoverageStatus;
  gbrainVersion: string | null;
  /** stdio architecture: bin path appears in `openclaw mcp show gbrain` output. */
  mcpRegistered: boolean;
  /** HTTP sidecar architecture (Rule 35): mcp.servers.gbrain.transport === 'streamable-http'. */
  transportHttp: boolean;
  /** Sidecar systemd service is active (HTTP arch only). Observation-only signal —
   *  not gated on for the "gbrained" verdict because transient flaps would noise-spam. */
  serviceActive: boolean;
  /** 127.0.0.1:3131 is listening (HTTP arch only). Observation-only, same reasoning. */
  portBound: boolean;
  /** GBRAIN_ANTHROPIC_API_KEY present in ~/.openclaw/.env (legacy stdio contract;
   *  for HTTP sidecar this lives in the systemd unit's Environment= instead). */
  envKeyPresent: boolean;
  architecture: Architecture;
  error?: string;
}

async function probeOne(vm: any): Promise<VmCoverage> {
  const result: VmCoverage = {
    vmId: vm.id,
    vmName: vm.name,
    partner: vm.partner,
    status: "ssh_err",
    gbrainVersion: null,
    mcpRegistered: false,
    transportHttp: false,
    serviceActive: false,
    portBound: false,
    envKeyPresent: false,
    architecture: "unknown",
  };
  let ssh;
  try {
    ssh = await connectSSH(vm);
    // Single SSH command emitting one parseable summary line. Probes BOTH the
    // legacy stdio install (M) and the new HTTP sidecar install (T/S/P) so the
    // cron correctly classifies VMs across the Rule 35 migration window.
    //
    // KEY_LEN uses wc -c — counts bytes including a trailing newline if present.
    // XDG_RUNTIME_DIR is set explicitly because the SSH session's environment
    // doesn't always inherit PAM's runtime dir; without it, `systemctl --user`
    // can fail to find the user manager socket.
    const probe = await ssh.execCommand(
      'source ~/.nvm/nvm.sh 2>/dev/null; ' +
      'export PATH="$HOME/.bun/bin:/usr/sbin:/usr/bin:/bin:$PATH"; ' +
      'export XDG_RUNTIME_DIR="/run/user/$(id -u)" 2>/dev/null; ' +
      // V — gbrain binary version (any 2+ segment dotted decimal)
      'V=$(gbrain --version 2>/dev/null | head -1 | grep -oE "[0-9]+(\\.[0-9]+)+"); ' +
      // T — HTTP sidecar transport set in openclaw.json (Rule 35)
      'T=$(jq -r ".mcp.servers.gbrain.transport // \\"absent\\"" "$HOME/.openclaw/openclaw.json" 2>/dev/null); ' +
      // S — sidecar systemd service state
      'S=$(systemctl --user is-active gbrain.service 2>/dev/null | head -1); ' +
      // P — loopback port 3131 bound
      'P=$(ss -lnpt 2>/dev/null | grep -c "127\\.0\\.0\\.1:3131"); ' +
      // M — legacy stdio bin path in openclaw mcp show output
      'M=$(openclaw mcp show gbrain 2>/dev/null | grep -c "/home/openclaw/.bun/bin/gbrain"); ' +
      // K — legacy GBRAIN_ANTHROPIC_API_KEY in ~/.openclaw/.env (stdio contract)
      'K=$(grep "^GBRAIN_ANTHROPIC_API_KEY=" "$HOME/.openclaw/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d \'"\' | wc -c); ' +
      'echo "GBRAIN_PROBE V=${V:-missing} T=${T:-absent} S=${S:-inactive} P=${P:-0} M=${M:-0} K=${K:-0}"',
      { execOptions: { timeout: 10_000 } } as any,
    );
    const line = (probe.stdout || "").split("\n").find((l: string) => l.startsWith("GBRAIN_PROBE")) ?? "";
    // Capture all six fields. Backward-compat path: if the probe somehow
    // returns the OLD 3-field format (shouldn't happen after this PR lands but
    // defense in depth), fall back to the old regex.
    let parsed: { version: string; transport: string; service: string; portStr: string; mcpStr: string; keyLenStr: string } | null = null;
    const mNew = line.match(/V=(\S+) T=(\S+) S=(\S+) P=(\d+) M=(\d+) K=(\d+)/);
    if (mNew) {
      parsed = { version: mNew[1], transport: mNew[2], service: mNew[3], portStr: mNew[4], mcpStr: mNew[5], keyLenStr: mNew[6] };
    } else {
      const mOld = line.match(/V=(\S+) M=(\d+) K=(\d+)/);
      if (mOld) {
        parsed = { version: mOld[1], transport: "absent", service: "inactive", portStr: "0", mcpStr: mOld[2], keyLenStr: mOld[3] };
      }
    }
    if (!parsed) {
      result.error = `parse_fail stdout=${(probe.stdout || "").slice(0, 200)}`;
      return result;
    }
    result.gbrainVersion = parsed.version === "missing" ? null : parsed.version;
    result.transportHttp = parsed.transport === "streamable-http";
    result.serviceActive = parsed.service === "active";
    result.portBound = parseInt(parsed.portStr, 10) > 0;
    result.mcpRegistered = parseInt(parsed.mcpStr, 10) > 0;
    result.envKeyPresent = parseInt(parsed.keyLenStr, 10) > 20;

    // Architecture detection (independent of status — useful for dashboards even
    // when status is partial or missing).
    if (result.transportHttp && !result.mcpRegistered) result.architecture = "http-sidecar";
    else if (result.mcpRegistered && !result.transportHttp) result.architecture = "stdio";
    else if (result.transportHttp && result.mcpRegistered) result.architecture = "unknown"; // hybrid — shouldn't happen
    else result.architecture = "none";

    // Classification — preserve priority order to keep alert semantics stable:
    //   gbrained > missing_key > missing_gbrain > partial > ssh_err
    //
    // "Installed" now accepts EITHER architecture:
    //   - HTTP sidecar: gbrain binary + transport=streamable-http in openclaw.json
    //   - Legacy stdio: gbrain binary + bin path in `openclaw mcp show gbrain`
    //
    // Service-active / port-bound are deliberately NOT gated on here — they're
    // observed and surfaced for diagnostics but don't decide the verdict. A
    // momentary sidecar restart should NOT flip a VM from gbrained→partial and
    // fire a P2 email; that's the deep-check cron's job (with consecutive-fail
    // escalation thresholds for noise suppression).
    const installed = !!result.gbrainVersion && (result.transportHttp || result.mcpRegistered);
    if (installed) {
      result.status = "gbrained";
    } else if (!result.envKeyPresent) {
      // Legacy signal: GBRAIN_ANTHROPIC_API_KEY missing from ~/.openclaw/.env.
      // For HTTP-sidecar VMs, this key lives in the systemd unit's Environment=
      // instead, so this signal becomes less meaningful post-migration. Tracked
      // separately in P3 followup; preserved as-is for stdio compat.
      result.status = "missing_key";
    } else if (!result.gbrainVersion && !result.transportHttp && !result.mcpRegistered) {
      result.status = "missing_gbrain";
    } else {
      // Partial: gbrain binary present but neither transport set up, OR
      // transport set up but binary missing (extreme rare), etc.
      result.status = "partial";
    }
  } catch (e: unknown) {
    result.error = e instanceof Error ? e.message : String(e);
  } finally {
    try { ssh?.dispose(); } catch { /* ignore */ }
  }
  return result;
}

async function batched<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) {
    const batch = items.slice(i, i + n);
    const results = await Promise.all(batch.map(fn));
    out.push(...results);
  }
  return out;
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const lockAcquired = await tryAcquireCronLock(CRON_NAME, CRON_LOCK_TTL_SECONDS);
  if (!lockAcquired) {
    logger.info("gbrain-coverage-check: lock held, skipping", { route: `cron/${CRON_NAME}` });
    return NextResponse.json({ skipped: "lock_held" });
  }

  const startedAt = Date.now();
  try {
    const supabase = getSupabase();
    const operationalMode = process.env.GBRAIN_COVERAGE_OPERATIONAL === "true";

    // 1. Pull allowlisted VMs
    const { data: vms, error: queryErr } = await supabase
      .from("instaclaw_vms")
      .select("id,name,ip_address,ssh_port,ssh_user,partner,health_status,tier")
      .eq("status", "assigned")
      .eq("provider", "linode")
      .eq("health_status", "healthy")
      .in("partner", COVERAGE_ALLOWLIST);

    if (queryErr) {
      logger.error("gbrain-coverage-check: query failed", {
        route: `cron/${CRON_NAME}`,
        error: queryErr.message,
      });
      return NextResponse.json({ error: "query_failed", details: queryErr.message }, { status: 500 });
    }

    const allowlisted = (vms ?? []) as any[];
    if (allowlisted.length === 0) {
      logger.info("gbrain-coverage-check: no allowlisted VMs (empty allowlist or no assigned VMs match)", {
        route: `cron/${CRON_NAME}`,
        allowlist: COVERAGE_ALLOWLIST,
      });
      return NextResponse.json({ ok: true, total: 0, allowlist: COVERAGE_ALLOWLIST });
    }

    // 2. SSH-probe each VM in parallel batches of 10
    const probes = await batched(allowlisted, 10, probeOne);

    // 3. Classify
    const byStatus: Record<CoverageStatus, VmCoverage[]> = {
      gbrained: [], missing_key: [], missing_gbrain: [], partial: [], ssh_err: [],
    };
    for (const p of probes) byStatus[p.status].push(p);

    const total = probes.length;
    const gbrained = byStatus.gbrained.length;
    const coveragePct = total === 0 ? 100 : Math.round((gbrained / total) * 100);

    const elapsedMs = Date.now() - startedAt;
    // Architecture rollout tracking — counts VMs in each install mode. Used both
    // for the snapshot log line ("http-sidecar=12 stdio=3 none=2" at a glance
    // during the Rule 35 migration) and the JSON response further below.
    const archCounts: Record<Architecture, number> = {
      "http-sidecar": 0, "stdio": 0, "none": 0, "unknown": 0,
    };
    for (const p of probes) {
      if (p.status !== "ssh_err") archCounts[p.architecture]++;
    }
    logger.info("gbrain-coverage-check: snapshot", {
      route: `cron/${CRON_NAME}`,
      operational_mode: operationalMode,
      allowlist: COVERAGE_ALLOWLIST,
      total,
      gbrained,
      missing_gbrain: byStatus.missing_gbrain.length,
      missing_key: byStatus.missing_key.length,
      partial: byStatus.partial.length,
      ssh_err: byStatus.ssh_err.length,
      arch_http_sidecar: archCounts["http-sidecar"],
      arch_stdio: archCounts["stdio"],
      arch_none: archCounts["none"],
      arch_unknown: archCounts["unknown"],
      coverage_pct: coveragePct,
      elapsed_ms: elapsedMs,
    });

    // 4. Always record the snapshot to admin_alert_log (for dashboard polling)
    const alertKeySnapshot = `${CRON_NAME}:snapshot`;
    await supabase.from("instaclaw_admin_alert_log").insert({
      alert_key: alertKeySnapshot,
      vm_count: total,
      details: `coverage=${gbrained}/${total} (${coveragePct}%) missing_gbrain=${byStatus.missing_gbrain.length} missing_key=${byStatus.missing_key.length} partial=${byStatus.partial.length} ssh_err=${byStatus.ssh_err.length} operational=${operationalMode}`,
    });

    // 5. Operational-mode alert dispatch
    if (operationalMode) {
      // ─── Signal 1: missing gbrain on allowlisted VMs ───
      const missing = byStatus.missing_gbrain.length + byStatus.partial.length;
      const missingPct = total === 0 ? 0 : (missing / total) * 100;

      let severity: "silent" | "log" | "p2" | "p1" = "silent";
      if (missingPct > 50) severity = "p1";
      else if (missing >= 2) severity = "p2";
      else if (missing === 1) severity = "log";

      if (severity === "p1" || severity === "p2") {
        const oneHourAgo = new Date(Date.now() - ONE_HOUR_MS).toISOString();
        const alertKey = `${CRON_NAME}:missing_gbrain:${severity}`;
        const { count: dupCount } = await supabase
          .from("instaclaw_admin_alert_log")
          .select("id", { count: "exact", head: true })
          .eq("alert_key", alertKey)
          .gte("sent_at", oneHourAgo);
        const firstFireThisHour = (dupCount ?? 0) === 0;

        if (firstFireThisHour) {
          const subject = severity === "p1"
            ? `[InstaClaw P1] gbrain coverage incident — ${missingPct.toFixed(0)}% of allowlisted VMs missing gbrain`
            : `[InstaClaw P2] gbrain coverage gap — ${missing} allowlisted VMs missing gbrain`;
          const body = [
            `${missing} of ${total} allowlisted VMs (allowlist=${COVERAGE_ALLOWLIST.join(",")}) do NOT have gbrain installed.`,
            `Coverage: ${gbrained}/${total} (${coveragePct}%)`,
            ``,
            `Affected VMs (missing_gbrain + partial):`,
            ...byStatus.missing_gbrain.map((v) => `  ✗ ${v.vmName} (${v.partner}) — no binary, no transport, no stdio MCP`),
            ...byStatus.partial.map((v) =>
              `  ⚠ ${v.vmName} (${v.partner}) — partial: V=${v.gbrainVersion ?? "?"} ` +
              `T=${v.transportHttp ? "streamable-http" : "absent"} ` +
              `S=${v.serviceActive ? "active" : "inactive"} ` +
              `P=${v.portBound ? "bound" : "0"} ` +
              `M=${v.mcpRegistered ? "stdio" : "0"} ` +
              `arch=${v.architecture}`,
            ),
            ``,
            `Diagnostics for the most-affected VMs:`,
            `  npx tsx scripts/_phase4-edge-city-readiness.ts   # full readiness dump`,
            `  npx tsx scripts/_install-gbrain-on-vm.ts <vm-name>   # per-VM install fallback`,
            ``,
            `If stepGbrain (reconciler) is supposed to be installing these and isn't:`,
            `  - Check Vercel logs for /api/cron/reconcile-fleet — look for stepGbrain errors`,
            `  - Confirm partner='${COVERAGE_ALLOWLIST[0]}' is in GBRAIN_PARTNER_ALLOWLIST in lib/vm-reconcile.ts`,
            `  - The reconciler skips VMs where config_version is already at the manifest version (lying-DB cohort); check if any affected VM is in that state`,
          ].join("\n");
          await sendAdminAlertEmail(subject, body).catch((e) => {
            logger.error("gbrain-coverage-check: email send failed", { error: String(e) });
          });
        }

        await supabase.from("instaclaw_admin_alert_log").insert({
          alert_key: alertKey,
          vm_count: missing,
          details: firstFireThisHour
            ? `sent: ${severity} missing=${missing}/${total}`
            : `suppressed (dedup): ${severity} missing=${missing}/${total}`,
        });
      }

      // ─── Signal 2: missing GBRAIN_ANTHROPIC_API_KEY → stepEnvVarPush failing ───
      const missingKey = byStatus.missing_key.length;
      if (missingKey >= 5) {
        const oneHourAgo = new Date(Date.now() - ONE_HOUR_MS).toISOString();
        const alertKey = `${CRON_NAME}:missing_key:p2`;
        const { count: dupCount } = await supabase
          .from("instaclaw_admin_alert_log")
          .select("id", { count: "exact", head: true })
          .eq("alert_key", alertKey)
          .gte("sent_at", oneHourAgo);
        if ((dupCount ?? 0) === 0) {
          await sendAdminAlertEmail(
            `[InstaClaw P2] gbrain key gap — ${missingKey} allowlisted VMs missing GBRAIN_ANTHROPIC_API_KEY in .env`,
            [
              `${missingKey} of ${total} allowlisted VMs do NOT have GBRAIN_ANTHROPIC_API_KEY in ~/.openclaw/.env.`,
              ``,
              `This indicates stepEnvVarPush is not propagating successfully.`,
              ``,
              `Likely causes:`,
              `  - GBRAIN_ANTHROPIC_API_KEY env var unset in Vercel (check Vercel dashboard)`,
              `  - Reconciler failing on these VMs (check reconcile-fleet logs)`,
              `  - VMs are unreachable via SSH (check ssh_user / ssh_port / network)`,
              ``,
              `Affected VMs:`,
              ...byStatus.missing_key.map((v) => `  ✗ ${v.vmName} (${v.partner})`),
            ].join("\n"),
          ).catch(() => { /* logged elsewhere */ });
        }
        await supabase.from("instaclaw_admin_alert_log").insert({
          alert_key: alertKey,
          vm_count: missingKey,
          details: (dupCount ?? 0) === 0 ? `sent: missing_key=${missingKey}` : `suppressed (dedup): missing_key=${missingKey}`,
        });
      }
    }

    return NextResponse.json({
      ok: true,
      operational_mode: operationalMode,
      allowlist: COVERAGE_ALLOWLIST,
      total,
      gbrained,
      coverage_pct: coveragePct,
      architecture_counts: archCounts,
      by_status: {
        gbrained: byStatus.gbrained.map((v) => ({ name: v.vmName, architecture: v.architecture, version: v.gbrainVersion })),
        missing_key: byStatus.missing_key.map((v) => v.vmName),
        missing_gbrain: byStatus.missing_gbrain.map((v) => v.vmName),
        partial: byStatus.partial.map((v) => ({
          name: v.vmName,
          version: v.gbrainVersion,
          transport_http: v.transportHttp,
          service_active: v.serviceActive,
          port_bound: v.portBound,
          mcp_stdio: v.mcpRegistered,
          architecture: v.architecture,
        })),
        ssh_err: byStatus.ssh_err.map((v) => ({ name: v.vmName, error: v.error })),
      },
      elapsed_ms: elapsedMs,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("gbrain-coverage-check: unhandled error", { route: `cron/${CRON_NAME}`, error: msg });
    return NextResponse.json({ error: "unhandled", details: msg }, { status: 500 });
  } finally {
    await releaseCronLock(CRON_NAME);
  }
}
