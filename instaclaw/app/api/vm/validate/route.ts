import { NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { validateVM, fixVM, storeAuditResult, type ValidationResult } from "@/lib/vm-validate";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { vmId, all, fix } = body as { vmId?: string; all?: boolean; fix?: boolean };

  const supabase = getSupabase();

  if (all) {
    // Validate all assigned VMs
    const { data: vms } = await supabase
      .from("instaclaw_vms")
      .select("id, ip_address, ssh_port, ssh_user, name, gateway_token, api_mode")
      .eq("status", "assigned")
      .not("ip_address", "is", null);

    if (!vms?.length) {
      return NextResponse.json({ message: "No assigned VMs", results: [] });
    }

    const results: ValidationResult[] = [];
    // Process in batches of 10 concurrent
    const BATCH_SIZE = 10;
    for (let i = 0; i < vms.length; i += BATCH_SIZE) {
      const batch = vms.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(async (vm) => {
          const result = await validateVM(vm);
          let fixedCount = 0;
          if (fix && result.overallStatus !== "pass") {
            const fixed = await fixVM(vm, result);
            fixedCount = fixed.length;
            result.fixed = fixed;
          }
          await storeAuditResult(result, fixedCount);
          return result;
        })
      );
      for (const r of batchResults) {
        if (r.status === "fulfilled") {
          results.push(r.value);
        } else {
          logger.error("VM validation failed", { error: String(r.reason) });
        }
      }
    }

    const summary = {
      total: results.length,
      pass: results.filter((r) => r.overallStatus === "pass").length,
      degraded: results.filter((r) => r.overallStatus === "degraded").length,
      fail: results.filter((r) => r.overallStatus === "fail").length,
    };

    return NextResponse.json({ summary, results });
  }

  if (!vmId) {
    return NextResponse.json({ error: "vmId or all required" }, { status: 400 });
  }

  // Single VM validation
  const { data: vm } = await supabase
    .from("instaclaw_vms")
    .select("id, ip_address, ssh_port, ssh_user, name, gateway_token, api_mode")
    .eq("id", vmId)
    .single();

  if (!vm) {
    return NextResponse.json({ error: "VM not found" }, { status: 404 });
  }

  const result = await validateVM(vm);
  let fixedCount = 0;
  if (fix && result.overallStatus !== "pass") {
    const fixed = await fixVM(vm, result);
    fixedCount = fixed.length;
    result.fixed = fixed;
  }
  await storeAuditResult(result, fixedCount);

  return NextResponse.json(result);
}
