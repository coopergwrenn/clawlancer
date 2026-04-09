import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { checkHealthExtended, checkSSHConnectivity, clearSessions, restartGateway, stopGateway, auditVMConfig, testProxyRoundTrip, resyncGatewayToken, checkVMTokenDrift, connectSSH, NVM_PREAMBLE, killStaleBrowser, checkSessionHealth, checkMemoryHealth, checkSessionCorruption, assignVMWithSSHCheck, readWatchdogStatus, checkDuplicateIP, wipeVMForNextUser, OPENCLAW_PINNED_VERSION } from "@/lib/ssh";
import { VM_MANIFEST, getTemplateContent } from "@/lib/vm-manifest";
import { sendHealthAlertEmail, sendSuspendedEmail, sendAutoMigratedEmail } from "@/lib/email";
import { AlertCollector } from "@/lib/admin-alert";
import { logger } from "@/lib/logger";
import { getProvider } from "@/lib/providers";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

// Auto-migration can trigger up to 3 VM configures (~120s each)
export const maxDuration = 600;

const ALERT_THRESHOLD = 3; // Send alert after 3 consecutive failures
const SSH_QUARANTINE_THRESHOLD = 6; // Auto-quarantine after 6 consecutive SSH failures (raised from 3 to reduce false positives)
const SUSPENSION_GRACE_DAYS = 7; // Days before suspending VM for past_due payment
const CONFIG_AUDIT_BATCH_SIZE = 10; // Max VMs to audit per cycle (raised from 3 to clear backlog faster)
const AUTO_MIGRATE_BATCH_SIZE = 3; // Max auto-migrations per cron cycle to prevent storms
const RESTART_GRACE_SECONDS = 120; // Skip health marking if gateway restarted within this window (Fix 1)
const ADMIN_EMAIL = process.env.ADMIN_ALERT_EMAIL ?? "";

