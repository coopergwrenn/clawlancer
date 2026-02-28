import { NextResponse } from "next/server";
import { verifyHQAuth } from "@/lib/hq-auth";
import { getSupabase } from "@/lib/supabase";
import { TIER_DISPLAY, type Tier, type ApiMode } from "@/lib/stripe";

// Prevent Vercel CDN from caching per-user responses
export const dynamic = "force-dynamic";

const VM_MONTHLY_COST: Record<string, number> = {
  hetzner: 9,
  digitalocean: 24,
  linode: 24,
};

/**
 * Estimated API cost per call by model.
 * Based on ~500 input tokens + ~1000 output tokens per average call.
 */
const API_COST_PER_CALL: Record<string, number> = {
  minimax: 0.001275,  // $0.15/1M in + $1.20/1M out
  haiku: 0.0044,      // $0.80/1M in + $4.00/1M out
  sonnet: 0.0165,     // $3.00/1M in + $15.00/1M out
  opus: 0.0825,       // $15.00/1M in + $75.00/1M out
};

const MODEL_COST_WEIGHT: Record<string, number> = {
  minimax: 0.2,
  haiku: 1,
  sonnet: 4,
  opus: 19,
};

/** Map a model ID (e.g. "claude-sonnet-4-5-20250929") to a bucket key. */
function modelBucket(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("minimax")) return "minimax";
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("opus")) return "opus";
  return "haiku"; // fallback
}

