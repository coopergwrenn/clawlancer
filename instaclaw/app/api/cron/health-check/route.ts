import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { checkHealthExtended, checkSSHConnectivity, clearSessions, restartGateway, stopGateway, auditVMConfig, testProxyRoundTrip, resyncGatewayToken, checkVMTokenDrift, connectSSH, NVM_PREAMBLE, killStaleBrowser, rotateOversizedSession, checkSessionHealth, checkMemoryHealth, assignVMWithSSHCheck, readWatchdogStatus } from "@/lib/ssh";
import { VM_MANIFEST } from "@/lib/vm-manifest";
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
const CONFIG_AUDIT_BATCH_SIZE = 3; // Max VMs to audit per cycle (staggered)
const AUTO_MIGRATE_BATCH_SIZE = 3; // Max auto-migrations per cron cycle to prevent storms
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
    .select("id, ip_address, ssh_port, ssh_user, gateway_url, health_status, gateway_token, health_fail_count, ssh_fail_count, assigned_to, name, config_version, api_mode, proxy_401_count, assigned_at")
    .eq("status", "assigned")
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
  let sessionsCleared = 0;
  let sessionsAlerted = 0;
  let browsersKilled = 0;
  let sshChecked = 0;
  let sshFailed = 0;
  let sshQuarantined = 0;

  // ========================================================================
  // Pass 0: SSH connectivity check — catch dead SSH daemons before they
  // waste time on gateway health checks. VMs that fail SSH get their
  // ssh_fail_count incremented. After SSH_QUARANTINE_THRESHOLD consecutive
  // failures, auto-quarantine the VM (mark as failed).
  // ========================================================================
  const sshAliveVms: typeof vms = [];

  for (const vm of vms) {
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
      // Before quarantining, try gateway HTTP health as fallback
      let gatewayAlive = false;
      try {
        const gwRes = await fetch(`http://${vm.ip_address}:18789/health`, {
          signal: AbortSignal.timeout(10000),
        });
        gatewayAlive = gwRes.ok;
      } catch {
        // Gateway unreachable — proceed with quarantine
      }

      if (gatewayAlive) {
        // Gateway is alive despite SSH failure — false positive, skip quarantine
        logger.info("SSH failed but gateway HTTP health OK — skipping quarantine", {
          route: "cron/health-check",
          vmId: vm.id,
          vmName: vm.name,
          ipAddress: vm.ip_address,
          sshFailCount: newSshFailCount,
          assignedTo: vm.assigned_to,
        });

        await supabase
          .from("instaclaw_vms")
          .update({
            ssh_fail_count: 0,
            health_status: "healthy",
            last_health_check: new Date().toISOString(),
          })
          .eq("id", vm.id);
      } else {
        // Both SSH and HTTP failed — quarantine
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

        logger.error("VM auto-quarantined: SSH unreachable", {
          route: "cron/health-check",
          vmId: vm.id,
          vmName: vm.name,
          ipAddress: vm.ip_address,
          sshFailCount: newSshFailCount,
          assignedTo: vm.assigned_to,
        });

        // Alert admin (via digest)
        alerts.add(
          "VM Auto-Quarantined: SSH Dead",
          vm.name ?? vm.id,
          `IP: ${vm.ip_address}\nSSH failures: ${newSshFailCount}\nAssigned to: ${vm.assigned_to ?? "none"}\nStatus set to "failed".`
        );
      }
    } else {
      // Not yet at threshold — just increment counter
      await supabase
        .from("instaclaw_vms")
        .update({
          ssh_fail_count: newSshFailCount,
          health_status: "unhealthy",
          last_health_check: new Date().toISOString(),
        })
        .eq("id", vm.id);
    }
  }

  // Track which VMs are healthy for the config audit pass
  const healthyVmIds = new Set<string>();

  // Only check gateway health on VMs with working SSH
  for (const vm of sshAliveVms) {
    const result = await checkHealthExtended(vm, vm.gateway_token ?? undefined);
    const currentFailCount = vm.health_fail_count ?? 0;

    // ── Session health check (runs for ALL VMs regardless of gateway health) ──
    // This MUST be outside the healthy-only block. The Ladio incident happened
    // because session rotation only ran on healthy VMs — an unhealthy/failed VM
    // had its sessions grow to 1.9MB unchecked until they corrupted.
    if (result.largestSessionBytes > VM_MANIFEST.maxSessionBytes) {
      logger.warn("Session overflow detected, rotating", {
        route: "cron/health-check",
        vmId: vm.id,
        vmName: vm.name,
        largestSessionBytes: result.largestSessionBytes,
        maxSessionBytes: VM_MANIFEST.maxSessionBytes,
      });

      try {
        const rotateResult = await rotateOversizedSession(vm);
        if (rotateResult.rotated) {
          sessionsCleared++;
          logger.info("Oversized session rotated (archived, not deleted)", {
            route: "cron/health-check",
            vmId: vm.id,
            vmName: vm.name,
            file: rotateResult.file,
            sizeBytes: rotateResult.sizeBytes,
          });
        }
      } catch (err) {
        logger.error("Failed to rotate session", {
          error: String(err),
          route: "cron/health-check",
          vmId: vm.id,
        });
      }
    } else if (result.largestSessionBytes > VM_MANIFEST.sessionAlertBytes) {
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

      // After ALERT_THRESHOLD consecutive failures, take action
      if (newFailCount === ALERT_THRESHOLD) {
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

        // Send alert email to user (only if we actually restarted)
        if (!gatewayActuallyHealthy && vm.assigned_to) {
          const { data: user } = await supabase
            .from("instaclaw_users")
            .select("email")
            .eq("id", vm.assigned_to)
            .single();

          if (user?.email) {
            try {
              await sendHealthAlertEmail(user.email, vm.name ?? vm.id);
              alerted++;
            } catch (emailErr) {
              logger.error("Failed to send health alert email", { error: String(emailErr), route: "cron/health-check", vmId: vm.id });
            }
          }
        }

        // Also alert admin
        if (!gatewayActuallyHealthy && ADMIN_EMAIL) {
          try {
            await sendHealthAlertEmail(
              ADMIN_EMAIL,
              `${vm.name ?? vm.id} (user: ${vm.assigned_to})`
            );
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
                `${NVM_PREAMBLE} && openclaw config set channels.telegram.enabled false 2>/dev/null || true`,
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
      logger.error("Telegram enabled but bot token missing", {
        route: "cron/health-check",
        vmId: tvm.id,
        vmName: tvm.name,
        ipAddress: tvm.ip_address,
        assignedTo: tvm.assigned_to,
      });
    }

    // Alert admin (via digest) — one entry per affected VM
    for (const tvm of telegramEnabledVms) {
      alerts.add(
        "Telegram Token Missing",
        tvm.name ?? tvm.id,
        `User: ${tvm.assigned_to}\nTelegram enabled but bot token is NULL.`
      );
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
  // Fourth pass: Config audit for stale-version VMs
  // Only audit healthy VMs (no point fixing config on a down gateway).
  // Staggered: limit to CONFIG_AUDIT_BATCH_SIZE per cycle to avoid timeout.
  // ========================================================================
  let configsAudited = 0;
  let configsFixed = 0;

  const staleVms = vms.filter(
    (vm) =>
      healthyVmIds.has(vm.id) &&
      (vm.config_version ?? 0) < VM_MANIFEST.version
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
  // Sixth pass: Memory health monitoring
  // Check MEMORY.md size and staleness on healthy VMs.
  // MEMORY_EMPTY: <=200 bytes, assigned 48h+, session > 10KB → admin alert
  // MEMORY_STALE: not modified 72h+, active sessions → log warning
  // Batch of 5 VMs per cycle (same pattern as MEMORY.md ensure pass)
  // ========================================================================
  let memoryEmptyAlerts = 0;
  let memoryStaleWarnings = 0;
  const MEMORY_EMPTY_THRESHOLD = 200;   // bytes — effectively empty
  const MEMORY_STALE_HOURS = 72;        // hours without update
  const MEMORY_MIN_SESSION_BYTES = 10 * 1024; // 10KB — VM must have meaningful session
  const MEMORY_ASSIGNED_HOURS = 48;     // VM must be assigned 48h+ for empty alert

  const memoryHealthBatch = vms
    .filter((vm) => healthyVmIds.has(vm.id))
    .slice(0, 5);

  for (const vm of memoryHealthBatch) {
    try {
      const memHealth = await checkMemoryHealth(vm);
      if (!memHealth.reachable) continue;

      const nowEpoch = Math.floor(Date.now() / 1000);
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
  // VM-side token drift detection (runs every cycle for ALL healthy VMs)
  // SSHes into the VM, reads auth-profiles.json, compares token against DB.
  // Catches the Mucus scenario: DB token changed but VM still has old token.
  // The proxy round-trip pass (below) can't catch this because it tests with
  // the DB token, which always matches itself. This check verifies the VM side.
  // ========================================================================
  let tokenDriftChecked = 0;
  let tokenDriftFixed = 0;
  const TOKEN_DRIFT_BATCH_SIZE = 10;

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
        vm.health_status !== "proxy_quarantined"
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
    .select("id, ip_address, name, assigned_to, tier, ssh_port, ssh_user, cloud_reboot_count")
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

        // Step 1: Unassign user from dead VM
        await supabase
          .from("instaclaw_vms")
          .update({ assigned_to: null })
          .eq("id", deadVm.id);

        // Step 2: Assign fresh VM (Linode-only, SSH pre-checked)
        const newVm = await assignVMWithSSHCheck(userId);
        if (!newVm) {
          // No healthy VMs available — roll back
          logger.error("Auto-migration failed: no healthy VMs in pool", {
            route: "cron/health-check",
            deadVmId: deadVm.id,
            userId,
          });
          await supabase
            .from("instaclaw_vms")
            .update({ assigned_to: userId })
            .eq("id", deadVm.id);
          continue;
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
    } catch {
      // Non-fatal — metrics are best-effort
    }
  }

  // Flush all collected alerts as grouped digest emails (one per alert type)
  const alertResult = await alerts.flush();

  return NextResponse.json({
    checked: vms.length,
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
    telegramDupesFixed,
    telegramTokenMissing,
    suspended,
    sessionsCleared,
    sessionsAlerted,
    browsersKilled,
    configsAudited,
    configsFixed,
    memoryFilesCreated,
    memoryEmptyAlerts,
    memoryStaleWarnings,
    tokenDriftChecked,
    tokenDriftFixed,
    proxyChecked,
    proxyFailed,
    proxyResynced,
    proxyQuarantined,
    cloudRebooted,
    autoMigrated,
    metricsCollected,
    alertDigestsSent: alertResult.sent,
    alertDigestsSkipped: alertResult.skipped,
  });
}