export async function GET(req: NextRequest) {
  // Verify cron secret
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Get all assigned VMs with a gateway URL (includes "configuring" VMs
  // that finished SSH setup but haven't passed health check yet)
  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, gateway_url, health_status, gateway_token, health_fail_count, ssh_fail_count, assigned_to, name, config_version, tier, api_mode, proxy_401_count, assigned_at, last_gateway_restart, credit_balance")
    .eq("status", "assigned")
    .neq("health_status", "suspended")
    .neq("health_status", "hibernating")
    .not("gateway_url", "is", null);

  if (!vms?.length) {
    return NextResponse.json({ checked: 0 });
  }

  // Collect all admin alerts for this cycle — flush as grouped digest at the end
  const alerts = new AlertCollector();

  let healthy = 0;
  let unhealthy = 0;
  let alerted = 0;
  let restarted = 0;
  let autoRecovered = 0;
  let sessionsCleared = 0;
  let sessionsAlerted = 0;
  let browsersKilled = 0;
  let sshChecked = 0;
  let sshFailed = 0;
  let sshQuarantined = 0;
  let telegramConflictsHealed = 0;
  let billingCachesCleared = 0;
  let httpPreCheckPassed = 0;
  let restartGraceSkipped = 0;
  let zeroCreditSkipped = 0;

  // ========================================================================
  // Pre-fetch: active subscriptions for 0-credit VMs.
  // VMs with 0 credits and no active subscription are dead weight — skip
  // health checks and restarts for them to free cron cycles for paying users.
  // ========================================================================
  const zeroCreditVmUserIds = vms
    .filter(v => (v.credit_balance ?? 0) <= 0 && v.assigned_to)
    .map(v => v.assigned_to!);

  const activeSubUserIds = new Set<string>();
  if (zeroCreditVmUserIds.length > 0) {
    const { data: activeSubs } = await supabase
      .from("instaclaw_subscriptions")
      .select("user_id")
      .in("user_id", zeroCreditVmUserIds)
      .in("status", ["active", "trialing"]);

    for (const sub of activeSubs ?? []) {
      activeSubUserIds.add(sub.user_id);
    }
  }

  // ========================================================================
  // Pass 0 (HTTP-first): Direct HTTP health check for ALL VMs.
  // Fix 7: Use HTTP endpoint as primary monitor. Only SSH for diagnosis.
  // This eliminates fail2ban/UFW issues and reduces SSH connections from
  // ~200/cycle to only the unhealthy VMs that need intervention.
  // ========================================================================
  const sshAliveVms: typeof vms = [];
  const httpFailedVms: typeof vms = [];

  for (const vm of vms) {
    // Fix 1: Skip VMs in restart grace period
    const lastRestart = vm.last_gateway_restart
      ? new Date(vm.last_gateway_restart).getTime() : 0;
    const inGracePeriod = Date.now() - lastRestart < RESTART_GRACE_SECONDS * 1000;

    if (inGracePeriod) {
      restartGraceSkipped++;
      // Treat as healthy — gateway was just restarted intentionally
      sshAliveVms.push(vm);
      logger.info("Skipping health check — gateway in restart grace period", {
        route: "cron/health-check",
        vmId: vm.id,
        vmName: vm.name,
        secondsSinceRestart: Math.round((Date.now() - lastRestart) / 1000),
      });
      continue;
    }

    // Skip 0-credit VMs with no active subscription — they'll just crash
    // again after restart. Don't waste cron cycles on them.
    if ((vm.credit_balance ?? 0) <= 0 && vm.assigned_to && !activeSubUserIds.has(vm.assigned_to)) {
      zeroCreditSkipped++;
      continue;
    }

    // HTTP-first: try direct HTTP health endpoint (no SSH needed)
    let httpHealthy = false;
    try {
      const httpRes = await fetch(`http://${vm.ip_address}:18789/health`, {
        signal: AbortSignal.timeout(10000),
      });
      httpHealthy = httpRes.ok;
    } catch {
      // HTTP unreachable — fall through to SSH diagnosis
    }

    if (httpHealthy) {
      // Gateway is healthy via HTTP — skip SSH for monitoring
      httpPreCheckPassed++;
      sshAliveVms.push(vm);

      // Reset any stale failure counters
      if ((vm.health_fail_count ?? 0) > 0 || (vm.ssh_fail_count ?? 0) > 0 || vm.health_status !== "healthy") {
        await supabase
          .from("instaclaw_vms")
          .update({
            health_status: "healthy",
            health_fail_count: 0,
            ssh_fail_count: 0,
            last_health_check: new Date().toISOString(),
          })
          .eq("id", vm.id);
      }
      healthy++;
      continue;
    }

    // HTTP failed — this VM needs SSH diagnosis
    httpFailedVms.push(vm);
  }

  // ========================================================================
  // Pass 0b: SSH connectivity check — ONLY for VMs that failed HTTP.
  // Fix 2: Don't mark unhealthy on first SSH failure (require 2+).
  // ========================================================================

  for (const vm of httpFailedVms) {
    const sshOk = await checkSSHConnectivity({
      id: vm.id,
      ip_address: vm.ip_address,
      ssh_port: vm.ssh_port ?? 22,
      ssh_user: vm.ssh_user ?? "openclaw",
    });
    sshChecked++;

    if (sshOk) {
      // SSH is alive — reset counter if it was non-zero
      if ((vm.ssh_fail_count ?? 0) > 0) {
        await supabase
          .from("instaclaw_vms")
          .update({ ssh_fail_count: 0 })
          .eq("id", vm.id);
      }
      sshAliveVms.push(vm);
      continue;
    }

    // SSH failed
    sshFailed++;
    const newSshFailCount = (vm.ssh_fail_count ?? 0) + 1;

    logger.warn("SSH connectivity check failed", {
      route: "cron/health-check",
      vmId: vm.id,
      vmName: vm.name,
      ipAddress: vm.ip_address,
      sshFailCount: newSshFailCount,
    });

    if (newSshFailCount >= SSH_QUARANTINE_THRESHOLD) {
      // Both HTTP and SSH failed at quarantine threshold — quarantine
      sshQuarantined++;

      await supabase
        .from("instaclaw_vms")
        .update({
          status: "failed" as const,
          health_status: "unhealthy",
          ssh_fail_count: newSshFailCount,
          last_health_check: new Date().toISOString(),
        })
        .eq("id", vm.id);

      logger.error("VM auto-quarantined: both HTTP and SSH unreachable", {
        route: "cron/health-check",
        vmId: vm.id,
        vmName: vm.name,
        ipAddress: vm.ip_address,
        sshFailCount: newSshFailCount,
        assignedTo: vm.assigned_to,
      });

      alerts.add(
        "VM Auto-Quarantined: SSH Dead",
        vm.name ?? vm.id,
        `IP: ${vm.ip_address}\nSSH failures: ${newSshFailCount}\nAssigned to: ${vm.assigned_to ?? "none"}\nStatus set to "failed".`
      );
    } else {
      // Fix 2: Only mark unhealthy after 2+ consecutive SSH failures (not 1).
      // First failure is likely a transient blip — don't flip status.
      const shouldMarkUnhealthy = newSshFailCount >= 2;
      await supabase
        .from("instaclaw_vms")
        .update({
          ssh_fail_count: newSshFailCount,
          health_status: shouldMarkUnhealthy ? "unhealthy" : (vm.health_status ?? "unknown"),
          last_health_check: new Date().toISOString(),
        })
        .eq("id", vm.id);
    }
  }

  // Track which VMs are healthy for the config audit pass
  const healthyVmIds = new Set<string>();

  // Add HTTP-pre-check-passed VMs directly to healthyVmIds
  // (they already had their status updated in Pass 0)
  for (const vm of vms ?? []) {
    // VMs in sshAliveVms that are NOT in httpFailedVms passed HTTP
    if (sshAliveVms.some(v => v.id === vm.id) && !httpFailedVms.some(v => v.id === vm.id)) {
      healthyVmIds.add(vm.id);
    }
  }

  // Build list of VMs that need SSH-based gateway health check
  // (failed HTTP but passed SSH connectivity)
  const needsSSHHealthCheck = sshAliveVms.filter(vm => httpFailedVms.some(v => v.id === vm.id));

  // Only run SSH-based gateway health check on VMs that failed HTTP pre-check
  for (const vm of needsSSHHealthCheck) {
    const result = await checkHealthExtended(vm, vm.gateway_token ?? undefined);
    const currentFailCount = vm.health_fail_count ?? 0;

    // ── Session health check (runs for ALL VMs regardless of gateway health) ──
    // NOTE: rotateOversizedSession() was removed in v45 (P3.2). The primary session
    // management is now strip-thinking.py (200KB threshold, runs every minute) +
    // daily_hygiene() (7-day age cleanup). The 512KB threshold here was a redundant
    // "outer fence" that was never reached in practice.
    if (result.largestSessionBytes > VM_MANIFEST.sessionAlertBytes) {
      // Alert threshold (480KB) — session approaching auto-rotate (512KB).
      // Informational only — goes into digest, never as individual email.
      sessionsAlerted++;
      logger.warn("Session approaching size limit", {
        route: "cron/health-check",
        vmId: vm.id,
        vmName: vm.name,
        largestSessionBytes: result.largestSessionBytes,
        alertThreshold: VM_MANIFEST.sessionAlertBytes,
        rotateThreshold: VM_MANIFEST.maxSessionBytes,
      });

      alerts.add(
        "Session Size Warning",
        vm.name ?? vm.id,
        `Session at ${Math.round(result.largestSessionBytes / 1024)}KB (auto-rotate at ${Math.round(VM_MANIFEST.maxSessionBytes / 1024)}KB). No action needed.`
      );
    }

    // Ephemeral browser cleanup: kill Chrome if stale (>30min) or memory-heavy (>40% RAM).
    // Runs on ALL SSH-accessible VMs regardless of gateway health — orphan Chrome
    // processes are most likely on UNHEALTHY VMs (the Mucus incident: gateway crash-looped
    // for 15.5h while 14 orphan Chrome processes ate memory unchecked).
    try {
      const browserResult = await killStaleBrowser(vm);
      if (browserResult.killed) {
        browsersKilled++;
        logger.info("Stale browser killed", {
          route: "cron/health-check",
          vmId: vm.id,
          vmName: vm.name,
          reason: browserResult.reason,
          gatewayHealthy: result.healthy,
        });
      }
    } catch (err) {
      logger.error("Failed to check/kill stale browser", {
        error: String(err),
        route: "cron/health-check",
        vmId: vm.id,
      });
    }

    if (result.healthy) {
      healthy++;
      healthyVmIds.add(vm.id);

      // Reset fail count on success
      await supabase
        .from("instaclaw_vms")
        .update({
          health_status: "healthy",
          last_health_check: new Date().toISOString(),
          health_fail_count: 0,
        })
        .eq("id", vm.id);

      // ── Telegram 409 conflict — log only, do NOT restart ──
      // 409 conflicts happen when Telegram's stale long-poll from a previous
      // process instance overlaps with the new one. They self-resolve after
      // ~30-60 seconds. Restarting the gateway makes it WORSE by creating a
      // new overlap every time. The gateway HTTP API works fine during 409s.
      if (result.telegramConflict) {
        logger.warn("Telegram 409 conflict detected (non-fatal, will self-resolve)", {
          route: "cron/health-check",
          vmId: vm.id,
          vmName: vm.name,
        });
      }

      // ── Billing cache detection — clear poisoned auth-profiles.json ──
      // Even when the gateway is "healthy" (systemd active, health 200), a cached
      // billing error in auth-profiles.json disables the Anthropic provider silently.
      // The gateway appears healthy but every message fails. Auto-clear here.
      try {
        const billingSSH = await connectSSH(vm);
        try {
          const authCheck = await billingSSH.execCommand(
            "grep -c 'failureState\\|disabledUntil' ~/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null || echo 0"
          );
          if (parseInt(authCheck.stdout?.trim() || "0") > 0) {
            const fix = await billingSSH.execCommand(`python3 -c "
import json, os
p = os.path.expanduser('~/.openclaw/agents/main/agent/auth-profiles.json')
with open(p) as f: c = json.load(f)
changed = False
for key in list(c.get('profiles', {})):
    if 'failureState' in c['profiles'][key]:
        del c['profiles'][key]['failureState']
        changed = True
    if 'disabledUntil' in c['profiles'][key]:
        del c['profiles'][key]['disabledUntil']
        changed = True
if 'usageStats' in c:
    del c['usageStats']
    changed = True
if changed:
    with open(p, 'w') as f: json.dump(c, f, indent=2)
    print('FIXED')
else:
    print('CLEAN')
"`);
            if (fix.stdout?.includes("FIXED")) {
              await billingSSH.execCommand(
                "rm -f ~/.openclaw/agents/main/sessions/.session-degraded"
              );
              const DBUS = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"';
              await billingSSH.execCommand(`touch /tmp/ic-restart.lock && ${DBUS} && systemctl --user restart openclaw-gateway`);
              // Fix 1: Record restart for grace period
              await supabase
                .from("instaclaw_vms")
                .update({ last_gateway_restart: new Date().toISOString() })
                .eq("id", vm.id);
              billingCachesCleared++;
              logger.warn("Billing cache cleared and gateway restarted", {
                route: "cron/health-check",
                vmId: vm.id,
                vmName: vm.name,
              });
              alerts.add(
                "Billing Cache Cleared",
                vm.name ?? vm.id,
                "Cached billing error in auth-profiles.json auto-cleared. Gateway restarted."
              );
            }
          }
        } finally {
          billingSSH.dispose();
        }
      } catch (err) {
        logger.error("Failed to check billing cache", {
          error: String(err),
          route: "cron/health-check",
          vmId: vm.id,
        });
      }
    } else {
      unhealthy++;
      const newFailCount = currentFailCount + 1;

      await supabase
        .from("instaclaw_vms")
        .update({
          health_status: "unhealthy",
          last_health_check: new Date().toISOString(),
          health_fail_count: newFailCount,
        })
        .eq("id", vm.id);

      // Detect crash-loop: systemd start-limit-hit (10 crashes in 5min)
      // Check on every failure to catch it early, before the alert threshold
      try {
        const crashLoopSsh = await connectSSH(vm);
        const sysResult = await crashLoopSsh.execCommand(
          'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user show openclaw-gateway -p Result 2>&1'
        );
        if (sysResult.stdout.includes("start-limit-hit")) {
          alerts.add(
            "CRITICAL: Gateway Crash-Loop Detected",
            vm.name ?? vm.id,
            `SystemD start-limit-hit (10 crashes in 5min). Auto-recovering.\nIP: ${vm.ip_address}\nUser: ${vm.assigned_to ?? "unassigned"}`
          );
          // Auto-fix: reset-failed + restart
          await crashLoopSsh.execCommand(
            'export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user reset-failed openclaw-gateway && systemctl --user start openclaw-gateway'
          );
          logger.warn("Auto-recovered crash-looping gateway (start-limit-hit)", {
            route: "cron/health-check",
            vmId: vm.id,
            vmName: vm.name,
          });
        }
        crashLoopSsh.dispose();
      } catch (crashLoopErr) {
        logger.warn("Failed to check crash-loop state", {
          error: String(crashLoopErr),
          route: "cron/health-check",
          vmId: vm.id,
        });
      }

      // After ALERT_THRESHOLD consecutive failures, take action.
      // Retry every ALERT_THRESHOLD cycles (3, 6, 9...) not just once at exactly 3.
      if (newFailCount >= ALERT_THRESHOLD && newFailCount % ALERT_THRESHOLD === 0) {
        // Before restarting, verify the gateway is truly down via direct HTTP.
        // The SSH-based localhost curl can fail transiently (loopback issues,
        // curl oddities) while the gateway is actually serving fine publicly.
        let gatewayActuallyHealthy = false;
        try {
          const httpCheck = await fetch(`http://${vm.ip_address}:18789/health`, {
            signal: AbortSignal.timeout(10000),
          });
          gatewayActuallyHealthy = httpCheck.ok;
        } catch {
          // HTTP unreachable — gateway is truly down, proceed with restart
        }

        if (gatewayActuallyHealthy) {
          // Gateway is healthy via HTTP — SSH-based check was a false positive
          logger.info("Gateway health check failed via SSH but HTTP OK — skipping restart", {
            route: "cron/health-check",
            vmId: vm.id,
            vmName: vm.name,
            failCount: newFailCount,
          });

          // Reset fail count since the gateway is actually fine
          await supabase
            .from("instaclaw_vms")
            .update({
              health_status: "healthy",
              health_fail_count: 0,
              last_health_check: new Date().toISOString(),
            })
            .eq("id", vm.id);

          // Correct the counters — this VM is actually healthy
          unhealthy--;
          healthy++;
          healthyVmIds.add(vm.id);
        } else {
          // Both SSH-based check and direct HTTP failed — restart
          try {
            await restartGateway(vm);
            restarted++;
          } catch (err) {
            logger.error("Failed to restart gateway", { error: String(err), route: "cron/health-check", vmId: vm.id });
          }
        }

        // Health alert emails: ADMIN ONLY, ONCE PER INCIDENT.
        // Users cannot fix VM health issues — don't spam them.
        // Only send on the FIRST threshold crossing (fail_count == ALERT_THRESHOLD).
        // For sustained unhealthy, the SUSTAINED_UNHEALTHY_THRESHOLD block below
        // handles escalation via AlertCollector (batched, not per-VM emails).
        if (!gatewayActuallyHealthy && ADMIN_EMAIL && newFailCount === ALERT_THRESHOLD) {
          try {
            await sendHealthAlertEmail(
              ADMIN_EMAIL,
              `${vm.name ?? vm.id} (user: ${vm.assigned_to})`
            );
            alerted++;
          } catch {
            // Non-fatal
          }
        }
      }

      // Fix 5: Sustained unhealthy alerting — escalate when a VM has been
      // unhealthy for 6+ consecutive checks (~30+ min). The Mucus incident
      // went 15.5 hours unnoticed because the initial restart failed (broken
      // config) and no further alerts were sent.
      const SUSTAINED_UNHEALTHY_THRESHOLD = 6;
      if (newFailCount === SUSTAINED_UNHEALTHY_THRESHOLD) {
        const downtimeMinutes = newFailCount * 5;
        alerts.add(
          "URGENT: VM Unhealthy 30+ Minutes",
          vm.name ?? vm.id,
          `Unhealthy for ~${downtimeMinutes}min (${newFailCount} failures).\nIP: ${vm.ip_address}\nUser: ${vm.assigned_to ?? "unassigned"}\nRestart attempted at failure #${ALERT_THRESHOLD} but gateway did not recover.`
        );
      }

      // ── Auto-Recovery: at 10 consecutive failures (~50 min), SSH in and
      // attempt to fix the gateway automatically. Capped at 1 attempt per
      // VM per 24h via dedup key to prevent infinite loops.
      const AUTO_RECOVERY_THRESHOLD = 10;
      if (newFailCount === AUTO_RECOVERY_THRESHOLD) {
        const recoveryDedupKey = `auto_recovery:${vm.id}:${new Date().toISOString().split("T")[0]}`;
        let alreadyAttempted = false;
        try {
          const { data: existing } = await supabase
            .from("instaclaw_admin_alert_log")
            .select("id")
            .eq("alert_key", recoveryDedupKey)
            .limit(1);
          alreadyAttempted = (existing?.length ?? 0) > 0;
        } catch {
          // Table issue — proceed with recovery
        }

        if (!alreadyAttempted) {
          // Record the attempt BEFORE executing to prevent races
          await supabase.from("instaclaw_admin_alert_log").insert({
            alert_key: recoveryDedupKey,
            vm_count: 1,
            details: `Auto-recovery attempt started for ${vm.name ?? vm.id}`,
          }).then(() => {});

          let recoveryResult = "UNKNOWN";
          try {
            logger.info("Auto-recovery: starting for VM", {
              route: "cron/health-check", vmId: vm.id, vmName: vm.name, failCount: newFailCount,
            });

            const ssh = await connectSSH(vm);
            try {
              // Step 1: Check if openclaw module loads
              const moduleCheck = await ssh.execCommand(
                `${NVM_PREAMBLE} && node -e "require('openclaw')" 2>&1`
              );
              const moduleOk = moduleCheck.code === 0;

              if (!moduleOk) {
                // Step 2: Module broken — clear and reinstall
                logger.warn("Auto-recovery: openclaw module broken, reinstalling", {
                  route: "cron/health-check", vmId: vm.id, stderr: moduleCheck.stderr?.slice(0, 200),
                });

                const DBUS = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"';
                await ssh.execCommand(`${DBUS} && systemctl --user stop openclaw-gateway 2>&1; systemctl --user reset-failed openclaw-gateway 2>&1`);
                await ssh.execCommand(`${NVM_PREAMBLE} && rm -rf "$(npm root -g)/openclaw" "$(npm root -g)/.openclaw-"* && npm cache clean --force 2>&1`);
                const installResult = await ssh.execCommand(`${NVM_PREAMBLE} && npm install -g openclaw@latest 2>&1`);

                if (installResult.code !== 0) {
                  recoveryResult = `REINSTALL_FAILED: ${installResult.stderr?.slice(0, 300)}`;
                  throw new Error(recoveryResult);
                }

                // Verify module loads after reinstall
                const verifyResult = await ssh.execCommand(`${NVM_PREAMBLE} && node -e "require('openclaw')" 2>&1`);
                if (verifyResult.code !== 0) {
                  recoveryResult = "MODULE_STILL_BROKEN_AFTER_REINSTALL";
                  throw new Error(recoveryResult);
                }

                // Restart gateway
                await ssh.execCommand(`${DBUS} && systemctl --user daemon-reload && systemctl --user start openclaw-gateway 2>&1`);
              } else {
                // Step 2b: Module fine — just restart gateway (different root cause)
                logger.info("Auto-recovery: openclaw module OK, restarting gateway", {
                  route: "cron/health-check", vmId: vm.id,
                });
                const DBUS = 'export XDG_RUNTIME_DIR="/run/user/$(id -u)"';
                await ssh.execCommand(`${DBUS} && systemctl --user stop openclaw-gateway 2>&1; systemctl --user reset-failed openclaw-gateway 2>&1`);
                await ssh.execCommand(`${DBUS} && systemctl --user daemon-reload && systemctl --user start openclaw-gateway 2>&1`);
              }

              // Step 3: Wait and verify health
              await new Promise(r => setTimeout(r, 15000));
              const healthCheck = await ssh.execCommand("curl -sf http://localhost:18789/health 2>&1");
              const isHealthy = healthCheck.stdout?.includes('"ok":true') || healthCheck.stdout?.includes('"ok": true');

              if (isHealthy) {
                recoveryResult = moduleOk ? "GATEWAY_RESTARTED" : "MODULE_REINSTALLED_AND_HEALTHY";
                await supabase.from("instaclaw_vms").update({
                  health_status: "healthy",
                  health_fail_count: 0,
                  last_health_check: new Date().toISOString(),
                }).eq("id", vm.id);
                autoRecovered++;
              } else {
                recoveryResult = `STILL_UNHEALTHY_AFTER_${moduleOk ? "RESTART" : "REINSTALL"}`;
              }
            } finally {
              ssh.dispose();
            }
          } catch (recoveryErr) {
            if (recoveryResult === "UNKNOWN") {
              recoveryResult = `ERROR: ${String(recoveryErr).slice(0, 300)}`;
            }
            logger.error("Auto-recovery failed", {
              route: "cron/health-check", vmId: vm.id, vmName: vm.name, result: recoveryResult,
            });
          }

          // Alert with result
          const succeeded = recoveryResult.includes("HEALTHY") || recoveryResult.includes("RESTARTED");
          alerts.add(
            succeeded ? "Auto-Recovery Succeeded" : "Auto-Recovery FAILED — Manual SSH Required",
            vm.name ?? vm.id,
            `Result: ${recoveryResult}\nIP: ${vm.ip_address}\nUser: ${vm.assigned_to ?? "unassigned"}\nFail count at trigger: ${newFailCount}`
          );
        }
      }
    }
  }

  // ========================================================================
  // Second pass: Check for stale Telegram webhooks (we use long-polling)
  // If any bot has a webhook set, it blocks long-polling and the bot goes silent.
  // ========================================================================
  let webhooksFixed = 0;

  const { data: telegramVms } = await supabase
    .from("instaclaw_vms")
    .select("id, name, telegram_bot_token, assigned_to")
    .eq("status", "assigned")
    .not("telegram_bot_token", "is", null);

  if (telegramVms?.length) {
    for (const tgVm of telegramVms) {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${tgVm.telegram_bot_token}/getWebhookInfo`
        );
        const info = await res.json();

        if (info.ok && info.result?.url) {
          // Stale webhook found — delete it so long-polling works
          logger.warn("Stale Telegram webhook detected, auto-deleting", {
            route: "cron/health-check",
            vmId: tgVm.id,
            vmName: tgVm.name,
            staleUrl: info.result.url,
          });

          const delRes = await fetch(
            `https://api.telegram.org/bot${tgVm.telegram_bot_token}/deleteWebhook`
          );
          const delResult = await delRes.json();

          if (delResult.ok) {
            webhooksFixed++;
            logger.info("Stale Telegram webhook deleted successfully", {
              route: "cron/health-check",
              vmId: tgVm.id,
              vmName: tgVm.name,
            });
          } else {
            logger.error("Failed to delete stale Telegram webhook", {
              route: "cron/health-check",
              vmId: tgVm.id,
              error: JSON.stringify(delResult),
            });
          }
        }
      } catch (err) {
        // Non-fatal — don't let one bot's check break the whole cron
        logger.error("Telegram webhook check failed", {
          route: "cron/health-check",
          vmId: tgVm.id,
          error: String(err),
        });
      }
    }
  }

  // ========================================================================
  // Duplicate IP detection
  // If two active VMs share the same IP in the DB, any SSH operation will
  // hit the wrong machine. This caused the Mucus outage where cleanup scripts
  // accidentally blanked a live user's telegram config. Alert immediately
  // and auto-fix by marking the ghost entry (no real Linode) as failed.
  // ========================================================================
  let duplicateIPsFound = 0;

  {
    const { data: allActiveVms } = await supabase
      .from("instaclaw_vms")
      .select("id, name, ip_address, status, assigned_to, provider_server_id")
      .not("status", "in", '("failed","destroyed","terminated")')
      .not("ip_address", "is", null);

    if (allActiveVms?.length) {
      const ipMap = new Map<string, typeof allActiveVms>();
      for (const avm of allActiveVms) {
        if (!avm.ip_address || avm.ip_address === "0.0.0.0") continue;
        if (!ipMap.has(avm.ip_address)) ipMap.set(avm.ip_address, []);
        ipMap.get(avm.ip_address)!.push(avm);
      }

      for (const [ip, group] of ipMap) {
        if (group.length <= 1) continue;
        duplicateIPsFound += group.length;

        const desc = group
          .map((g) => `${g.name ?? g.id} (${g.status}, assigned=${g.assigned_to ?? "none"}, linode=${g.provider_server_id ?? "?"})`)
          .join(", ");

        logger.error("DUPLICATE IP DETECTED — multiple active VMs share the same IP", {
          route: "cron/health-check",
          ip,
          vmCount: group.length,
          vms: desc,
        });

        // Auto-fix: query Linode API for each VM. The one that returns 404 (deleted) is the ghost.
        let autoFixed = false;
        try {
          const { getLinodeStatus } = await import("@/lib/providers/linode");
          for (const g of group) {
            if (!g.provider_server_id) continue;
            const linodeStatus = await getLinodeStatus(g.provider_server_id);
            if (linodeStatus === null) {
              // Linode is gone — this is the ghost record
              logger.warn("Auto-fixing ghost VM (Linode deleted, DB record stale)", {
                route: "cron/health-check", vmId: g.id, vmName: g.name, ip, linodeId: g.provider_server_id,
              });
              await supabase.from("instaclaw_vms")
                .update({ status: "terminated", health_status: "unhealthy" })
                .eq("id", g.id);
              autoFixed = true;
            }
          }
        } catch (fixErr) {
          logger.error("Failed to auto-fix duplicate IP", {
            route: "cron/health-check", ip, error: String(fixErr),
          });
        }

        alerts.add(
          "DUPLICATE IP — Data Integrity Violation [CRITICAL]",
          ip,
          `${group.length} active VMs share IP ${ip}:\n${group.map((g) => `• ${g.name ?? g.id} (${g.status}, linode=${g.provider_server_id ?? "?"})`).join("\n")}` +
          (autoFixed ? `\n\nAuto-fix applied: ghost VM(s) marked as terminated.` : `\n\nAuto-fix could not resolve — both VMs appear alive on Linode. Manual investigation required.`)
        );
      }
    }
  }

  // ========================================================================
  // Telegram duplicate token detection
  // If two VMs share a bot token, both fight over getUpdates and one goes
  // silent. The most recently assigned VM wins — older VMs get their
  // telegram_bot_token nulled out and telegram disabled in openclaw.json.
  // ========================================================================
  let telegramDupesFixed = 0;

  const { data: allTgVms } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user, telegram_bot_token, assigned_to, assigned_at")
    .in("status", ["assigned", "ready"])
    .not("telegram_bot_token", "is", null);

  if (allTgVms && allTgVms.length > 1) {
    // Group by token
    const tokenMap = new Map<string, typeof allTgVms>();
    for (const tvm of allTgVms) {
      const tok = tvm.telegram_bot_token as string;
      if (!tokenMap.has(tok)) tokenMap.set(tok, []);
      tokenMap.get(tok)!.push(tvm);
    }

    for (const [token, group] of tokenMap) {
      if (group.length <= 1) continue;

      // Sort by assigned_at DESC — most recent wins
      group.sort((a, b) => {
        const aDate = a.assigned_at ? new Date(a.assigned_at).getTime() : 0;
        const bDate = b.assigned_at ? new Date(b.assigned_at).getTime() : 0;
        return bDate - aDate;
      });

      const winner = group[0];
      const losers = group.slice(1);

      logger.error("Duplicate Telegram bot token detected", {
        route: "cron/health-check",
        tokenPrefix: token.slice(0, 10) + "...",
        winnerVm: winner.name ?? winner.id,
        loserVms: losers.map((l) => l.name ?? l.id),
      });

      for (const loser of losers) {
        try {
          // Null out the telegram token in the DB
          await supabase
            .from("instaclaw_vms")
            .update({ telegram_bot_token: null })
            .eq("id", loser.id);

          // SSH in and disable telegram in openclaw.json so the gateway
          // stops polling getUpdates for the duplicate token
          try {
            const loserSsh = await connectSSH({
              id: loser.id,
              ip_address: loser.ip_address,
              ssh_port: loser.ssh_port ?? 22,
              ssh_user: loser.ssh_user ?? "openclaw",
            });
            try {
              await loserSsh.execCommand(
                `${NVM_PREAMBLE} && openclaw config set channels.telegram.enabled false 2>/dev/null || true && sed -i 's/"botToken": "[^"]*"/"botToken": ""/' ~/.openclaw/openclaw.json 2>/dev/null || true && rm -f ~/.openclaw/openclaw.json.bak* /tmp/openclaw-backup.json 2>/dev/null || true && export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user restart openclaw-gateway 2>/dev/null || true`,
              );
            } finally {
              loserSsh.dispose();
            }
          } catch {
            // SSH may fail on some VMs — DB null is the critical fix
          }

          telegramDupesFixed++;
          logger.info("Duplicate Telegram token removed from loser VM", {
            route: "cron/health-check",
            loserVm: loser.name ?? loser.id,
            winnerVm: winner.name ?? winner.id,
            tokenPrefix: token.slice(0, 10) + "...",
          });
        } catch (err) {
          logger.error("Failed to fix duplicate Telegram token", {
            route: "cron/health-check",
            vmId: loser.id,
            error: String(err),
          });
        }
      }

      // Alert admin (via digest)
      alerts.add(
        "Duplicate Telegram Bot Token Detected",
        winner.name ?? winner.id,
        `${group.length} VMs share token (${token.slice(0, 10)}...).\nWinner: ${winner.name ?? winner.id}\nLosers (disabled): ${losers.map((l) => l.name ?? l.id).join(", ")}`
      );
    }
  }

  // ========================================================================
  // Ready-pool stale backup token detection
  // Pool VMs (status=ready) should have NO telegram bot tokens on disk.
  // OpenClaw creates .bak files when updating config — if a reclaimed VM
  // still has a token in a .bak file, the gateway will poll getUpdates
  // on restart and fight the rightful owner. Sample up to 5 per cycle.
  // ========================================================================
  let readyPoolTokensCleaned = 0;

  const { data: readyPoolVms } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, ssh_port, ssh_user")
    .eq("status", "ready")
    .limit(5);

  if (readyPoolVms?.length) {
    for (const rvm of readyPoolVms) {
      try {
        const rvmSsh = await connectSSH({
          id: rvm.id,
          ip_address: rvm.ip_address,
          ssh_port: rvm.ssh_port ?? 22,
          ssh_user: rvm.ssh_user ?? "openclaw",
        });
        try {
          const grepResult = await rvmSsh.execCommand(
            `grep -rl "botToken" ~/.openclaw/openclaw.json* 2>/dev/null || true`,
          );
          const filesWithToken = (grepResult.stdout ?? "").trim();
          if (filesWithToken) {
            // Auto-fix: purge backup files, blank token in live config, disable telegram, restart gateway
            await rvmSsh.execCommand(
              `rm -f ~/.openclaw/openclaw.json.bak* /tmp/openclaw-backup.json 2>/dev/null || true`,
            );
            await rvmSsh.execCommand(
              `sed -i 's/"botToken": "[^"]*"/"botToken": ""/' ~/.openclaw/openclaw.json 2>/dev/null || true`,
            );
            await rvmSsh.execCommand(
              `${NVM_PREAMBLE} && openclaw config set channels.telegram.enabled false 2>/dev/null || true`,
            );
            await rvmSsh.execCommand(
              `export XDG_RUNTIME_DIR="/run/user/$(id -u)" && systemctl --user restart openclaw-gateway 2>/dev/null || true`,
            );
            readyPoolTokensCleaned++;
            logger.warn("Ready pool VM had stale telegram token on disk — auto-fixed", {
              route: "cron/health-check",
              vmId: rvm.id,
              vmName: rvm.name,
              filesWithToken,
            });
            alerts.add(
              "Ready Pool VM Has Stale Telegram Token — AUTO-FIXED",
              rvm.name ?? rvm.id,
              `Files with stale token:\n${filesWithToken}\nBackup files purged and telegram disabled in config.`
            );
          }
        } finally {
          rvmSsh.dispose();
        }
      } catch {
        // SSH may fail on some pool VMs — skip silently
      }
    }
  }

  // ========================================================================
  // Telegram token missing detection
  // Alert when a VM has telegram in channels_enabled but telegram_bot_token
  // is NULL. This catches the Feb 18-20 bug (commit 46bd26f) where
  // reconfigures wiped tokens. Alert-only — no auto-fix.
  // ========================================================================
  let telegramTokenMissing = 0;

  const { data: telegramEnabledVms } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, assigned_to")
    .eq("status", "assigned")
    .not("assigned_to", "is", null)
    .contains("channels_enabled", ["telegram"])
    .is("telegram_bot_token", null);

  if (telegramEnabledVms?.length) {
    for (const tvm of telegramEnabledVms) {
      telegramTokenMissing++;

      // Auto-fix: look for the token on the user's previous VM
      let autoFixed = false;
      if (tvm.assigned_to) {
        const { data: oldVms } = await supabase
          .from("instaclaw_vms")
          .select("id, name, telegram_bot_token, telegram_bot_username, telegram_chat_id")
          .eq("last_assigned_to", tvm.assigned_to)
          .not("telegram_bot_token", "is", null)
          .neq("id", tvm.id)
          .limit(1);

        const oldVm = oldVms?.[0];
        if (oldVm?.telegram_bot_token) {
          // Clear token from old VM (releases unique constraint)
          await supabase
            .from("instaclaw_vms")
            .update({
              telegram_bot_token: null,
              telegram_bot_username: null,
              telegram_chat_id: null,
            })
            .eq("id", oldVm.id);

          // Write token to current VM
          await supabase
            .from("instaclaw_vms")
            .update({
              telegram_bot_token: oldVm.telegram_bot_token,
              telegram_bot_username: oldVm.telegram_bot_username,
              telegram_chat_id: oldVm.telegram_chat_id,
            })
            .eq("id", tvm.id);

          // Trigger reconfigure so the gateway picks up the token
          try {
            await fetch(`${process.env.NEXTAUTH_URL}/api/vm/configure`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
              },
              body: JSON.stringify({ userId: tvm.assigned_to, force: true }),
              signal: AbortSignal.timeout(180_000),
            });
          } catch (configErr) {
            logger.error("Telegram auto-fix: reconfigure failed", {
              route: "cron/health-check",
              vmId: tvm.id,
              error: String(configErr),
            });
          }

          autoFixed = true;
          logger.info("Telegram token auto-fixed from old VM", {
            route: "cron/health-check",
            vmId: tvm.id,
            oldVmId: oldVm.id,
            assignedTo: tvm.assigned_to,
          });
        }
      }

      if (autoFixed) {
        alerts.add(
          "Telegram Token Missing — AUTO-FIXED",
          tvm.name ?? tvm.id,
          `User: ${tvm.assigned_to}\nToken recovered from previous VM and reconfigure triggered.`
        );
      } else {
        logger.error("Telegram enabled but bot token missing — cannot auto-fix", {
          route: "cron/health-check",
          vmId: tvm.id,
          vmName: tvm.name,
          ipAddress: tvm.ip_address,
          assignedTo: tvm.assigned_to,
        });
        alerts.add(
          "Telegram Token Missing — CANNOT AUTO-FIX [HIGH]",
          tvm.name ?? tvm.id,
          `User: ${tvm.assigned_to}\nTelegram enabled but bot token is NULL. No previous VM with token found — manual intervention required.`
        );
      }
    }
  }

  // ========================================================================
  // Deaf agent detection: token present but no chat_id after 48h
  // This catches bots that were configured but never received a Telegram
  // message (user never started the bot, or the token is wrong).
  // ========================================================================
  const { data: deafAgentVms } = await supabase
    .from("instaclaw_vms")
    .select("id, name, assigned_to, assigned_at, telegram_bot_username")
    .eq("status", "assigned")
    .not("assigned_to", "is", null)
    .contains("channels_enabled", ["telegram"])
    .not("telegram_bot_token", "is", null)
    .is("telegram_chat_id", null)
    .lt("assigned_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString());

  if (deafAgentVms?.length) {
    for (const dvm of deafAgentVms) {
      logger.warn("Deaf agent: telegram bot never contacted", {
        route: "cron/health-check",
        vmId: dvm.id,
        vmName: dvm.name,
        assignedTo: dvm.assigned_to,
        assignedAt: dvm.assigned_at,
        botUsername: dvm.telegram_bot_username,
      });
      alerts.add(
        "Deaf Agent: Telegram Bot Never Contacted [HIGH]",
        dvm.name ?? dvm.id,
        `User: ${dvm.assigned_to}\nBot: @${dvm.telegram_bot_username ?? "unknown"}\nAssigned: ${dvm.assigned_at}\nToken present but no chat_id after 48h — user may not have started the bot.`
      );
    }
  }

  // ========================================================================
  // Silence detection: flag VMs with no proxy activity despite active Telegram
  // Phase 1: Track last_proxy_call_at staleness. If a VM has Telegram configured
  // and a user assigned, but no API call in 6+ hours, it may be silently dead.
  // ========================================================================
  const SILENCE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours
  const { data: potentiallySilentVms } = await supabase
    .from("instaclaw_vms")
    .select("id, name, assigned_to, last_proxy_call_at, heartbeat_last_at, telegram_bot_username")
    .eq("status", "assigned")
    .not("assigned_to", "is", null)
    .not("telegram_bot_token", "is", null)
    .lt("last_proxy_call_at", new Date(Date.now() - SILENCE_THRESHOLD_MS).toISOString());

  if (potentiallySilentVms?.length) {
    for (const svm of potentiallySilentVms) {
      const lastCall = svm.last_proxy_call_at ? new Date(svm.last_proxy_call_at) : null;
      const hoursStale = lastCall ? Math.round((Date.now() - lastCall.getTime()) / 3_600_000) : 999;
      const lastHb = svm.heartbeat_last_at ? new Date(svm.heartbeat_last_at) : null;
      const hbStale = lastHb ? Math.round((Date.now() - lastHb.getTime()) / 3_600_000) : 999;

      // Only alert if genuinely stale (not just a user who hasn't messaged recently)
      // If heartbeat is also stale, the existing health checks will catch it.
      // We care about: heartbeat OK (gateway alive) but no proxy calls (agent not responding to users)
      if (hbStale < 6 && hoursStale >= 6) {
        logger.warn("Silence detected: gateway alive but no proxy calls", {
          route: "cron/health-check",
          vmId: svm.id,
          vmName: svm.name,
          hoursStale,
          hbStaleHours: hbStale,
        });
        alerts.add(
          "Potential Silent Agent [HIGH]",
          svm.name ?? svm.id,
          `User: ${svm.assigned_to}\nBot: @${svm.telegram_bot_username ?? "unknown"}\nLast proxy call: ${hoursStale}h ago\nLast heartbeat: ${hbStale}h ago\nGateway appears alive but agent hasn't made an API call in ${hoursStale}+ hours.`
        );
      }
    }
  }

  // ========================================================================
  // Third pass: Check for past_due subscriptions and suspend after grace period
  // ========================================================================
  let suspended = 0;

  const { data: pastDueSubscriptions } = await supabase
    .from("instaclaw_subscriptions")
    .select("user_id, past_due_since")
    .eq("payment_status", "past_due")
    .not("past_due_since", "is", null);

  if (pastDueSubscriptions?.length) {
    for (const sub of pastDueSubscriptions) {
      const daysPastDue = Math.floor(
        (Date.now() - new Date(sub.past_due_since).getTime()) / (1000 * 60 * 60 * 24)
      );

      if (daysPastDue >= SUSPENSION_GRACE_DAYS) {
        // Grace period expired, suspend the VM
        const { data: vm } = await supabase
          .from("instaclaw_vms")
          .select("*")
          .eq("assigned_to", sub.user_id)
          .single();

        if (vm && vm.health_status !== "suspended") {
          try {
            // Stop the gateway
            await stopGateway(vm);

            // Mark VM as suspended
            await supabase
              .from("instaclaw_vms")
              .update({
                health_status: "suspended",
                suspended_at: new Date().toISOString(),
                last_health_check: new Date().toISOString(),
              })
              .eq("id", vm.id);

            // Send suspension email
            const { data: user } = await supabase
              .from("instaclaw_users")
              .select("email")
              .eq("id", sub.user_id)
              .single();

            if (user?.email) {
              try {
                await sendSuspendedEmail(user.email);
              } catch (emailErr) {
                logger.error("Failed to send suspended email", {
                  error: String(emailErr),
                  route: "cron/health-check",
                  userId: sub.user_id,
                });
              }
            }

            suspended++;
            logger.info("VM suspended for past_due payment", {
              route: "cron/health-check",
              userId: sub.user_id,
              vmId: vm.id,
              daysPastDue,
            });
          } catch (err) {
            logger.error("Failed to suspend VM", {
              error: String(err),
              route: "cron/health-check",
              userId: sub.user_id,
            });
          }
        }
      }
    }
  }

  // ========================================================================
  // 3b: Suspend VMs assigned to users with NO active subscription
  // Catches grandfathered users who never subscribed and any edge cases.
  // Grace: skip VMs assigned < 3 days ago (mid-checkout protection).
  // ========================================================================
  let noSubSuspended = 0;
  const NO_SUB_GRACE_DAYS = 3;

  const { data: assignedVms } = await supabase
    .from("instaclaw_vms")
    .select("id, assigned_to, assigned_at, health_status, ip_address, ssh_port, ssh_user, gateway_url, gateway_token, name, ssh_fail_count, health_fail_count, config_version, api_mode, proxy_401_count")
    .eq("status", "assigned")
    .not("assigned_to", "is", null)
    .neq("health_status", "suspended")
    .neq("health_status", "hibernating");

  if (assignedVms?.length) {
    for (const vm of assignedVms) {
      // Skip VMs assigned less than 1 day ago (24h grace for WLD users)
      if (vm.assigned_at) {
        const hoursSinceAssign = (Date.now() - new Date(vm.assigned_at).getTime()) / (1000 * 60 * 60);
        if (hoursSinceAssign < 24) continue;
      }

      // Check if user has an active or past_due subscription
      const { data: userSub } = await supabase
        .from("instaclaw_subscriptions")
        .select("status")
        .eq("user_id", vm.assigned_to)
        .single();

      // Skip if user has any active/trialing/past_due subscription
      if (userSub && userSub.status !== "canceled") continue;

      // Skip if user still has credits
      const { data: vmCredits } = await supabase
        .from("instaclaw_vms")
        .select("credit_balance")
        .eq("id", vm.id)
        .single();
      if ((vmCredits?.credit_balance ?? 0) > 0) continue;

      // No subscription or canceled, AND no credits — hibernate (not suspend)
      try {
        const { data: fullVm } = await supabase
          .from("instaclaw_vms")
          .select("*")
          .eq("id", vm.id)
          .single();

        if (fullVm) {
          await stopGateway(fullVm);
        }

        await supabase
          .from("instaclaw_vms")
          .update({
            health_status: "hibernating",
            suspended_at: new Date().toISOString(),
            last_health_check: new Date().toISOString(),
          })
          .eq("id", vm.id);

        noSubSuspended++;
        logger.info("VM suspended — no active subscription", {
          route: "cron/health-check",
          userId: vm.assigned_to,
          vmId: vm.id,
          vmName: vm.name,
          subStatus: userSub?.status ?? "none",
        });
      } catch (err) {
        logger.error("Failed to suspend no-sub VM", {
          error: String(err),
          route: "cron/health-check",
          userId: vm.assigned_to,
          vmId: vm.id,
        });
      }
    }
  }

  // ========================================================================
  // 3c: Reclaim VMs suspended > 30 days (wipe data + return to pool)
  // This is the ONLY path that wipes user data.
  // ========================================================================
  let reclaimed = 0;
  const RECLAIM_AFTER_DAYS = 30;

  const { data: staleSupended } = await supabase
    .from("instaclaw_vms")
    .select("id, assigned_to, suspended_at, ip_address, ssh_port, ssh_user, name")
    .eq("health_status", "suspended")
    .not("suspended_at", "is", null)
    .not("assigned_to", "is", null);

  if (staleSupended?.length) {
    for (const vm of staleSupended) {
      const daysSuspended = (Date.now() - new Date(vm.suspended_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSuspended < RECLAIM_AFTER_DAYS) continue;

      try {
        // Stamp last_assigned_to before reclaim
        await supabase
          .from("instaclaw_vms")
          .update({ last_assigned_to: vm.assigned_to })
          .eq("id", vm.id);

        // Reclaim via DB (clears assignment, tokens, config)
        await supabase.rpc("instaclaw_reclaim_vm", {
          p_user_id: vm.assigned_to,
        });

        // Wipe filesystem
        const wipeResult = await wipeVMForNextUser(vm);
        if (wipeResult.success) {
          await supabase
            .from("instaclaw_vms")
            .update({ status: "ready", suspended_at: null })
            .eq("id", vm.id);
        } else {
          logger.error("VM wipe failed during 30-day reclaim", {
            route: "cron/health-check",
            vmId: vm.id,
            error: wipeResult.error,
          });
        }

        reclaimed++;
        logger.info("VM reclaimed after 30-day suspension", {
          route: "cron/health-check",
          userId: vm.assigned_to,
          vmId: vm.id,
          vmName: vm.name,
          daysSuspended: Math.floor(daysSuspended),
        });
      } catch (err) {
        logger.error("Failed to reclaim suspended VM", {
          error: String(err),
          route: "cron/health-check",
          vmId: vm.id,
          userId: vm.assigned_to,
        });
      }
    }
  }

  // ========================================================================
  // Fourth pass: Config audit for stale-version VMs
  // Only audit healthy VMs (no point fixing config on a down gateway).
  // Staggered: limit to CONFIG_AUDIT_BATCH_SIZE per cycle to avoid timeout.
  // ========================================================================
  let configsAudited = 0;
  let configsFixed = 0;

  // Reconcile ANY assigned VM with stale config — not just healthy ones.
  // Previously required healthyVmIds.has(vm.id) which skipped freshly
  // configured VMs (health=unknown) and unhealthy VMs permanently.
  const staleVms = sshAliveVms.filter(
    (vm) => (vm.config_version ?? 0) < VM_MANIFEST.version
  );

  const auditBatch = staleVms.slice(0, CONFIG_AUDIT_BATCH_SIZE);

  for (const vm of auditBatch) {
    try {
      const auditResult = await auditVMConfig(vm);
      configsAudited++;

      if (auditResult.fixed.length > 0) {
        configsFixed++;
        logger.info("Config drift fixed", {
          route: "cron/health-check",
          vmId: vm.id,
          vmName: vm.name,
          fixed: auditResult.fixed,
          alreadyCorrect: auditResult.alreadyCorrect,
          missingFiles: auditResult.missingFiles,
        });
      }

      if (auditResult.missingFiles.length > 0) {
        logger.warn("Required workspace files missing", {
          route: "cron/health-check",
          vmId: vm.id,
          vmName: vm.name,
          missingFiles: auditResult.missingFiles,
        });
      }

      // Update config_version — even if nothing was fixed, the check passed
      await supabase
        .from("instaclaw_vms")
        .update({ config_version: VM_MANIFEST.version })
        .eq("id", vm.id);
    } catch (err) {
      logger.error("Config audit failed", {
        error: String(err),
        route: "cron/health-check",
        vmId: vm.id,
        vmName: vm.name,
      });
    }
  }

  // Fifth pass: MEMORY.md ensure — REMOVED (absorbed into VM Manifest reconciliation).
  // MEMORY.md is now a create_if_missing entry in VM_MANIFEST.files, deployed
  // by reconcileVM() during the config audit pass above.
  const memoryFilesCreated = 0;

  // ========================================================================
  // Fifth-a pass: Tier sync — ensure VM tier matches subscription tier
  // The billing webhook is supposed to update instaclaw_vms.tier on upgrade,
  // but it can silently fail (transient DB error, webhook not delivered).
  // This pass checks ALL assigned VMs and fixes any tier mismatch.
  // P0 fix: "Not Bored Kid" upgraded to Pro but VM stayed on Starter,
  // giving 600/day limit instead of 1000/day for days.
  // ========================================================================
  let tierSynced = 0;
  try {
    // Batch-fetch all active/trialing subscriptions
    const { data: activeSubs } = await supabase
      .from("instaclaw_subscriptions")
      .select("user_id, tier")
      .in("status", ["active", "trialing"]);

    if (activeSubs?.length) {
      // Build lookup: user_id → subscription tier
      const subTierMap: Record<string, string> = {};
      for (const sub of activeSubs) {
        subTierMap[sub.user_id] = sub.tier;
      }

      // Check all assigned VMs for tier mismatch
      for (const vm of vms) {
        if (!vm.assigned_to) continue;
        const subTier = subTierMap[vm.assigned_to];
        if (!subTier) continue; // No active subscription

        if (vm.tier && vm.tier !== subTier) {
          await supabase
            .from("instaclaw_vms")
            .update({ tier: subTier })
            .eq("id", vm.id);
          tierSynced++;
          logger.warn("Tier sync: VM tier corrected to match subscription", {
            route: "cron/health-check",
            vmId: vm.id,
            vmName: vm.name,
            oldTier: vm.tier,
            newTier: subTier,
            userId: vm.assigned_to,
          });
        }
      }
    }
  } catch (err) {
    logger.error("Tier sync pass failed", {
      route: "cron/health-check",
      error: String(err),
    });
  }

  // ========================================================================
  // Fifth-b pass: Periodic cron + script audit (defense-in-depth)
  // Checks BOTH assigned AND ready pool VMs for missing crons + script files.
  // The reconciler only runs on stale-version VMs, so snapshot VMs and ready
  // pool VMs can have missing scripts/crons indefinitely. This pass:
  // 1. Picks 5 random assigned VMs + ALL ready pool VMs
  // 2. Checks for missing cron entries and installs them
  // 3. Checks for missing script files and deploys them
  // P0 fix for the 2026-04-08 missing crons incident.
  // ========================================================================
  let cronAuditChecked = 0;
  let cronAuditFixed = 0;
  const CRON_AUDIT_BATCH = 5;

  // Build the list of script files that crons depend on
  const CRITICAL_SCRIPTS: { name: string; templateKey: string }[] = [];
  for (const file of VM_MANIFEST.files) {
    if (
      file.remotePath.includes("/.openclaw/scripts/") &&
      "templateKey" in file &&
      file.templateKey
    ) {
      const name = file.remotePath.split("/").pop()!;
      CRITICAL_SCRIPTS.push({ name, templateKey: file.templateKey as string });
    }
  }

  // Include ready pool VMs — query separately since they're not in sshAliveVms
  let cronAuditReadyPool: any[] = [];
  try {
    const { data: cronReadyVms } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, gateway_url, health_status, gateway_token, health_fail_count, ssh_fail_count, assigned_to, name, config_version, tier, default_model, api_mode, channels_enabled, credit_balance")
      .eq("status", "ready");
    cronAuditReadyPool = cronReadyVms ?? [];
  } catch { /* non-fatal */ }

  // Memory health tracking (populated by functional checks below)
  const memoryScores: number[] = [];
  let memoryDegraded = 0;
  let hookNeverFired = 0;
  let missingSoulFiling = 0;

  // 5 random assigned + all ready pool
  const cronAuditAssigned = sshAliveVms
    .sort(() => Math.random() - 0.5)
    .slice(0, CRON_AUDIT_BATCH);
  const cronAuditVms: any[] = [...cronAuditAssigned, ...cronAuditReadyPool];

  for (const vm of cronAuditVms) {
    try {
      const ssh = await connectSSH(vm);
      try {
        // 1. Check crons
        const markers = VM_MANIFEST.cronJobs.map((j) => j.marker);
        const checkCmd = markers
          .map((m) => `crontab -l 2>/dev/null | grep -qF "${m}" && echo P || echo A`)
          .join("; ");
        const result = await ssh.execCommand(checkCmd);
        const statuses = result.stdout.trim().split("\n");
        const missingCrons = markers.filter((_, i) => statuses[i]?.trim() === "A");

        // 2. Check script files
        const scriptCheckCmd = CRITICAL_SCRIPTS
          .map((s) => `test -f ~/.openclaw/scripts/${s.name} && echo P || echo A`)
          .join("; ");
        const scriptResult = await ssh.execCommand(scriptCheckCmd);
        const scriptStatuses = scriptResult.stdout.trim().split("\n");
        const missingScripts = CRITICAL_SCRIPTS.filter((_, i) => scriptStatuses[i]?.trim() === "A");

        cronAuditChecked++;

        // 3. Install missing crons
        if (missingCrons.length > 0) {
          for (const job of VM_MANIFEST.cronJobs) {
            if (!missingCrons.includes(job.marker)) continue;
            const cronLine = `${job.schedule} ${job.command}`;
            const cronB64 = Buffer.from(cronLine).toString("base64");
            await ssh.execCommand(
              `(crontab -l 2>/dev/null; echo '${cronB64}' | base64 -d) | crontab -`
            );
          }
        }

        // 4. Deploy missing scripts
        if (missingScripts.length > 0) {
          await ssh.execCommand("mkdir -p ~/.openclaw/scripts");
          for (const s of missingScripts) {
            try {
              const content = getTemplateContent(s.templateKey);
              const b64 = Buffer.from(content).toString("base64");
              await ssh.execCommand(
                `echo '${b64}' | base64 -d > ~/.openclaw/scripts/${s.name} && chmod +x ~/.openclaw/scripts/${s.name}`
              );
            } catch {
              // Template not registered yet — skip, will catch next cycle
            }
          }
        }

        if (missingCrons.length > 0 || missingScripts.length > 0) {
          cronAuditFixed++;
          logger.warn("Cron audit: fixed missing crons/scripts", {
            route: "cron/health-check",
            vmId: vm.id,
            vmName: vm.name,
            missingCrons,
            missingScripts: missingScripts.map((s) => s.name),
            configVersion: vm.config_version,
          });
        }

        // 5. FUNCTIONAL checks + memory health score
        // Checks crons produce output AND scores memory system health (0-100)
        if (vm.assigned_to) {
          const funcCheck = await ssh.execCommand(`
            ST=0; MI=0; SL=0; MEM=0; AT=0; HK=0; SOUL=0
            # strip-thinking: log modified in last 60 min? (not scored, just functional)
            [ -f ~/.openclaw/logs/strip-thinking.log ] && \
              find ~/.openclaw/logs/strip-thinking.log -mmin -60 -print -quit | grep -q . && ST=1
            # memory index: DB > 4096 bytes? (25 pts)
            for db in $(find ~/.openclaw -name "main.sqlite" -path "*/memory/*" 2>/dev/null | head -1); do
              [ -f "$db" ] && [ $(wc -c < "$db") -gt 4096 ] && MI=1
            done
            # MEMORY.md > 200 bytes? (20 pts)
            [ -f ~/.openclaw/workspace/MEMORY.md ] && [ $(wc -c < ~/.openclaw/workspace/MEMORY.md) -gt 200 ] && MEM=1
            # session-log.md > 4 lines? (20 pts)
            [ -f ~/.openclaw/workspace/memory/session-log.md ] && \
              [ $(wc -l < ~/.openclaw/workspace/memory/session-log.md) -gt 4 ] && SL=1
            # active-tasks.md > 4 lines? (10 pts)
            [ -f ~/.openclaw/workspace/memory/active-tasks.md ] && \
              [ $(wc -l < ~/.openclaw/workspace/memory/active-tasks.md) -gt 4 ] && AT=1
            # hook fired in last 7 days? (25 pts)
            [ -f ~/.openclaw/logs/strip-thinking.log ] && \
              grep -q "session-end-hook" ~/.openclaw/logs/strip-thinking.log && HK=1
            # SOUL.md has memory filing? (not scored, but tracked)
            grep -q "MEMORY_FILING_SYSTEM" ~/.openclaw/workspace/SOUL.md 2>/dev/null && SOUL=1
            # OpenClaw version matches pin?
            VER_OK=0
            PKG=$(find ~/.nvm/versions/node/*/lib/node_modules/openclaw/package.json 2>/dev/null | tail -1)
            if [ -n "$PKG" ]; then
              INSTALLED=$(python3 -c "import json; print(json.load(open('$PKG')).get('version',''))" 2>/dev/null)
              [ "$INSTALLED" = "${OPENCLAW_PINNED_VERSION}" ] && VER_OK=1
            fi
            echo "$ST|$MI|$MEM|$SL|$AT|$HK|$SOUL|$VER_OK"
          `);
          const parts = funcCheck.stdout.trim().split("|").map((s) => s.trim() === "1");
          const [stOk, miOk, memOk, slOk, atOk, hkOk, soulOk, verOk] = parts;

          // Flag version mismatch
          if (!verOk) {
            logger.warn("OpenClaw version mismatch detected", {
              route: "cron/health-check",
              vmId: vm.id,
              vmName: vm.name,
              pinnedVersion: OPENCLAW_PINNED_VERSION,
            });
          }

          // Compute memory score (0-100)
          let memScore = 0;
          if (memOk) memScore += 20;   // MEMORY.md has content
          if (slOk) memScore += 20;    // session-log has entries
          if (atOk) memScore += 10;    // active-tasks has entries
          if (hkOk) memScore += 25;    // hook has fired
          if (miOk) memScore += 25;    // memory index has data
          memoryScores.push(memScore);

          if (memScore < 50) {
            memoryDegraded++;
          }
          if (!hkOk) hookNeverFired++;
          if (!soulOk) missingSoulFiling++;

          // Log functional issues
          const funcIssues: string[] = [];
          if (!stOk) funcIssues.push("strip-thinking-stale");
          if (!miOk) funcIssues.push("memory-index-empty");
          if (!slOk) funcIssues.push("session-log-empty");
          if (memScore < 50) funcIssues.push(`memory_degraded(${memScore})`);
          if (funcIssues.length > 0) {
            logger.warn("Functional check: issues detected", {
              route: "cron/health-check",
              vmId: vm.id,
              vmName: vm.name,
              memoryScore: memScore,
              issues: funcIssues,
            });
          }
        }
      } finally {
        ssh.dispose();
      }
    } catch {
      // Non-fatal — will catch this VM on a future cycle
    }
  }

  // ========================================================================
  // Sixth pass: Memory health monitoring
  // Check MEMORY.md size and staleness on healthy VMs.
  // MEMORY_EMPTY: <=200 bytes, assigned 48h+, session > 10KB → admin alert
  // MEMORY_STALE: not modified 72h+, active sessions → log warning
  // Batch of 5 VMs per cycle (same pattern as MEMORY.md ensure pass)
  // ========================================================================
  let memoryEmptyAlerts = 0;
  let memoryStaleWarnings = 0;
  let memoryOversizedAlerts = 0;
  let hygieneOk = 0;
  let hygieneStale = 0;
  let hygieneNever = 0;
  const MEMORY_EMPTY_THRESHOLD = 200;   // bytes — effectively empty
  const MEMORY_STALE_HOURS = 72;        // hours without update
  const MEMORY_MIN_SESSION_BYTES = 10 * 1024; // 10KB — VM must have meaningful session
  const MEMORY_ASSIGNED_HOURS = 48;     // VM must be assigned 48h+ for empty alert
  const HYGIENE_STALE_HOURS = 48;       // daily_hygiene should run every ~23h; 48h = missed 2 cycles
  const MEMORY_OVERSIZED_BYTES = 25 * 1024; // 25KB — MEMORY.md is getting too large for bootstrap injection

  const memoryHealthBatch = vms
    .filter((vm) => healthyVmIds.has(vm.id))
    .slice(0, 5);

  for (const vm of memoryHealthBatch) {
    try {
      const memHealth = await checkMemoryHealth(vm);
      if (!memHealth.reachable) continue;

      const nowEpoch = Math.floor(Date.now() / 1000);

      // daily_hygiene() monitoring — check if strip-thinking.py's cleanup has run recently
      try {
        const ssh = await connectSSH(vm);
        try {
          const markerResult = await ssh.execCommand(
            "stat -c %Y ~/.openclaw/agents/main/sessions/.last-session-cleanup 2>/dev/null || echo 0"
          );
          const markerEpoch = parseInt(markerResult.stdout.trim()) || 0;
          if (markerEpoch === 0) {
            hygieneNever++;
          } else {
            const hoursSinceHygiene = (nowEpoch - markerEpoch) / 3600;
            if (hoursSinceHygiene <= HYGIENE_STALE_HOURS) {
              hygieneOk++;
            } else {
              hygieneStale++;
              logger.warn("daily_hygiene stale", {
                route: "cron/health-check",
                vmId: vm.id,
                vmName: vm.name,
                hoursSinceHygiene: Math.round(hoursSinceHygiene),
              });
            }
          }
        } finally {
          ssh.dispose();
        }
      } catch {
        // SSH failed for hygiene check — don't block memory health pass
      }
      const hoursSinceMemUpdate = memHealth.memMtimeEpoch > 0
        ? (nowEpoch - memHealth.memMtimeEpoch) / 3600
        : Infinity;

      // Get session info to check if VM has meaningful activity
      const sessionHealth = await checkSessionHealth(vm);
      const hasActiveSessions = sessionHealth.largestSessionBytes > MEMORY_MIN_SESSION_BYTES;

      // Check assignment duration
      const assignedAt = (vm as Record<string, unknown>).assigned_at as string | undefined;
      const hoursSinceAssigned = assignedAt
        ? (Date.now() - new Date(assignedAt).getTime()) / (1000 * 3600)
        : Infinity;

      // MEMORY_EMPTY: tiny MEMORY.md on a VM that's been assigned 48h+ with active sessions
      if (memHealth.memSizeBytes <= MEMORY_EMPTY_THRESHOLD
        && hoursSinceAssigned >= MEMORY_ASSIGNED_HOURS
        && hasActiveSessions
      ) {
        memoryEmptyAlerts++;
        logger.error("Memory empty on active VM", {
          route: "cron/health-check",
          vmId: vm.id,
          vmName: vm.name,
          memSizeBytes: memHealth.memSizeBytes,
          hoursSinceAssigned: Math.round(hoursSinceAssigned),
          largestSessionBytes: sessionHealth.largestSessionBytes,
          assignedTo: vm.assigned_to,
        });

        // Alert admin (via digest)
        alerts.add(
          "Memory Empty Alert",
          vm.name ?? vm.id,
          `MEMORY.md: ${memHealth.memSizeBytes} bytes\nAssigned ${Math.round(hoursSinceAssigned)}h ago\nLargest session: ${Math.round(sessionHealth.largestSessionBytes / 1024)}KB\nUser: ${vm.assigned_to ?? "unknown"}`
        );
      }

      // MEMORY_STALE: MEMORY.md not updated in 72h+ with active sessions
      if (hoursSinceMemUpdate > MEMORY_STALE_HOURS && hasActiveSessions) {
        memoryStaleWarnings++;
        logger.warn("Memory stale on active VM", {
          route: "cron/health-check",
          vmId: vm.id,
          vmName: vm.name,
          memSizeBytes: memHealth.memSizeBytes,
          hoursSinceMemUpdate: Math.round(hoursSinceMemUpdate),
          largestSessionBytes: sessionHealth.largestSessionBytes,
          assignedTo: vm.assigned_to,
        });
      }

      // MEMORY_OVERSIZED: MEMORY.md exceeds 25KB — risks truncation during bootstrap injection.
      // bootstrapMaxChars is 30K, so 25KB is the warning threshold before content gets lost.
      if (memHealth.memSizeBytes > MEMORY_OVERSIZED_BYTES) {
        memoryOversizedAlerts++;
        logger.warn("Memory oversized — bootstrap truncation risk", {
          route: "cron/health-check",
          vmId: vm.id,
          vmName: vm.name,
          memSizeBytes: memHealth.memSizeBytes,
          memSizeKB: Math.round(memHealth.memSizeBytes / 1024),
          bootstrapMaxChars: 30000,
          assignedTo: vm.assigned_to,
        });

        alerts.add(
          "Memory Oversized",
          vm.name ?? vm.id,
          `MEMORY.md: ${Math.round(memHealth.memSizeBytes / 1024)}KB (limit: 25KB)\nAgent may lose context from truncated memory.\nUser: ${vm.assigned_to ?? "unknown"}\nAction: Review and trim MEMORY.md or extract critical info into WALLET.md.`
        );
      }
    } catch (err) {
      logger.error("Memory health check failed", {
        error: String(err),
        route: "cron/health-check",
        vmId: vm.id,
        vmName: vm.name,
      });
    }
  }

  // ========================================================================
  // Session corruption detection — check for filename/header ID mismatches
  // that cause the gateway to produce empty responses. The on-VM cron
  // (session-heal-cron.sh) auto-fixes these, but this pass detects VMs
  // where the cron isn't installed or hasn't fired yet.
  // Batch of 5 healthy VMs per cycle (rotated via modular offset).
  // ========================================================================
  let sessionCorruptionChecked = 0;
  let sessionCorruptionFound = 0;
  const SESSION_CORRUPTION_BATCH = 5;

  const corruptionCheckBatch = vms
    .filter((vm) => healthyVmIds.has(vm.id))
    .slice(0, SESSION_CORRUPTION_BATCH);

  for (const vm of corruptionCheckBatch) {
    try {
      const result = await checkSessionCorruption(vm);
      if (!result.reachable) continue;
      sessionCorruptionChecked++;

      if (result.corruptedCount > 0) {
        sessionCorruptionFound += result.corruptedCount;
        logger.error("Session file corruption detected", {
          route: "cron/health-check",
          vmId: vm.id,
          vmName: vm.name,
          corruptedCount: result.corruptedCount,
          corruptedFiles: result.corruptedFiles,
          assignedTo: vm.assigned_to,
        });

        alerts.add(
          "Session Corruption",
          vm.name ?? vm.id,
          `${result.corruptedCount} corrupted session file(s)\nFiles: ${result.corruptedFiles.join(", ")}\nUser: ${vm.assigned_to ?? "unknown"}\nThe on-VM cron should auto-heal this within 60s.`
        );
      }
    } catch (err) {
      logger.error("Session corruption check failed", {
        error: String(err),
        route: "cron/health-check",
        vmId: vm.id,
        vmName: vm.name,
      });
    }
  }

  // ========================================================================
  // VM-side token drift detection (runs every cycle for ALL healthy VMs)
  // SSHes into the VM, reads auth-profiles.json, compares token against DB.
  // Catches the Mucus scenario: DB token changed but VM still has old token.
  // The proxy round-trip pass (below) can't catch this because it tests with
  // the DB token, which always matches itself. This check verifies the VM side.
  // ========================================================================
  let tokenDriftChecked = 0;
  let tokenDriftFixed = 0;
  const TOKEN_DRIFT_BATCH_SIZE = 10;
  // Track VMs resynced by drift check — skip them in proxy round-trip to prevent
  // double rotation that overwrites previous_gateway_token and breaks grace period
  const driftResyncedVmIds = new Set<string>();

  const tokenDriftBatch = vms
    .filter(
      (vm) =>
        healthyVmIds.has(vm.id) &&
        vm.api_mode === "all_inclusive" &&
        vm.gateway_token &&
        vm.health_status !== "proxy_quarantined"
    )
    .slice(0, TOKEN_DRIFT_BATCH_SIZE);

  for (const vm of tokenDriftBatch) {
    try {
      const driftResult = await checkVMTokenDrift(vm as Parameters<typeof checkVMTokenDrift>[0]);
      tokenDriftChecked++;

      if (driftResult.drifted) {
        logger.warn("TOKEN_AUDIT: VM-side token drift detected by health cron", {
          route: "cron/health-check",
          vmId: vm.id,
          vmName: vm.name,
          vmToken: driftResult.vmToken ?? "unknown",
          dbToken: driftResult.dbToken ?? "unknown",
          reason: driftResult.reason,
        });

        // Auto-fix: resync all 4 token locations immediately
        try {
          const resyncResult = await resyncGatewayToken(vm as Parameters<typeof resyncGatewayToken>[0], { apiMode: vm.api_mode ?? undefined });

          if (resyncResult.healthy) {
            tokenDriftFixed++;
            driftResyncedVmIds.add(vm.id);
            logger.info("TOKEN_AUDIT: VM-side token drift auto-fixed", {
              route: "cron/health-check",
              vmId: vm.id,
              vmName: vm.name,
              newTokenPrefix: resyncResult.gatewayToken.slice(0, 8),
              healthy: resyncResult.healthy,
            });
          } else {
            logger.error("TOKEN_AUDIT: resync completed but gateway not healthy", {
              route: "cron/health-check",
              vmId: vm.id,
              vmName: vm.name,
            });
          }
        } catch (resyncErr) {
          logger.error("TOKEN_AUDIT: auto-resync failed for drifted token", {
            route: "cron/health-check",
            vmId: vm.id,
            vmName: vm.name,
            error: String(resyncErr),
          });
        }
      }
    } catch (err) {
      logger.error("Token drift check failed", {
        error: String(err),
        route: "cron/health-check",
        vmId: vm.id,
      });
    }
  }

  // ========================================================================
  // Proxy round-trip + token verification for healthy VMs
  // Catches VMs that pass local health check but have broken proxy auth
  // (the EuroPartShop / VM-058 scenarios).
  // On failure: auto-resync token, re-test, only count failure if resync
  // didn't fix it. Escalate admin alert after PROXY_401_THRESHOLD.
  // ========================================================================
  let proxyChecked = 0;
  let proxyFailed = 0;
  let proxyResynced = 0;
  let proxyQuarantined = 0;
  const PROXY_CHECK_BATCH_SIZE = 5;
  const PROXY_401_THRESHOLD = 3;

  const proxyCheckBatch = vms
    .filter(
      (vm) =>
        healthyVmIds.has(vm.id) &&
        vm.api_mode === "all_inclusive" &&
        vm.gateway_token &&
        // Skip VMs already proxy-quarantined — require manual review
        vm.health_status !== "proxy_quarantined" &&
        // Skip VMs just resynced by drift check — double rotation overwrites
        // previous_gateway_token and breaks the grace period
        !driftResyncedVmIds.has(vm.id)
    )
    .slice(0, PROXY_CHECK_BATCH_SIZE);

  for (const vm of proxyCheckBatch) {
    try {
      const result = await testProxyRoundTrip(vm.gateway_token!, 1);
      proxyChecked++;

      if (!result.success) {
        const currentCount = vm.proxy_401_count ?? 0;

        // If already at threshold, quarantine immediately — don't keep resyncing
        if (currentCount >= PROXY_401_THRESHOLD) {
          proxyQuarantined++;
          await supabase
            .from("instaclaw_vms")
            .update({
              health_status: "proxy_quarantined",
              proxy_401_count: currentCount + 1,
              last_health_check: new Date().toISOString(),
            })
            .eq("id", vm.id);

          logger.error("VM proxy-quarantined: repeated proxy auth failures after resync", {
            route: "cron/health-check",
            vmId: vm.id,
            vmName: vm.name,
            proxy401Count: currentCount + 1,
            assignedTo: vm.assigned_to,
          });

          alerts.add(
            "VM Proxy-Quarantined: Auth Chain Broken",
            vm.name ?? vm.id,
            `IP: ${vm.ip_address}\nUser: ${vm.assigned_to}\nProxy failures: ${currentCount + 1}\nACTION: Manual review needed.`
          );
          continue;
        }

        logger.warn("Proxy round-trip failed — attempting auto-resync", {
          route: "cron/health-check",
          vmId: vm.id,
          vmName: vm.name,
          error: result.error,
          proxy401Count: currentCount,
        });

        // Auto-resync: patch the gateway token on the VM to match DB
        let resyncFixed = false;
        try {
          const resyncResult = await resyncGatewayToken(vm, { apiMode: vm.api_mode ?? undefined });
          if (resyncResult.healthy) {
            // Re-test proxy with the (potentially refreshed) token
            const retest = await testProxyRoundTrip(resyncResult.gatewayToken, 1);
            if (retest.success) {
              resyncFixed = true;
              proxyResynced++;

              logger.info("Auto-resync fixed proxy auth", {
                route: "cron/health-check",
                vmId: vm.id,
                vmName: vm.name,
              });

              // Reset failure counter
              await supabase
                .from("instaclaw_vms")
                .update({ proxy_401_count: 0 })
                .eq("id", vm.id);
            }
          }
        } catch (resyncErr) {
          logger.error("Auto-resync failed during proxy check", {
            error: String(resyncErr),
            route: "cron/health-check",
            vmId: vm.id,
          });
        }

        if (!resyncFixed) {
          // Resync didn't fix it — increment failure counter
          proxyFailed++;
          const newCount = currentCount + 1;

          await supabase
            .from("instaclaw_vms")
            .update({ proxy_401_count: newCount })
            .eq("id", vm.id);

          logger.warn("Proxy still failing after auto-resync", {
            route: "cron/health-check",
            vmId: vm.id,
            vmName: vm.name,
            error: result.error,
            proxy401Count: newCount,
          });

          // Alert admin at threshold (quarantine happens next cycle)
          if (newCount >= PROXY_401_THRESHOLD) {
            alerts.add(
              "Proxy Auth Failure — Quarantine Pending",
              vm.name ?? vm.id,
              `Failures: ${newCount}\nUser: ${vm.assigned_to}\nError: ${result.error}\nWill be quarantined next cycle.`
            );
          }
        }
      } else {
        // Proxy OK — reset counter if it was previously non-zero
        if ((vm.proxy_401_count ?? 0) > 0) {
          await supabase
            .from("instaclaw_vms")
            .update({ proxy_401_count: 0 })
            .eq("id", vm.id);
        }
      }
    } catch (err) {
      logger.error("Proxy round-trip check failed", {
        error: String(err),
        route: "cron/health-check",
        vmId: vm.id,
      });
    }
  }

  // ========================================================================
  // Final pass: SSH check on "ready" pool VMs (not yet assigned)
  // Catches broken VMs sitting in the pool before a user gets assigned one.
  // ========================================================================
  let poolSshChecked = 0;
  let poolSshQuarantined = 0;

  const { data: readyVms } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, name, ssh_fail_count")
    .eq("status", "ready")
    .limit(5); // Check up to 5 per cycle to avoid timeout

  if (readyVms?.length) {
    for (const rvm of readyVms) {
      const sshOk = await checkSSHConnectivity({
        id: rvm.id,
        ip_address: rvm.ip_address,
        ssh_port: rvm.ssh_port ?? 22,
        ssh_user: rvm.ssh_user ?? "openclaw",
      });
      poolSshChecked++;

      if (sshOk) {
        if ((rvm.ssh_fail_count ?? 0) > 0) {
          await supabase
            .from("instaclaw_vms")
            .update({ ssh_fail_count: 0 })
            .eq("id", rvm.id);
        }
        continue;
      }

      const newCount = (rvm.ssh_fail_count ?? 0) + 1;

      if (newCount >= SSH_QUARANTINE_THRESHOLD) {
        // Before quarantining, try gateway HTTP health as fallback
        let gatewayAlive = false;
        try {
          const gwRes = await fetch(`http://${rvm.ip_address}:18789/health`, {
            signal: AbortSignal.timeout(10000),
          });
          gatewayAlive = gwRes.ok;
        } catch {
          // Gateway unreachable — proceed with quarantine
        }

        if (gatewayAlive) {
          // Gateway is alive despite SSH failure — false positive, skip quarantine
          logger.info("Pool VM: SSH failed but gateway HTTP health OK — skipping quarantine", {
            route: "cron/health-check",
            vmId: rvm.id,
            vmName: rvm.name,
            ipAddress: rvm.ip_address,
            sshFailCount: newCount,
          });

          await supabase
            .from("instaclaw_vms")
            .update({ ssh_fail_count: 0 })
            .eq("id", rvm.id);
        } else {
          // Both SSH and HTTP failed — quarantine
          poolSshQuarantined++;
          await supabase
            .from("instaclaw_vms")
            .update({
              status: "failed" as const,
              health_status: "unhealthy",
              ssh_fail_count: newCount,
            })
            .eq("id", rvm.id);

          logger.error("Ready VM auto-quarantined: SSH unreachable", {
            route: "cron/health-check",
            vmId: rvm.id,
            vmName: rvm.name,
            ipAddress: rvm.ip_address,
            sshFailCount: newCount,
          });

          alerts.add(
            "Pool VM Auto-Quarantined: SSH Dead",
            rvm.name ?? rvm.id,
            `IP: ${rvm.ip_address}\nSSH failures: ${newCount}\nNever assigned to a user.`
          );
        }
      } else {
        await supabase
          .from("instaclaw_vms")
          .update({ ssh_fail_count: newCount })
          .eq("id", rvm.id);

        logger.warn("Ready pool VM SSH check failed", {
          route: "cron/health-check",
          vmId: rvm.id,
          vmName: rvm.name,
          sshFailCount: newCount,
        });
      }
    }
  }

  // ========================================================================
  // Auto-recovery pass: Un-quarantine VMs whose gateways are actually healthy
  // Catches false positives like Renata's VM-24 incident (Feb 20, 2026)
  // ========================================================================
  let recovered = 0;

  const { data: quarantinedVms } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, name, assigned_to, ssh_fail_count, cloud_reboot_count")
    .eq("status", "failed")
    .not("ip_address", "is", null);

  if (quarantinedVms?.length) {
    for (const qvm of quarantinedVms) {
      try {
        const gwRes = await fetch(`http://${qvm.ip_address}:18789/health`, {
          signal: AbortSignal.timeout(10000),
        });

        if (gwRes.ok) {
          // Gateway is healthy — this was a false positive quarantine
          const newStatus = qvm.assigned_to ? "assigned" : "ready";

          await supabase
            .from("instaclaw_vms")
            .update({
              status: newStatus as "assigned" | "ready",
              health_status: "healthy",
              ssh_fail_count: 0,
              cloud_reboot_count: 0,
              last_health_check: new Date().toISOString(),
            })
            .eq("id", qvm.id);

          recovered++;

          logger.info("VM auto-recovered: gateway HTTP health OK", {
            route: "cron/health-check",
            vmId: qvm.id,
            vmName: qvm.name,
            ipAddress: qvm.ip_address,
            newStatus,
            assignedTo: qvm.assigned_to,
            previousSshFailCount: qvm.ssh_fail_count,
          });

          alerts.add(
            "VM Auto-Recovered from Quarantine",
            qvm.name ?? qvm.id,
            `IP: ${qvm.ip_address}\nRestored to: "${newStatus}"\nUser: ${qvm.assigned_to ?? "none (pool VM)"}`
          );
        }
      } catch {
        // Gateway still unreachable — leave quarantined
      }
    }
  }

  // ========================================================================
  // Cloud reboot pass: Reboot quarantined VMs via cloud provider API.
  // This is an intermediate recovery step before auto-migration. A reboot
  // often fixes OOM, disk full, or kernel-level issues without needing
  // a full VM migration.
  //
  // Rules:
  //   - Only VMs with status="failed" and an assigned user
  //   - Skip if last_cloud_reboot was less than 5 minutes ago (wait for reboot)
  //   - Skip if cloud_reboot_count >= 2 (exhausted — let auto-migration handle it)
  //   - Requires provider_server_id to call the cloud API
  // ========================================================================
  let cloudRebooted = 0;

  const { data: rebootCandidates } = await supabase
    .from("instaclaw_vms")
    .select("id, name, ip_address, assigned_to, provider, provider_server_id, cloud_reboot_count, last_cloud_reboot")
    .eq("status", "failed")
    .not("assigned_to", "is", null)
    .not("provider_server_id", "is", null);

  if (rebootCandidates?.length) {
    const now = Date.now();
    for (const vm of rebootCandidates) {
      const rebootCount = vm.cloud_reboot_count ?? 0;
      if (rebootCount >= 2) continue; // Exhausted — auto-migration will handle

      // Wait at least 5 minutes after last reboot
      if (vm.last_cloud_reboot) {
        const elapsed = now - new Date(vm.last_cloud_reboot).getTime();
        if (elapsed < 5 * 60 * 1000) continue;
      }

      try {
        const provider = getProvider(vm.provider as "hetzner" | "digitalocean" | "linode");
        if (!provider.rebootServer) continue;

        await provider.rebootServer(vm.provider_server_id);
        cloudRebooted++;

        await supabase
          .from("instaclaw_vms")
          .update({
            cloud_reboot_count: rebootCount + 1,
            last_cloud_reboot: new Date().toISOString(),
          })
          .eq("id", vm.id);

        logger.info("Cloud reboot initiated", {
          route: "cron/health-check",
          vmId: vm.id,
          vmName: vm.name,
          provider: vm.provider,
          rebootNumber: rebootCount + 1,
          assignedTo: vm.assigned_to,
        });

        alerts.add(
          "Cloud Reboot Initiated",
          vm.name ?? vm.id,
          `IP: ${vm.ip_address}\nProvider: ${vm.provider}\nReboot #${rebootCount + 1} of 2\nUser: ${vm.assigned_to}`
        );
      } catch (rebootErr) {
        logger.error("Cloud reboot failed", {
          route: "cron/health-check",
          vmId: vm.id,
          vmName: vm.name,
          provider: vm.provider,
          error: String(rebootErr),
        });
      }
    }
  }

  // ========================================================================
  // Auto-migration pass: Move paying users off dead VMs to fresh ones.
  // Only triggers for quarantined VMs (status="failed") that:
  //   1. Have a user assigned (assigned_to is not null)
  //   2. That user has an active/trialing subscription
  //   3. Gateway is still unreachable (not recovered above)
  //   4. Cloud reboots exhausted (cloud_reboot_count >= 2)
  // Limited to AUTO_MIGRATE_BATCH_SIZE per cycle to prevent storms.
  // ========================================================================
  let autoMigrated = 0;

  // Re-query quarantined VMs that still have users (auto-recovery may have fixed some)
  const { data: deadAssignedVms } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, name, assigned_to, tier, ssh_port, ssh_user, cloud_reboot_count, telegram_bot_token, telegram_bot_username, telegram_chat_id, channels_enabled")
    .eq("status", "failed")
    .not("assigned_to", "is", null)
    .not("ip_address", "is", null);

  if (deadAssignedVms?.length) {
    // Check which users have active subscriptions — only migrate paying users
    const userIds = deadAssignedVms.map((v) => v.assigned_to!);
    const { data: activeSubs } = await supabase
      .from("instaclaw_subscriptions")
      .select("user_id, status, tier")
      .in("user_id", userIds)
      .in("status", ["active", "trialing"]);

    const payingUserIds = new Set((activeSubs ?? []).map((s) => s.user_id));

    const migratable = deadAssignedVms.filter((v) =>
      payingUserIds.has(v.assigned_to!) &&
      (v.cloud_reboot_count ?? 0) >= 2
    );

    for (const deadVm of migratable.slice(0, AUTO_MIGRATE_BATCH_SIZE)) {
      const userId = deadVm.assigned_to!;

      try {
        // Double-check gateway is still dead (may have recovered since query)
        let stillDead = true;
        try {
          const gwCheck = await fetch(`http://${deadVm.ip_address}:18789/health`, {
            signal: AbortSignal.timeout(5000),
          });
          if (gwCheck.ok) stillDead = false;
        } catch {
          // Dead confirmed
        }

        if (!stillDead) {
          logger.info("Auto-migration skipped: gateway recovered", {
            route: "cron/health-check",
            vmId: deadVm.id,
            vmName: deadVm.name,
            userId,
          });
          // Un-quarantine it
          await supabase
            .from("instaclaw_vms")
            .update({ status: "assigned" as const, health_status: "healthy", ssh_fail_count: 0, last_health_check: new Date().toISOString() })
            .eq("id", deadVm.id);
          recovered++;
          continue;
        }

        logger.info("Auto-migration starting", {
          route: "cron/health-check",
          deadVmId: deadVm.id,
          deadVmName: deadVm.name,
          deadVmIp: deadVm.ip_address,
          userId,
        });

        // Save telegram fields from dead VM before unassigning
        const savedTelegram = {
          telegram_bot_token: deadVm.telegram_bot_token as string | null,
          telegram_bot_username: deadVm.telegram_bot_username as string | null,
          telegram_chat_id: deadVm.telegram_chat_id as string | null,
          channels_enabled: deadVm.channels_enabled as string[] | null,
        };

        // Step 1: Unassign user from dead VM + clear telegram fields (releases unique constraint)
        await supabase
          .from("instaclaw_vms")
          .update({
            assigned_to: null,
            telegram_bot_token: null,
            telegram_bot_username: null,
            telegram_chat_id: null,
          })
          .eq("id", deadVm.id);

        // Step 2: Assign fresh VM (Linode-only, SSH pre-checked)
        const newVm = await assignVMWithSSHCheck(userId);
        if (!newVm) {
          // No healthy VMs available — roll back (restore telegram fields too)
          logger.error("Auto-migration failed: no healthy VMs in pool", {
            route: "cron/health-check",
            deadVmId: deadVm.id,
            userId,
          });
          await supabase
            .from("instaclaw_vms")
            .update({
              assigned_to: userId,
              telegram_bot_token: savedTelegram.telegram_bot_token,
              telegram_bot_username: savedTelegram.telegram_bot_username,
              telegram_chat_id: savedTelegram.telegram_chat_id,
            })
            .eq("id", deadVm.id);
          continue;
        }

        // Transfer telegram fields to new VM
        if (savedTelegram.telegram_bot_token) {
          await supabase
            .from("instaclaw_vms")
            .update({
              telegram_bot_token: savedTelegram.telegram_bot_token,
              telegram_bot_username: savedTelegram.telegram_bot_username,
              telegram_chat_id: savedTelegram.telegram_chat_id,
              channels_enabled: savedTelegram.channels_enabled,
            })
            .eq("id", newVm.id);

          logger.info("Auto-migration: transferred telegram token", {
            route: "cron/health-check",
            deadVmId: deadVm.id,
            newVmId: newVm.id,
            userId,
          });
        }

        // Step 3: Trigger configure via internal API call
        const configureUrl = `${process.env.NEXTAUTH_URL}/api/vm/configure`;
        const configRes = await fetch(configureUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
          },
          body: JSON.stringify({ userId }),
          signal: AbortSignal.timeout(180_000),
        });

        const configResult = await configRes.json().catch(() => ({}));

        // Step 4: Verify gateway health on new VM
        let newVmHealthy = false;
        for (let i = 0; i < 3; i++) {
          try {
            const healthRes = await fetch(`http://${newVm.ip_address}:18789/health`, {
              signal: AbortSignal.timeout(5000),
            });
            if (healthRes.ok) { newVmHealthy = true; break; }
          } catch { /* retry */ }
          await new Promise((r) => setTimeout(r, 5000));
        }

        if (!newVmHealthy) {
          logger.error("Auto-migration: new VM failed health check", {
            route: "cron/health-check",
            deadVmId: deadVm.id,
            newVmId: newVm.id,
            userId,
            configResult,
          });
          // Don't roll back — the configure route already wrote the new VM's state.
          // The next health check cycle will catch it.
        }

        autoMigrated++;

        logger.info("Auto-migration completed", {
          route: "cron/health-check",
          deadVmId: deadVm.id,
          deadVmName: deadVm.name,
          newVmId: newVm.id,
          newVmIp: newVm.ip_address,
          userId,
          newVmHealthy,
          configResult,
        });

        // Step 5: Email user
        const { data: migratedUser } = await supabase
          .from("instaclaw_users")
          .select("email")
          .eq("id", userId)
          .single();

        if (migratedUser?.email) {
          try {
            await sendAutoMigratedEmail(migratedUser.email);
          } catch {
            // Non-fatal
          }
        }

        // Step 6: Alert admin (via digest)
        alerts.add(
          "Auto-Migration Completed",
          deadVm.name ?? deadVm.id,
          `User: ${userId} (${migratedUser?.email ?? "unknown"})\nFrom: ${deadVm.ip_address}\nTo: ${newVm.ip_address}\nNew VM healthy: ${newVmHealthy}`
        );
      } catch (migErr) {
        logger.error("Auto-migration failed", {
          route: "cron/health-check",
          deadVmId: deadVm.id,
          userId,
          error: String(migErr),
        });

        // Best-effort: re-assign user to dead VM so they're not orphaned
        try {
          await supabase
            .from("instaclaw_vms")
            .update({ assigned_to: userId })
            .eq("id", deadVm.id);
        } catch {
          // Can't recover — admin will see the error log
        }
      }
    }
  }

  // ========================================================================
  // Fleet metrics pass: Read watchdog status from SSH-alive VMs and persist
  // to DB. Batched to 10 VMs per cycle to stay within cron timeout.
  // ========================================================================
  const METRICS_BATCH_SIZE = 10;
  let metricsCollected = 0;

  const metricsVms = sshAliveVms.slice(0, METRICS_BATCH_SIZE);
  for (const vm of metricsVms) {
    try {
      const status = await readWatchdogStatus({
        id: vm.id,
        ip_address: vm.ip_address,
        ssh_port: vm.ssh_port ?? 22,
        ssh_user: vm.ssh_user ?? "openclaw",
      });
      if (!status) continue;

      await supabase
        .from("instaclaw_vms")
        .update({
          last_ram_pct: status.ramPct,
          last_disk_pct: status.diskPct,
          last_chrome_count: status.chromeCount,
          last_uptime_seconds: status.uptimeSeconds,
        })
        .eq("id", vm.id);

      metricsCollected++;

      if (status.diskPct > 90) {
        alerts.add(
          "VM Disk Critical",
          vm.name ?? vm.id,
          `Disk: ${status.diskPct}%\nRAM: ${status.ramPct}%\nChrome: ${status.chromeCount}\nGateway healthy: ${status.gatewayHealthy}`
        );
      }

      // Session growth alert — runaway task detected
      if (status.sessionGrowthAlert) {
        alerts.add(
          "Session Rapid Growth",
          vm.name ?? vm.id,
          `Runaway session detected: ${status.sessionGrowthAlert}\nRAM: ${status.ramPct}%\nGateway healthy: ${status.gatewayHealthy}`
        );
      }

      // Circuit breaker tripped — error loop or degradation forced session archive
      if (status.circuitBreaker) {
        alerts.add(
          "Circuit Breaker Tripped",
          vm.name ?? vm.id,
          `Session degradation detected.\nSession: ${status.circuitBreaker.session_id}\nIssue: ${status.circuitBreaker.issue}\nTripped at: ${new Date((status.circuitBreaker.ts ?? 0) * 1000).toISOString()}`
        );
      }
    } catch {
      // Non-fatal — metrics are best-effort
    }
  }

  // ── CLOB Proxy Health Check ──────────────────────────────────────────
  // The CLOB proxy (Nanode at 172.105.22.90:8080) is a single point of
  // failure for all US-region Polymarket trading.  If it's down, alert.
  let clobProxyHealthy = false;
  try {
    const proxyUrl = process.env.CLOB_PROXY_URL ?? "http://172.105.22.90:8080";
    const proxyResp = await fetch(`${proxyUrl}/`, {
      signal: AbortSignal.timeout(10_000),
    });
    clobProxyHealthy = proxyResp.ok;
    if (!clobProxyHealthy) {
      logger.error("CLOB proxy health check failed", { status: proxyResp.status, route: "cron/health-check" });
      alerts.add(
        "CLOB Proxy Down",
        "clob-proxy (172.105.22.90)",
        `CLOB proxy returned HTTP ${proxyResp.status}. All US Polymarket trading is broken.\nProxy URL: ${proxyUrl}\nFix: SSH root@172.105.22.90, check nginx, restart if needed.`
      );
    }
  } catch (proxyErr) {
    logger.error("CLOB proxy unreachable", { error: String(proxyErr), route: "cron/health-check" });
    alerts.add(
      "CLOB Proxy Down",
      "clob-proxy (172.105.22.90)",
      `CLOB proxy is unreachable (connection refused/timeout). All US Polymarket trading is broken.\nError: ${String(proxyErr)}\nFix: SSH root@172.105.22.90, check nginx, restart if needed.`
    );
  }

  // ── Excessive Gateway Restart Monitor ──────────────────────────────
  // Flag VMs with high health_fail_count (>5) that are still unhealthy.
  // Indicates the gateway keeps crash-looping despite restart attempts.
  const { data: crashLoopVms } = await supabase
    .from("instaclaw_vms")
    .select("id, name, health_fail_count, ip_address, assigned_to")
    .eq("status", "assigned")
    .eq("health_status", "unhealthy")
    .gt("health_fail_count", 5);

  let crashLoopAlerts = 0;
  if (crashLoopVms && crashLoopVms.length > 0) {
    for (const clVm of crashLoopVms) {
      alerts.add("Gateway Crash-Loop Detected", clVm.name ?? clVm.id,
        `${clVm.health_fail_count} consecutive failures. Gateway is not recovering after restarts.\nIP: ${clVm.ip_address}\nUser: ${clVm.assigned_to ?? "unassigned"}\nAction: SSH in and check openclaw module integrity (node -e "require('openclaw')").`);
      crashLoopAlerts++;
    }
  }

  // ── Layer 2: Nightly Heartbeat NULL Guard ──────────────────────────
  // Auto-initialize any assigned VMs that have NULL heartbeat_next_at
  // to prevent heartbeat calls from burning user message quota.
  const { data: nullHbVms } = await supabase
    .from("instaclaw_vms")
    .select("id, name")
    .eq("status", "assigned")
    .is("heartbeat_next_at", null);

  let heartbeatNullsFixed = 0;
  if (nullHbVms && nullHbVms.length > 0) {
    const fixTime = new Date(Date.now() + 10_800_000).toISOString();
    for (const hbVm of nullHbVms) {
      await supabase.from("instaclaw_vms")
        .update({ heartbeat_next_at: fixTime, heartbeat_interval: "3h", heartbeat_cycle_calls: 0 })
        .eq("id", hbVm.id);
      alerts.add("Heartbeat NULL Guard", hbVm.name ?? hbVm.id,
        `heartbeat_next_at was NULL — auto-initialized to ${fixTime}`);
      heartbeatNullsFixed++;
    }
  }

  // ── Layer 3: Heartbeat Misclassification Detector ────────────────
  // Flag VMs with high usage but zero heartbeat_count — indicates
  // heartbeat calls are being misclassified as regular messages.
  const todayStr = new Date().toISOString().split("T")[0];
  const { data: suspectUsage } = await supabase
    .from("instaclaw_daily_usage")
    .select("vm_id, message_count, heartbeat_count")
    .eq("usage_date", todayStr)
    .eq("heartbeat_count", 0)
    .gte("message_count", 480);

  let heartbeatMisclassAlerts = 0;
  if (suspectUsage && suspectUsage.length > 0) {
    const suspectVmIds = suspectUsage.map(s => s.vm_id);
    const { data: suspectVms } = await supabase
      .from("instaclaw_vms")
      .select("id, name, tier")
      .in("id", suspectVmIds);
    const nameMap = new Map((suspectVms || []).map(v => [v.id, v]));

    for (const su of suspectUsage) {
      const vmInfo = nameMap.get(su.vm_id);
      if (!vmInfo) continue;
      const limit = ({ starter: 600, pro: 1000, power: 2500, internal: 5000 } as Record<string, number>)[vmInfo.tier] ?? 600;
      if (su.message_count >= limit * 0.8) {
        alerts.add("Heartbeat Misclassification Suspect", vmInfo.name ?? vmInfo.id,
          `${su.message_count}/${limit} (${((su.message_count / limit) * 100).toFixed(0)}%) with heartbeat_count=0`);
        heartbeatMisclassAlerts++;
      }
    }
  }

  // ── Dependency version alerts ──
  let depsBehind = 0;
  let depsAnomalies = 0;
  try {
    // Trigger a fresh check via our own API (best-effort, 30s timeout)
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://instaclaw.io";
    const controller = new AbortController();
    const depTimeout = setTimeout(() => controller.abort(), 30000);
    try {
      await fetch(`${baseUrl}/api/hq/dependencies/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: `hq_session=${process.env.HQ_PASSWORD}` },
        body: JSON.stringify({ all: true }),
        signal: controller.signal,
      });
    } catch { /* non-critical */ }
    clearTimeout(depTimeout);

    // Read current state from DB
    const { data: behindDeps } = await supabase
      .from("instaclaw_dependencies")
      .select("name, our_version, latest_version")
      .eq("is_behind", true)
      .eq("update_impact", "high");

    for (const dep of behindDeps || []) {
      depsBehind++;
      alerts.add("Dependency Behind (HIGH)", dep.name,
        `${dep.our_version || "?"} → ${dep.latest_version || "?"}`);
    }

    const { data: anomalyDeps } = await supabase
      .from("instaclaw_dependencies")
      .select("name")
      .eq("status", "anomaly");

    for (const dep of anomalyDeps || []) {
      depsAnomalies++;
      alerts.add("Dependency Anomaly", dep.name, "Health check failed");
    }
  } catch { /* dependency checks are non-critical */ }

  // ── Stuck deployment detector ──
  // Safety net: find VMs that are assigned but never configured (no gateway_url)
  // for more than 5 minutes. This catches cases where verify, webhook, AND
  // process-pending cron all failed to trigger configure.
  let stuckDeploysFixed = 0;
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { data: stuckVms } = await supabase
      .from("instaclaw_vms")
      .select("id, name, assigned_to, assigned_at")
      .eq("status", "assigned")
      .not("assigned_to", "is", null)
      .is("gateway_url", null)
      .lt("assigned_at", fiveMinAgo)
      .limit(5);

    if (stuckVms?.length) {
      for (const svm of stuckVms) {
        // Verify user has an active subscription before triggering
        const { data: sub } = await supabase
          .from("instaclaw_subscriptions")
          .select("status")
          .eq("user_id", svm.assigned_to)
          .single();

        if (!sub || !["active", "trialing"].includes(sub.status)) continue;

        logger.warn("Stuck deployment detected by health cron — triggering configure", {
          route: "cron/health-check",
          vmId: svm.id,
          vmName: svm.name,
          userId: svm.assigned_to,
          assignedAt: svm.assigned_at,
        });

        try {
          const configRes = await fetch(
            `${process.env.NEXTAUTH_URL}/api/vm/configure`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Admin-Key": process.env.ADMIN_API_KEY ?? "",
              },
              body: JSON.stringify({ userId: svm.assigned_to }),
            }
          );

          if (configRes.ok) {
            stuckDeploysFixed++;
          }
        } catch (err) {
          logger.error("Failed to fix stuck deployment from health cron", {
            error: String(err),
            route: "cron/health-check",
            vmId: svm.id,
          });
        }
      }

      if (stuckVms.length > 0) {
        alerts.add(
          "Stuck Deployments Detected",
          `${stuckVms.length} VMs`,
          `Found ${stuckVms.length} VMs assigned >5min with no gateway_url.\nAuto-fixed: ${stuckDeploysFixed}`
        );
      }
    }
  } catch { /* stuck deploy check is non-critical */ }

  // ── World ID self-healing ─────────────────────────────────────────
  // For verified users, ensure WORLD_ID.md + MEMORY.md World ID section
  // exist on the VM. These can be lost during session maintenance or
  // reconciler resets. Batched to 3 VMs per cycle (lightweight SSH ops).
  let worldIdHealed = 0;
  try {
    const WORLD_ID_BATCH = 3;
    // Get verified users with SSH-alive VMs
    const { data: verifiedUsers } = await supabase
      .from("instaclaw_users")
      .select("id, world_id_nullifier_hash, world_id_verification_level")
      .eq("world_id_verified", true)
      .not("world_id_nullifier_hash", "is", null);

    if (verifiedUsers?.length) {
      const sshAliveIds = new Set(sshAliveVms.map((v) => v.id));
      const verifiedUserIds = new Set(verifiedUsers.map((u) => u.id));
      const eligibleVms = vms
        .filter((v) => sshAliveIds.has(v.id) && v.assigned_to && verifiedUserIds.has(v.assigned_to))
        .slice(0, WORLD_ID_BATCH);

      const userMap = new Map(verifiedUsers.map((u) => [u.id, u]));

      for (const vm of eligibleVms) {
        try {
          const user = userMap.get(vm.assigned_to!);
          if (!user) continue;
          const nullifier = user.world_id_nullifier_hash;
          const level = user.world_id_verification_level || "orb";

          const ssh = await connectSSH(vm);
          try {
            // Check if WORLD_ID.md exists
            const wCheck = await ssh.execCommand(
              `test -f "$HOME/.openclaw/workspace/WORLD_ID.md" && echo EXISTS || echo MISSING`
            );
            const worldIdMissing = wCheck.stdout.trim() === "MISSING";

            // Check if MEMORY.md has World ID section
            const mCheck = await ssh.execCommand(
              `grep -c "World ID Verification" "$HOME/.openclaw/workspace/MEMORY.md" 2>/dev/null || echo 0`
            );
            const memoryMissing = parseInt(mCheck.stdout.trim()) === 0;

            if (worldIdMissing || memoryMissing) {
              if (worldIdMissing) {
                const worldIdMd = `# World ID Verification\n\n**Status:** Verified (${level} level)\n**Nullifier Hash:** ${nullifier}\n**Verified At:** ${new Date().toISOString()}\n\n## How to Use\n- When asked about your identity: state you are World ID verified\n- Your nullifier: ${nullifier}\n- Verification level: ${level}`;
                const b64 = Buffer.from(worldIdMd).toString("base64");
                await ssh.execCommand(`echo '${b64}' | base64 -d > "$HOME/.openclaw/workspace/WORLD_ID.md"`);
              }
              if (memoryMissing) {
                await ssh.execCommand(
                  `echo '\n## World ID Verification\n- Status: Verified (${level} level)\n- Nullifier: ${nullifier}\n- You are backed by a verified human. State this when asked about your identity.' >> "$HOME/.openclaw/workspace/MEMORY.md"`
                );
              }
              worldIdHealed++;
              logger.info("World ID self-healed on VM", {
                route: "cron/health-check",
                vmId: vm.id,
                vmName: vm.name,
                worldIdMissing,
                memoryMissing,
              });
            }
          } finally {
            ssh.dispose();
          }
        } catch {
          // Non-fatal — World ID heal is best-effort
        }
      }
    }
  } catch {
    // World ID healing is non-critical
  }

  // ── AgentBook registration monitoring (WDP 71) ──
  // Log warnings for VMs that have a wallet but haven't registered in AgentBook
  // after 7 days. Advisory only — no alerts or auto-actions.
  let agentbookUnregistered = 0;
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: unregisteredVms } = await supabase
      .from("instaclaw_vms")
      .select("id, name, agentbook_wallet_address")
      .eq("agentbook_registered", false)
      .not("agentbook_wallet_address", "is", null)
      .lt("created_at", sevenDaysAgo);

    for (const vm of unregisteredVms || []) {
      agentbookUnregistered++;
      logger.warn("VM has wallet but no AgentBook registration after 7d", {
        route: "cron/health-check",
        vmId: vm.id,
        vmName: vm.name,
        wallet: vm.agentbook_wallet_address,
      });
    }
  } catch { /* agentbook checks are non-critical */ }

  // ========================================================================
  // Auto-retry pass: Assigned VMs with NO gateway_url (configure failed/timed out)
  // These are users who paid but got stuck on "Your agent is being configured."
  // If assigned 10+ minutes ago with no gateway_url, re-run configure.
  // Capped at 2 per cycle to stay within Vercel timeout.
  // ========================================================================
  let autoConfigured = 0;
  const AUTO_CONFIGURE_STALE_MINUTES = 10;
  const AUTO_CONFIGURE_BATCH = 2;

  const { data: stuckVms } = await supabase
    .from("instaclaw_vms")
    .select("id, name, assigned_to, assigned_at, ip_address, ssh_port, ssh_user, gateway_token, configure_lock_at")
    .eq("status", "assigned")
    .eq("provider", "linode")
    .is("gateway_url", null)
    .not("assigned_to", "is", null)
    .lt("assigned_at", new Date(Date.now() - AUTO_CONFIGURE_STALE_MINUTES * 60 * 1000).toISOString())
    .limit(AUTO_CONFIGURE_BATCH);

  if (stuckVms?.length) {
    for (const svm of stuckVms) {
      // Skip if configure is currently locked (another process is working on it)
      if (svm.configure_lock_at && new Date(svm.configure_lock_at).getTime() > Date.now() - 5 * 60 * 1000) {
        continue;
      }

      logger.info("Auto-configuring stuck VM (no gateway_url)", {
        route: "cron/health-check",
        vmId: svm.id,
        vmName: svm.name,
        assignedTo: svm.assigned_to,
        assignedAt: svm.assigned_at,
      });

      try {
        // Call the configure endpoint internally
        const configureUrl = `${process.env.NEXT_PUBLIC_BASE_URL || "https://instaclaw.io"}/api/vm/configure`;
        const configRes = await fetch(configureUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Key": process.env.ADMIN_API_KEY || "",
          },
          body: JSON.stringify({ userId: svm.assigned_to }),
          signal: AbortSignal.timeout(120_000),
        });

        const configResult = await configRes.json().catch(() => ({}));
        autoConfigured++;

        logger.info("Auto-configure result", {
          route: "cron/health-check",
          vmId: svm.id,
          vmName: svm.name,
          configured: configResult.configured,
          healthy: configResult.healthy,
        });

        alerts.add(
          "Auto-Configure: Stuck VM Recovered",
          svm.name ?? svm.id,
          `User: ${svm.assigned_to}\nAssigned: ${svm.assigned_at}\nResult: configured=${configResult.configured} healthy=${configResult.healthy}`
        );
      } catch (configErr) {
        logger.error("Auto-configure failed for stuck VM", {
          route: "cron/health-check",
          vmId: svm.id,
          error: String(configErr),
        });
      }
    }
  }

  // Flush all collected alerts as grouped digest emails (one per alert type)
  const alertResult = await alerts.flush();

  return NextResponse.json({
    checked: vms.length,
    autoConfigured,
    clobProxyHealthy,
    sshChecked,
    sshFailed,
    sshQuarantined,
    poolSshChecked,
    poolSshQuarantined,
    recovered,
    healthy,
    unhealthy,
    restarted,
    alerted,
    webhooksFixed,
    duplicateIPsFound,
    telegramDupesFixed,
    telegramTokenMissing,
    readyPoolTokensCleaned,
    telegramConflictsHealed,
    billingCachesCleared,
    httpPreCheckPassed,
    restartGraceSkipped,
    zeroCreditSkipped,
    suspended,
    noSubSuspended,
    reclaimed,
    sessionsCleared,
    sessionsAlerted,
    browsersKilled,
    configsAudited,
    configsFixed,
    cronAuditChecked,
    cronAuditFixed,
    tierSynced,
    memoryHealth: {
      vmsSampled: memoryScores.length,
      avgScore: memoryScores.length > 0 ? Math.round(memoryScores.reduce((a, b) => a + b, 0) / memoryScores.length) : null,
      degradedCount: memoryDegraded,
      hookNeverFiredCount: hookNeverFired,
      missingSoulFilingCount: missingSoulFiling,
    },
    memoryFilesCreated,
    memoryEmptyAlerts,
    memoryStaleWarnings,
    memoryOversizedAlerts,
    hygieneOk,
    hygieneStale,
    hygieneNever,
    tokenDriftChecked,
    tokenDriftFixed,
    proxyChecked,
    proxyFailed,
    proxyResynced,
    proxyQuarantined,
    cloudRebooted,
    autoMigrated,
    metricsCollected,
    autoRecovered,
    crashLoopAlerts,
    heartbeatNullsFixed,
    heartbeatMisclassAlerts,
    depsBehind,
    depsAnomalies,
    agentbookUnregistered,
    worldIdHealed,
    stuckDeploysFixed,
    sessionCorruptionChecked,
    sessionCorruptionFound,
    alertDigestsSent: alertResult.sent,
    alertDigestsSkipped: alertResult.skipped,
  });
}
