import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { lookupVMByGatewayToken } from "@/lib/gateway-auth";
import { logger } from "@/lib/logger";
import {
  evaluateCronJobs,
  sendFrequencyWarning,
  sendProjectionWarning,
  resolveTelegramTarget,
  type CronJobReport,
} from "@/lib/cron-guard";

/**
 * POST /api/gateway/cron-report
 *
 * Called by the VM-side cron-guard script to report cron job configurations.
 * Evaluates guardrails and returns actions for the VM to apply.
 *
 * Auth: X-Gateway-Token (same as proxy).
 *
 * Body: { jobs: [{ name, intervalMs, scheduleExpr?, enabled }] }
 * Response: { actions: [{ name, action, reason?, projectedDaily? }], circuitBreakerActive }
 */
export async function POST(req: NextRequest) {
  const gatewayToken =
    req.headers.get("x-gateway-token") || req.headers.get("x-api-key");
  if (!gatewayToken) {
    return NextResponse.json({ error: "Missing authentication" }, { status: 401 });
  }

  const supabase = getSupabase();

  const vm = await lookupVMByGatewayToken(
    gatewayToken,
    "id, tier, telegram_bot_token, telegram_chat_id, cron_breaker_active"
  );
  if (!vm) {
    return NextResponse.json({ error: "Invalid gateway token" }, { status: 401 });
  }

  let body: { jobs: CronJobReport[] };
  try {
    body = await req.json();
    if (!Array.isArray(body.jobs)) {
      return NextResponse.json({ error: "jobs must be an array" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const tier = vm.tier || "starter";

  // Load confirmed jobs from DB
  const { data: guardRows } = await supabase
    .from("instaclaw_cron_guard")
    .select("job_name, confirmed")
    .eq("vm_id", vm.id);

  const confirmedJobs = new Set<string>(
    (guardRows ?? [])
      .filter((r: { confirmed: boolean }) => r.confirmed)
      .map((r: { job_name: string }) => r.job_name)
  );

  // Evaluate all jobs
  const result = evaluateCronJobs(body.jobs, tier, confirmedJobs);
  result.circuitBreakerActive = vm.cron_breaker_active ?? false;

  // Upsert guard state for each job
  for (const action of result.actions) {
    const job = body.jobs.find((j) => j.name === action.name);
    if (!job) continue;

    const upsertData = {
      vm_id: vm.id,
      job_name: action.name,
      interval_ms: job.intervalMs,
      schedule_expr: job.scheduleExpr ?? null,
      suppressed: action.action === "suppress",
      projected_daily_credits: action.projectedDaily ?? 0,
      updated_at: new Date().toISOString(),
      ...(action.action === "suppress" && !confirmedJobs.has(action.name)
        ? { warned_at: new Date().toISOString() }
        : {}),
    };

    await supabase
      .from("instaclaw_cron_guard")
      .upsert(upsertData, { onConflict: "vm_id,job_name" });
  }

  // Clean up jobs that no longer exist on the VM
  const currentJobNames = body.jobs.map((j) => j.name);
  if (guardRows && guardRows.length > 0) {
    const staleJobs = guardRows
      .map((r: { job_name: string }) => r.job_name)
      .filter((name: string) => !currentJobNames.includes(name));
    if (staleJobs.length > 0) {
      await supabase
        .from("instaclaw_cron_guard")
        .delete()
        .eq("vm_id", vm.id)
        .in("job_name", staleJobs);
    }
  }

  // Send Telegram notifications for new suppressions and warnings
  const suppressedActions = result.actions.filter(
    (a) => a.action === "suppress" && !confirmedJobs.has(a.name)
  );
  const warnActions = result.actions.filter((a) => a.action === "warn");

  if (suppressedActions.length > 0 || warnActions.length > 0 || result.warnings.length > 0) {
    const tg = await resolveTelegramTarget(vm, supabase);
    if (tg) {
      // Send frequency warnings for newly suppressed jobs
      for (const action of suppressedActions) {
        const job = body.jobs.find((j) => j.name === action.name);
        if (job) {
          sendFrequencyWarning(
            tg.botToken,
            tg.chatId,
            action.name,
            job.intervalMs,
            action.projectedDaily ?? 0,
            tier,
          ).catch(() => {});
        }
      }

      // Send aggregate projection warning if total is high
      if (result.warnings.length > 0) {
        const totalProjected = result.actions.reduce(
          (sum, a) => sum + (a.projectedDaily ?? 0),
          0
        );
        if (totalProjected > 0) {
          sendProjectionWarning(tg.botToken, tg.chatId, totalProjected, tier).catch(
            () => {}
          );
        }
      }
    }
  }

  logger.info("Cron guard report processed", {
    route: "gateway/cron-report",
    vmId: vm.id,
    jobCount: body.jobs.length,
    suppressed: suppressedActions.length,
    warned: warnActions.length,
  });

  return NextResponse.json({
    actions: result.actions,
    circuitBreakerActive: result.circuitBreakerActive,
  });
}
