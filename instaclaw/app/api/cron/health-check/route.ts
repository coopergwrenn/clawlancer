import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { checkHealthExtended, checkSSHConnectivity, clearSessions, restartGateway, stopGateway, auditVMConfig, ensureMemoryFile, testProxyRoundTrip, resyncGatewayToken, killStaleBrowser, rotateOversizedSession, checkSessionHealth, checkMemoryHealth, CONFIG_SPEC, assignVMWithSSHCheck } from "@/lib/ssh";
import { sendHealthAlertEmail, sendSuspendedEmail, sendAdminAlertEmail, sendAutoMigratedEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

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

        // Alert admin
        if (ADMIN_EMAIL) {
          try {
            await sendAdminAlertEmail(
              "VM Auto-Quarantined: SSH Dead",
              `VM ${vm.name ?? vm.id} (${vm.ip_address}) has failed ${newSshFailCount} consecutive SSH connectivity checks and has been auto-quarantined.\n\nAssigned to user: ${vm.assigned_to ?? "none"}\n\nThe VM status has been set to "failed". If a user was assigned, they will need to be moved to a new VM.`
            );
          } catch {
            // Non-fatal
          }
        }
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
    if (result.largestSessionBytes > CONFIG_SPEC.maxSessionBytes) {
      logger.warn("Session overflow detected, rotating", {
        route: "cron/health-check",
        vmId: vm.id,
        vmName: vm.name,
        largestSessionBytes: result.largestSessionBytes,
        maxSessionBytes: CONFIG_SPEC.maxSessionBytes,
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
    } else if (result.largestSessionBytes > CONFIG_SPEC.sessionAlertBytes) {
      // Alert threshold — session is growing but not yet critical
      sessionsAlerted++;
      logger.warn("Session approaching size limit", {
        route: "cron/health-check",
        vmId: vm.id,
        vmName: vm.name,
        largestSessionBytes: result.largestSessionBytes,
        alertThreshold: CONFIG_SPEC.sessionAlertBytes,
        rotateThreshold: CONFIG_SPEC.maxSessionBytes,
      });

      if (ADMIN_EMAIL) {
        try {
          await sendAdminAlertEmail(
            "Session Size Warning",
            `VM ${vm.name ?? vm.id} (${vm.ip_address}) has a session file at ${Math.round(result.largestSessionBytes / 1024)}KB.\n\nAlert threshold: ${Math.round(CONFIG_SPEC.sessionAlertBytes / 1024)}KB\nAuto-rotate threshold: ${Math.round(CONFIG_SPEC.maxSessionBytes / 1024)}KB\n\nThe session will be auto-rotated if it exceeds ${Math.round(CONFIG_SPEC.maxSessionBytes / 1024)}KB. No action needed yet — this is an early warning.`
          );
        } catch {
          // Non-fatal
        }
      }
    }

    if (result.healthy) {
      healthy++;
      healthyVmIds.add(vm.id);

      // Ephemeral browser: kill Chrome if stale (>30min) or memory-heavy (>40% RAM)
      try {
        const browserResult = await killStaleBrowser(vm);
        if (browserResult.killed) {
          browsersKilled++;
          logger.info("Stale browser killed", {
            route: "cron/health-check",
            vmId: vm.id,
            vmName: vm.name,
            reason: browserResult.reason,
          });
        }
      } catch (err) {
        logger.error("Failed to check/kill stale browser", {
          error: String(err),
          route: "cron/health-check",
          vmId: vm.id,
        });
      }

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
      (vm.config_version ?? 0) < CONFIG_SPEC.version
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
        .update({ config_version: CONFIG_SPEC.version })
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

  // ========================================================================
  // Fifth pass: Ensure MEMORY.md exists on all healthy VMs
  // Without this file, agents have no long-term memory from day one.
  // Piggybacks on the healthy VM list — only checks VMs we know are reachable.
  // Limit to 5 per cycle to avoid SSH overload.
  // ========================================================================
  let memoryFilesCreated = 0;

  const memoryCheckBatch = vms
    .filter((vm) => healthyVmIds.has(vm.id))
    .slice(0, 5);

  for (const vm of memoryCheckBatch) {
    try {
      const created = await ensureMemoryFile(vm);
      if (created) {
        memoryFilesCreated++;
      }
    } catch (err) {
      logger.error("Memory file check failed", {
        error: String(err),
        route: "cron/health-check",
        vmId: vm.id,
        vmName: vm.name,
      });
    }
  }

  if (memoryFilesCreated > 0) {
    logger.info("Memory files created on VMs", {
      route: "cron/health-check",
      memoryFilesCreated,
    });
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

        if (ADMIN_EMAIL) {
          try {
            await sendAdminAlertEmail(
              "Memory Empty Alert",
              `VM ${vm.name ?? vm.id} (${vm.ip_address}) has an empty or near-empty MEMORY.md (${memHealth.memSizeBytes} bytes) despite being assigned for ${Math.round(hoursSinceAssigned)} hours with active sessions (largest: ${Math.round(sessionHealth.largestSessionBytes / 1024)}KB).\n\nAssigned to: ${vm.assigned_to ?? "unknown"}\nActive tasks file: ${memHealth.activeTasksExists ? "exists" : "MISSING"}\n\nThis means the agent is not persisting any long-term memory. The user will lose all context on session rotation.`
            );
          } catch {
            // Non-fatal
          }
        }
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
  // Eighth pass: Proxy round-trip + token verification for healthy VMs
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

          if (ADMIN_EMAIL) {
            try {
              await sendAdminAlertEmail(
                "VM Proxy-Quarantined: Auth Chain Broken",
                `VM ${vm.name ?? vm.id} (${vm.ip_address}, user: ${vm.assigned_to}) has been quarantined after ${currentCount + 1} consecutive proxy auth failures.\n\nAuto-resync was attempted but did not fix the issue.\n\nACTION REQUIRED: Manual review needed. Run full reconfigure or investigate the proxy auth chain.\n\nTo un-quarantine: update health_status back to "healthy" and reset proxy_401_count to 0 after fixing.`
              );
            } catch { /* non-fatal */ }
          }
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
            if (ADMIN_EMAIL) {
              try {
                await sendAdminAlertEmail(
                  "Cron: Proxy Auth Failure — Quarantine Pending",
                  `VM ${vm.id} (${vm.name ?? "unnamed"}, user: ${vm.assigned_to}) has failed ${newCount} consecutive proxy round-trip tests. Auto-resync did NOT fix the issue.\n\nLatest error: ${result.error}\n\nThe VM will be proxy-quarantined on the next health check cycle unless the issue resolves.`
                );
              } catch { /* non-fatal */ }
            }
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

          if (ADMIN_EMAIL) {
            try {
              await sendAdminAlertEmail(
                "Pool VM Auto-Quarantined: SSH Dead",
                `Ready pool VM ${rvm.name ?? rvm.id} (${rvm.ip_address}) has failed ${newCount} consecutive SSH checks and has been removed from the pool.\n\nThis VM was never assigned to a user.`
              );
            } catch {
              // Non-fatal
            }
          }
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
    .select("id, ip_address, name, assigned_to, ssh_fail_count")
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

          if (ADMIN_EMAIL) {
            try {
              await sendAdminAlertEmail(
                "VM Auto-Recovered from Quarantine",
                `VM ${qvm.name ?? qvm.id} (${qvm.ip_address}) was quarantined but its gateway HTTP health check is now responding OK.\n\nThe VM has been restored to status: "${newStatus}".\nAssigned to: ${qvm.assigned_to ?? "none (pool VM)"}\nPrevious ssh_fail_count: ${qvm.ssh_fail_count}`
              );
            } catch {
              // Non-fatal
            }
          }
        }
      } catch {
        // Gateway still unreachable — leave quarantined
      }
    }
  }

  // ========================================================================
  // Auto-migration pass: Move paying users off dead VMs to fresh ones.
  // Only triggers for quarantined VMs (status="failed") that:
  //   1. Have a user assigned (assigned_to is not null)
  //   2. That user has an active/trialing subscription
  //   3. Gateway is still unreachable (not recovered above)
  // Limited to AUTO_MIGRATE_BATCH_SIZE per cycle to prevent storms.
  // ========================================================================
  let autoMigrated = 0;

  // Re-query quarantined VMs that still have users (auto-recovery may have fixed some)
  const { data: deadAssignedVms } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, name, assigned_to, tier, ssh_port, ssh_user")
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

    const migratable = deadAssignedVms.filter((v) => payingUserIds.has(v.assigned_to!));

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

        // Step 6: Email admin
        if (ADMIN_EMAIL) {
          try {
            await sendAdminAlertEmail(
              "Auto-Migration Completed",
              `User ${userId} (${migratedUser?.email ?? "unknown"}) was auto-migrated from dead VM ${deadVm.name ?? deadVm.id} (${deadVm.ip_address}) to ${newVm.id} (${newVm.ip_address}).\n\nNew VM healthy: ${newVmHealthy}\nConfigure result: ${JSON.stringify(configResult)}`
            );
          } catch {
            // Non-fatal
          }
        }
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
    suspended,
    sessionsCleared,
    sessionsAlerted,
    browsersKilled,
    configsAudited,
    configsFixed,
    memoryFilesCreated,
    memoryEmptyAlerts,
    memoryStaleWarnings,
    proxyChecked,
    proxyFailed,
    proxyResynced,
    proxyQuarantined,
    autoMigrated,
  });
}
