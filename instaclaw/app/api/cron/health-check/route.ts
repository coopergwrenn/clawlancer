import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { checkHealthExtended, clearSessions, restartGateway, stopGateway, auditVMConfig, ensureMemoryFile, CONFIG_SPEC } from "@/lib/ssh";
import { sendHealthAlertEmail, sendSuspendedEmail } from "@/lib/email";
import { logger } from "@/lib/logger";

const ALERT_THRESHOLD = 3; // Send alert after 3 consecutive failures
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
    .select("id, ip_address, ssh_port, ssh_user, gateway_url, health_status, gateway_token, health_fail_count, assigned_to, name, config_version")
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

  // Track which VMs are healthy for the config audit pass
  const healthyVmIds = new Set<string>();

  for (const vm of vms) {
    const result = await checkHealthExtended(vm, vm.gateway_token ?? undefined);
    const currentFailCount = vm.health_fail_count ?? 0;

    if (result.healthy) {
      healthy++;
      healthyVmIds.add(vm.id);

      // Check for session overflow
      if (result.largestSessionBytes > CONFIG_SPEC.maxSessionBytes) {
        logger.warn("Session overflow detected, auto-clearing", {
          route: "cron/health-check",
          vmId: vm.id,
          vmName: vm.name,
          largestSessionBytes: result.largestSessionBytes,
          maxSessionBytes: CONFIG_SPEC.maxSessionBytes,
        });

        try {
          const cleared = await clearSessions(vm);
          if (cleared) {
            sessionsCleared++;
            logger.info("Sessions cleared and gateway restarted", {
              route: "cron/health-check",
              vmId: vm.id,
              vmName: vm.name,
            });
          }
        } catch (err) {
          logger.error("Failed to clear sessions", {
            error: String(err),
            route: "cron/health-check",
            vmId: vm.id,
          });
        }
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

  return NextResponse.json({
    checked: vms.length,
    healthy,
    unhealthy,
    restarted,
    alerted,
    webhooksFixed,
    suspended,
    sessionsCleared,
    configsAudited,
    configsFixed,
    memoryFilesCreated,
  });
}
