/**
 * Coverage query for `instaclaw_vms.last_disk_pct` — fleet-wide disk
 * usage snapshot, the metric Rule 46 lives on top of.
 *
 * Per CLAUDE.md Rule 27 (every fleet-wide resource needs a 10-second
 * visibility query) and Rule 46 ("Disk monitoring is mandatory; absent
 * it, disk fills are P0 customer-down").
 *
 * Outputs a histogram across canonical buckets and explicitly lists every
 * VM at ≥80% disk (the early-warning band — Cooper should know about each
 * one). Exits 0 if no VMs are at ≥85% (the alert threshold). Exits 1 if
 * any healthy + assigned VMs cross 85% — that's an actionable signal.
 *
 * Read-only — never modifies state. Safe to run on demand.
 *
 * Run: `npx tsx scripts/_coverage-disk-percent.ts`
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) {
        process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // env file optional — fail loud only if required vars missing
  }
}

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

type VMRow = {
  id: string;
  name: string | null;
  ip_address: string | null;
  status: string | null;
  health_status: string | null;
  last_disk_pct: number | null;
  last_health_check: string | null;
  tier: string | null;
  assigned_to: string | null;
};

async function main() {
  console.log(`\n=== disk_pct coverage — ${new Date().toISOString()} ===\n`);

  // Pull every assigned VM, not just healthy. last_disk_pct is written by
  // both stepDiskGuard (reconcile) and the health-check fleet-metrics pass.
  // Even on suspended/hibernating VMs, the column may be stale-but-real.
  const { data, error } = await sb
    .from("instaclaw_vms")
    .select("id,name,ip_address,status,health_status,last_disk_pct,last_health_check,tier,assigned_to")
    .eq("status", "assigned")
    .order("last_disk_pct", { ascending: false, nullsFirst: false });
  if (error) {
    console.error(`Supabase error: ${error.message}`);
    process.exit(2);
  }
  const rows = (data ?? []) as VMRow[];
  if (rows.length === 0) {
    console.log("No assigned VMs found. Nothing to report.");
    process.exit(0);
  }

  // ── Coverage: how many VMs even have a measurement? ──
  const measured = rows.filter((r) => r.last_disk_pct !== null);
  const unmeasured = rows.length - measured.length;
  const measuredPct =
    rows.length === 0 ? 0 : Math.round((measured.length / rows.length) * 100);
  console.log(`Population:          ${rows.length} assigned VMs`);
  console.log(`Measured:            ${measured.length} (${measuredPct}%) — last_disk_pct is non-null`);
  console.log(`Unmeasured:          ${unmeasured} — never probed (or probe failed)`);

  // ── Buckets ──
  const buckets: { name: string; min: number; max: number; count: number }[] = [
    { name: "<50%",     min: 0,  max: 49,  count: 0 },
    { name: "50-69%",   min: 50, max: 69,  count: 0 },
    { name: "70-79%",   min: 70, max: 79,  count: 0 },
    { name: "80-84%",   min: 80, max: 84,  count: 0 },
    { name: "85-89%",   min: 85, max: 89,  count: 0 }, // WARNING band
    { name: "90-94%",   min: 90, max: 94,  count: 0 }, // AUTO-PURGE band
    { name: "95-100%",  min: 95, max: 100, count: 0 }, // CRITICAL band
  ];
  for (const r of measured) {
    const v = r.last_disk_pct ?? -1;
    const b = buckets.find((x) => v >= x.min && v <= x.max);
    if (b) b.count++;
  }
  console.log(`\nHistogram (of ${measured.length} measured):`);
  for (const b of buckets) {
    const bar = "█".repeat(Math.min(40, b.count));
    const flag = b.min >= 95 ? "  [CRITICAL]" : b.min >= 90 ? "  [auto-purge]" : b.min >= 85 ? "  [WARNING]" : "";
    console.log(`  ${b.name.padEnd(10)} ${String(b.count).padStart(4)}  ${bar}${flag}`);
  }

  // ── List every VM at ≥80% — explicit, no truncation ──
  const atRisk = measured.filter((r) => (r.last_disk_pct ?? 0) >= 80);
  if (atRisk.length === 0) {
    console.log(`\n✓ No VMs at ≥80% disk. Fleet is healthy.\n`);
    process.exit(0);
  }

  console.log(`\n${atRisk.length} VM(s) at ≥80%:`);

  // For each at-risk VM, enrich with owner email (one query per VM —
  // bounded by the at-risk count, typically 0-10)
  const userIds = [...new Set(atRisk.map((r) => r.assigned_to).filter((x): x is string => !!x))];
  const userEmails = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users } = await sb
      .from("instaclaw_users")
      .select("id,email")
      .in("id", userIds);
    for (const u of (users ?? []) as { id: string; email: string }[]) {
      userEmails.set(u.id, u.email);
    }
  }

  const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);
  console.log(
    pad("VM", 22) +
    pad("DISK%", 7) +
    pad("HEALTH", 12) +
    pad("TIER", 10) +
    pad("OWNER", 32) +
    "IP",
  );
  console.log("-".repeat(110));
  for (const r of atRisk) {
    const owner = r.assigned_to ? userEmails.get(r.assigned_to) ?? "(no row)" : "(unassigned)";
    console.log(
      pad(r.name ?? r.id.slice(0, 8), 22) +
      pad(`${r.last_disk_pct}%`, 7) +
      pad(r.health_status ?? "?", 12) +
      pad(r.tier ?? "?", 10) +
      pad(owner, 32) +
      (r.ip_address ?? "?"),
    );
  }

  // ── Exit code: 1 if any healthy + assigned VM is in the WARNING band or worse ──
  const healthyAtRisk = atRisk.filter(
    (r) => r.health_status === "healthy" && (r.last_disk_pct ?? 0) >= 85,
  );
  if (healthyAtRisk.length > 0) {
    console.error(
      `\n✗ ${healthyAtRisk.length} healthy+assigned VM(s) at ≥85% disk. ` +
      `Rule 46 alerts should be firing for each on the next health-check cycle.`,
    );
    process.exit(1);
  }
  console.log(`\n✓ All ≥80% VMs are below the WARNING threshold (85%) or are not in 'healthy' state.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(2);
});