export async function GET() {
  if (!(await verifyHQAuth())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabase = getSupabase();
    const { data: vms, error } = await supabase
      .from("instaclaw_vms")
      .select("id, provider, server_type, status, assigned_to, tier, api_mode, created_at, default_model, last_ram_pct, last_disk_pct, last_chrome_count, last_uptime_seconds");

    if (error) throw new Error(error.message);

    const vmList = vms ?? [];

    // --- Provider breakdown ---
    const EMPTY_COUNTS = { vmCount: 0, assignedCount: 0, readyCount: 0, provisioningCount: 0 };
    const providerMap = new Map<
      string,
      { vmCount: number; assignedCount: number; readyCount: number; provisioningCount: number }
    >();

    // Seed all known providers so they always appear
    for (const name of Object.keys(VM_MONTHLY_COST)) {
      providerMap.set(name, { ...EMPTY_COUNTS });
    }

    for (const vm of vmList) {
      const p = vm.provider ?? "hetzner";
      if (!providerMap.has(p)) {
        providerMap.set(p, { ...EMPTY_COUNTS });
      }
      const entry = providerMap.get(p)!;
      entry.vmCount++;
      if (vm.status === "assigned") entry.assignedCount++;
      else if (vm.status === "ready") entry.readyCount++;
      else if (vm.status === "provisioning") entry.provisioningCount++;
    }

    const providers = Array.from(providerMap.entries()).map(([name, counts]) => ({
      name,
      ...counts,
      monthlyCost: counts.vmCount * (VM_MONTHLY_COST[name] ?? 0),
    }));

    // --- Subscription-based tier breakdown (source of truth for revenue) ---
    const { data: subscriptions } = await supabase
      .from("instaclaw_subscriptions")
      .select("user_id, tier, status")
      .in("status", ["active", "trialing"]);

    const subList = subscriptions ?? [];

    // Build a map of user_id → vm api_mode for price lookup
    const userApiModeMap = new Map<string, ApiMode>();
    for (const vm of vmList) {
      if (vm.assigned_to) {
        userApiModeMap.set(vm.assigned_to, (vm.api_mode ?? "all_inclusive") as ApiMode);
      }
    }

    const tierMap = new Map<string, { count: number; revenuePerVm: number; totalRevenue: number }>();

    for (const sub of subList) {
      if (!sub.tier) continue;

      const tier = sub.tier as Tier;
      const tierInfo = TIER_DISPLAY[tier];
      if (!tierInfo) continue;

      const apiMode = userApiModeMap.get(sub.user_id) ?? "all_inclusive";
      const price = apiMode === "byok" ? tierInfo.byok : tierInfo.allInclusive;
      const key = `${tier}_${apiMode}`;

      if (!tierMap.has(key)) {
        tierMap.set(key, { count: 0, revenuePerVm: price, totalRevenue: 0 });
      }
      const entry = tierMap.get(key)!;
      entry.count++;
      entry.totalRevenue += price;
    }

    const tiers = Array.from(tierMap.entries()).map(([key, data]) => {
      const [tier, apiMode] = key.split("_") as [string, string];
      const tierInfo = TIER_DISPLAY[tier as Tier];
      return {
        tier: tierInfo?.name ?? tier,
        apiMode,
        ...data,
      };
    });

    // --- Totals ---
    const totalVms = vmList.length;
    const activeSubscribers = subList.length;
    const assignedVms = vmList.filter((v) => v.status === "assigned").length;
    const availableVms = vmList.filter((v) => v.status === "ready").length;
    const monthlyInfraCost = providers.reduce((sum, p) => sum + p.monthlyCost, 0);
    const monthlyRevenue = tiers.reduce((sum, t) => sum + t.totalRevenue, 0);
    const grossMargin = monthlyRevenue - monthlyInfraCost;
    const marginPercent = monthlyRevenue > 0 ? (grossMargin / monthlyRevenue) * 100 : 0;

    // --- API cost estimation (current month) ---
    // Query all daily_usage rows for the current calendar month
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const monthStartStr = monthStart.toISOString().split("T")[0];

    const { data: usageRows } = await supabase
      .from("instaclaw_daily_usage")
      .select("vm_id, message_count, heartbeat_count")
      .gte("usage_date", monthStartStr);

    // Build a map of VM id → default_model bucket
    const vmModelMap = new Map<string, string>();
    for (const vm of vmList) {
      vmModelMap.set(vm.id, modelBucket(vm.default_model ?? "minimax-m2.5"));
    }

    // Aggregate usage per VM
    const vmUsageMap = new Map<string, { userUnits: number; hbUnits: number }>();
    for (const row of usageRows ?? []) {
      const existing = vmUsageMap.get(row.vm_id) ?? { userUnits: 0, hbUnits: 0 };
      existing.userUnits += Number(row.message_count) || 0;
      existing.hbUnits += Number(row.heartbeat_count) || 0;
      vmUsageMap.set(row.vm_id, existing);
    }

    // Compute costs per model bucket and per VM
    const modelCosts = new Map<string, { units: number; calls: number; cost: number }>();
    let totalUserCost = 0;
    let totalHeartbeatCost = 0;

    const vmCostDetails: {
      vmId: string;
      tier: string | null;
      model: string;
      userUnits: number;
      userCost: number;
      heartbeatUnits: number;
      heartbeatCost: number;
      totalCost: number;
    }[] = [];

    for (const [vmId, usage] of vmUsageMap) {
      const bucket = vmModelMap.get(vmId) ?? "haiku";
      const weight = MODEL_COST_WEIGHT[bucket] ?? 1;
      const costPerCall = API_COST_PER_CALL[bucket] ?? 0.004;

      // User messages: units / weight = call count
      const userCalls = weight > 0 ? usage.userUnits / weight : 0;
      const userCost = userCalls * costPerCall;

      // Heartbeats: always MiniMax (weight 0.2, $0.001275/call)
      const hbCalls = usage.hbUnits / (MODEL_COST_WEIGHT.minimax ?? 0.2);
      const hbCost = hbCalls * (API_COST_PER_CALL.minimax ?? 0.001275);

      totalUserCost += userCost;
      totalHeartbeatCost += hbCost;

      // Per-model aggregation (user messages only — heartbeats are all MiniMax)
      const existing = modelCosts.get(bucket) ?? { units: 0, calls: 0, cost: 0 };
      existing.units += usage.userUnits;
      existing.calls += userCalls;
      existing.cost += userCost;
      modelCosts.set(bucket, existing);

      // Per-VM detail
      const vm = vmList.find((v) => v.id === vmId);
      vmCostDetails.push({
        vmId,
        tier: vm?.tier ?? null,
        model: bucket,
        userUnits: usage.userUnits,
        userCost,
        heartbeatUnits: usage.hbUnits,
        heartbeatCost: hbCost,
        totalCost: userCost + hbCost,
      });
    }

    // Add heartbeats as their own entry in model breakdown
    const hbEntry = modelCosts.get("minimax") ?? { units: 0, calls: 0, cost: 0 };
    const totalHbUnits = [...vmUsageMap.values()].reduce((s, u) => s + u.hbUnits, 0);
    const totalHbCalls = totalHbUnits / (MODEL_COST_WEIGHT.minimax ?? 0.2);

    const byModel = Array.from(modelCosts.entries())
      .map(([model, data]) => ({ model, ...data }))
      .sort((a, b) => b.cost - a.cost);

    const totalApiSpend = totalUserCost + totalHeartbeatCost;

    // Days elapsed this month (for monthly projection)
    const now = new Date();
    const daysElapsed = now.getUTCDate();
    const daysInMonth = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getUTCDate();
    const projectedMonthlyApiSpend = daysElapsed > 0
      ? (totalApiSpend / daysElapsed) * daysInMonth
      : 0;

    const apiCosts = {
      periodStart: monthStartStr,
      daysElapsed,
      daysInMonth,
      totalSpend: totalApiSpend,
      projectedMonthly: projectedMonthlyApiSpend,
      userMessages: totalUserCost,
      heartbeats: totalHeartbeatCost,
      heartbeatCalls: totalHbCalls,
      byModel,
      byVm: vmCostDetails.sort((a, b) => b.totalCost - a.totalCost),
    };

    // True margin = Revenue - Infra - API spend (projected)
    const trueGrossMargin = monthlyRevenue - monthlyInfraCost - projectedMonthlyApiSpend;
    const trueMarginPercent = monthlyRevenue > 0
      ? (trueGrossMargin / monthlyRevenue) * 100
      : 0;

    // --- VM list for detail table ---
    const vmDetails = vmList.map((vm) => {
      const provider = vm.provider ?? "hetzner";
      const cost = VM_MONTHLY_COST[provider] ?? 0;
      return {
        id: vm.id,
        provider,
        serverType: vm.server_type,
        status: vm.status,
        tier: vm.tier,
        apiMode: vm.api_mode,
        createdAt: vm.created_at,
        monthlyCost: cost,
        ramPct: vm.last_ram_pct,
        diskPct: vm.last_disk_pct,
        chromeCount: vm.last_chrome_count,
        uptimeSeconds: vm.last_uptime_seconds,
      };
    });

    return NextResponse.json({
      providers,
      tiers,
      apiCosts,
      totals: {
        totalVms,
        activeSubscribers,
        assignedVms,
        availableVms,
        monthlyInfraCost,
        monthlyRevenue,
        grossMargin,
        marginPercent,
        projectedApiSpend: projectedMonthlyApiSpend,
        trueGrossMargin,
        trueMarginPercent,
      },
      vms: vmDetails,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
