import { NextRequest, NextResponse } from "next/server";
import { verifyHQAuth } from "@/lib/hq-auth";
import { getSupabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  if (!(await verifyHQAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = getSupabase();

  // Get latest audit per VM (using distinct on)
  const { data: audits } = await supabase
    .from("instaclaw_vm_audits")
    .select("id, vm_id, created_at, overall_status, critical_count, warning_count, checks, fixed_count")
    .order("created_at", { ascending: false })
    .limit(200);

  if (!audits?.length) {
    return NextResponse.json({ audits: [] });
  }

  // Get VM names
  const vmIds = [...new Set(audits.map((a) => a.vm_id))];
  const { data: vms } = await supabase
    .from("instaclaw_vms")
    .select("id, name")
    .in("id", vmIds);

  const vmNameMap = new Map((vms ?? []).map((v) => [v.id, v.name]));

  // Deduplicate: keep only the latest audit per VM
  const latestByVm = new Map<string, typeof audits[0]>();
  for (const audit of audits) {
    if (!latestByVm.has(audit.vm_id)) {
      latestByVm.set(audit.vm_id, audit);
    }
  }

  const result = [...latestByVm.values()]
    .map((a) => ({
      ...a,
      vm_name: vmNameMap.get(a.vm_id) ?? null,
    }))
    .sort((a, b) => {
      // Sort: fail first, then degraded, then pass
      const order: Record<string, number> = { fail: 0, degraded: 1, pass: 2 };
      return (order[a.overall_status] ?? 3) - (order[b.overall_status] ?? 3);
    });

  return NextResponse.json({ audits: result });
}

export async function POST(req: NextRequest) {
  if (!(await verifyHQAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { action, vmId } = body as { action: string; vmId?: string };

  // Proxy to the validate endpoint using CRON_SECRET
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? "https://instaclaw.io";

  if (action === "validate_all") {
    const res = await fetch(`${baseUrl}/api/vm/validate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cronSecret}`,
      },
      body: JSON.stringify({ all: true, fix: true }),
    });
    const data = await res.json();
    return NextResponse.json(data);
  }

  if (action === "fix_vm" && vmId) {
    const res = await fetch(`${baseUrl}/api/vm/validate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cronSecret}`,
      },
      body: JSON.stringify({ vmId, fix: true }),
    });
    const data = await res.json();
    return NextResponse.json(data);
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
