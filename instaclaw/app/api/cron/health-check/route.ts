import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { checkHealthExtended, checkSSHConnectivity, clearSessions, restartGateway, stopGateway, auditVMConfig, ensureMemoryFile, testProxyRoundTrip, killStaleBrowser, rotateOversizedSession, CONFIG_SPEC } from "@/lib/ssh";
import { sendHealthAlertEmail, sendSuspendedEmail, sendAdminAlertEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

const ALERT_THRESHOLD = 3; // Send alert after 3 consecutive failures
const SSH_QUARANTINE_THRESHOLD = 3; // Auto-quarantine after 3 consecutive SSH failures
const SUSPENSION_GRACE_DAYS = 7; // Days before suspending VM for past_due payment
const CONFIG_AUDIT_BATCH_SIZE = 3; // Max VMs to audit per cycle (staggered)
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
    .select("id, ip_address, ssh_port, ssh_user, gateway_url, health_status, gateway_token, health_fail_count, ssh_fail_count, assigned_to, name, config_version, api_mode, proxy_401_count")
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
      // Auto-quarantine: mark VM as failed
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

    if (result.healthy) {
      healthy++;
      healthyVmIds.add(vm.id);

      // Check for session overflow — rotate instead of deleting
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
      }

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
        // Auto-restart gateway
        try {
          await restartGateway(vm);
          restarted++;
        } catch (err) {
          logger.error("Failed to restart gateway", { error: String(err), route: "cron/health-check", vmId: vm.id });
        }

        // Send alert email to user
        if (vm.assigned_to) {
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
        if (ADMIN_EMAIL) {
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
  // Sixth pass: Proxy round-trip validation for healthy all_inclusive VMs
  // Catches VMs that pass local health check but have broken proxy auth
  // (the EuroPartShop scenario). Limit to 3 per cycle to control cost/time.
  // ========================================================================
  let proxyChecked = 0;
  let proxyFailed = 0;
  const PROXY_CHECK_BATCH_SIZE = 3;
  const PROXY_401_THRESHOLD = 3;

  const proxyCheckBatch = vms
    .filter(
      (vm) =>
        healthyVmIds.has(vm.id) &&
        vm.api_mode === "all_inclusive" &&
        vm.gateway_token
    )
    .slice(0, PROXY_CHECK_BATCH_SIZE);

  for (const vm of proxyCheckBatch) {
    try {
      const result = await testProxyRoundTrip(vm.gateway_token!, 1);
      proxyChecked++;

      if (!result.success) {
        proxyFailed++;
        const newCount = (vm.proxy_401_count ?? 0) + 1;

        await supabase
          .from("instaclaw_vms")
          .update({ proxy_401_count: newCount })
          .eq("id", vm.id);

        logger.warn("Proxy round-trip failed for healthy VM", {
          route: "cron/health-check",
          vmId: vm.id,
          vmName: vm.name,
          error: result.error,
          proxy401Count: newCount,
        });

        if (newCount >= PROXY_401_THRESHOLD) {
          await sendAdminAlertEmail(
            "Cron: Proxy Round-Trip Failure",
            `VM ${vm.id} (${vm.name ?? "unnamed"}, user: ${vm.assigned_to}) passes local health check but has failed ${newCount} consecutive proxy round-trip tests.\n\nLatest error: ${result.error}\n\nThis VM needs a reconfigure to fix the proxy auth chain.`
          );
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

  return NextResponse.json({
    checked: vms.length,
    sshChecked,
    sshFailed,
    sshQuarantined,
    poolSshChecked,
    poolSshQuarantined,
    healthy,
    unhealthy,
    restarted,
    alerted,
    webhooksFixed,
    suspended,
    sessionsCleared,
    browsersKilled,
    configsAudited,
    configsFixed,
    memoryFilesCreated,
    proxyChecked,
    proxyFailed,
  });
}
