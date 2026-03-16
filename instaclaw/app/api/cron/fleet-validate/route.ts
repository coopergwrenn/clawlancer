import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { validateVM, fixVM, storeAuditResult } from "@/lib/vm-validate";
import { AlertCollector } from "@/lib/admin-alert";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 600;

const BATCH_SIZE = 10;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();
  const alerts = new AlertCollector();

  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, name, gateway_token, api_mode")
    .eq("status", "assigned")
    .not("ip_address", "is", null);

  if (!vms?.length) {
    return NextResponse.json({ checked: 0 });
  }

  let pass = 0;
  let degraded = 0;
  let fail = 0;
  let totalFixed = 0;

  for (let i = 0; i < vms.length; i += BATCH_SIZE) {
    const batch = vms.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (vm) => {
        try {
          const result = await validateVM(vm);

          // Auto-fix fixable failures
          let fixedCount = 0;
          if (result.overallStatus !== "pass") {
            const fixed = await fixVM(vm, result);
            fixedCount = fixed.length;
            result.fixed = fixed;
            totalFixed += fixedCount;
          }

          await storeAuditResult(result, fixedCount);

          // Track stats
          if (result.overallStatus === "pass") pass++;
          else if (result.overallStatus === "degraded") degraded++;
          else fail++;

          // Alert on unfixed critical failures
          const unfixedCritical = result.checks.filter(
            (c) => c.severity === "critical" && c.status === "fail" && !c.fixable
          );
          if (unfixedCritical.length > 0) {
            const detail = unfixedCritical
              .map((c) => `${c.name}: ${c.detail ?? "failed"}`)
              .join("\n");
            alerts.add("Fleet Validation: Critical Failures", vm.name ?? vm.id, detail);
          }
        } catch (err) {
          logger.error("Fleet validate: VM error", { vm: vm.name, error: String(err) });
          fail++;
        }
      })
    );

    // Log any unhandled rejections
    for (const r of results) {
      if (r.status === "rejected") {
        logger.error("Fleet validate: batch error", { error: String(r.reason) });
      }
    }
  }

  // Flush grouped alerts
  const alertResult = await alerts.flush();

  // Prune old audit records (> 30 days)
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from("instaclaw_vm_audits").delete().lt("created_at", cutoff);
  } catch {
    // Non-fatal
  }

  return NextResponse.json({
    checked: vms.length,
    pass,
    degraded,
    fail,
    totalFixed,
    alerts: alertResult,
  });
}
