/**
 * Video funnel coverage — build order §4 instrumentation (Rule 27).
 *
 * Ships WITH the first-video seed (Cooper's ruling: "the funnel economics are
 * unproven until those numbers exist, and unproven economics on a loss-leader
 * is how lanes die quietly"). Answers in ~10 seconds:
 *
 *   1. Seeds: granted / delivered / failed (failed = gift NOT consumed, by design).
 *   2. Engagement: paid renders by seeded VMs after their seed.
 *   3. Conversion: seeded VMs that later bought a video pack — which pack,
 *      days-to-convert. Pack identity from the video_topup ledger amount
 *      (52/156/416 → taste/creator/studio; sizes are collision-free vs the
 *      message packs 50/200/500 and media packs 500/1200/3000 — 52/156/416
 *      appear in NO other pack family).
 *   4. ECONOMICS: total seed COGS vs margin earned from converted packs.
 *      THE LOSS FLAG: a seeded VM whose only purchase is the TASTE pack is a
 *      NET LOSS (taste margin $0.74 < seed COGS $0.8125) — payback requires
 *      Creator/Studio conversion (breakeven 15.5% / 5.8%).
 *
 * Usage: npx tsx scripts/_coverage-video-funnel.ts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

for (const f of ["/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local"]) {
  try {
    for (const l of readFileSync(f, "utf-8").split("\n")) {
      const m = l.match(/^([^#=]+)=(.*)$/);
      if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
}
const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://qvrnuyzfqjrsjljcqbub.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Locked economics (build order §3.1; COGS proven by the 171==171 reconciliation).
const SEED_COGS_USD = 0.8125; // 13 cr × $0.0625
const PACKS: Record<number, { name: string; price: number; cogs: number }> = {
  52: { name: "taste", price: 3.99, cogs: 3.25 },
  156: { name: "creator", price: 14.99, cogs: 9.75 },
  416: { name: "studio", price: 39.99, cogs: 26.0 },
};

async function main() {
  // 1. Seeds (marker-based; gate-constructed metadata).
  const { data: seeds, error: se } = await sb
    .from("instaclaw_video_transactions")
    .select("vm_id, status, created_at")
    .eq("metadata->>seed", "true");
  if (se) { console.error("seed query failed:", se.message); process.exit(1); }

  const granted = seeds ?? [];
  const delivered = granted.filter((s) => s.status === "settled");
  const pending = granted.filter((s) => s.status === "pending");
  const failed = granted.filter((s) => s.status === "failed");
  const seededVms = new Map<string, string>(); // vm_id → first seed created_at
  for (const s of granted) {
    const prev = seededVms.get(s.vm_id);
    if (!prev || s.created_at < prev) seededVms.set(s.vm_id, s.created_at);
  }

  console.log("— SEEDS —");
  console.log(`  granted: ${granted.length} (unique VMs: ${seededVms.size})`);
  console.log(`  delivered (settled): ${delivered.length}   in-flight: ${pending.length}   failed (gift NOT consumed): ${failed.length}`);
  console.log(`  seed COGS to date: $${(delivered.length * SEED_COGS_USD).toFixed(2)}`);

  if (seededVms.size === 0) {
    console.log("\n(no seeds yet — funnel reporting activates with the first seed)");
    return;
  }

  // 2. Engagement: paid renders by seeded VMs after their seed.
  const vmIds = [...seededVms.keys()];
  const { data: paidRenders } = await sb
    .from("instaclaw_video_transactions")
    .select("vm_id, created_at, settled_credits")
    .in("vm_id", vmIds)
    .eq("is_free", false)
    .eq("status", "settled");
  const paidAfterSeed = (paidRenders ?? []).filter(
    (r) => r.created_at > (seededVms.get(r.vm_id) ?? ""),
  );
  console.log("\n— ENGAGEMENT —");
  console.log(`  paid renders by seeded VMs (after seed): ${paidAfterSeed.length}`);

  // 3. Conversion: video_topup ledger rows for seeded VMs.
  const { data: topups } = await sb
    .from("instaclaw_credit_ledger")
    .select("vm_id, amount, created_at, reference_id")
    .in("vm_id", vmIds)
    .eq("source", "video_topup");
  const byVm = new Map<string, { name: string; price: number; cogs: number; at: string }[]>();
  for (const t of topups ?? []) {
    const pack = PACKS[Number(t.amount)];
    if (!pack) continue; // unknown amount — not a known pack (manual grant etc.)
    const arr = byVm.get(t.vm_id) ?? [];
    arr.push({ ...pack, at: t.created_at });
    byVm.set(t.vm_id, arr);
  }
  const converted = [...byVm.keys()];
  const packCounts: Record<string, number> = { taste: 0, creator: 0, studio: 0 };
  let revenue = 0, packMargin = 0;
  const daysToConvert: number[] = [];
  let tasteOnlyVms = 0;
  for (const [vmId, purchases] of byVm) {
    let hasUpper = false;
    for (const p of purchases) {
      packCounts[p.name]++;
      revenue += p.price;
      packMargin += p.price - p.cogs;
      if (p.name !== "taste") hasUpper = true;
    }
    if (!hasUpper) tasteOnlyVms++;
    const seedAt = seededVms.get(vmId);
    const firstBuy = purchases.map((p) => p.at).sort()[0];
    if (seedAt && firstBuy) {
      daysToConvert.push((Date.parse(firstBuy) - Date.parse(seedAt)) / 86400000);
    }
  }
  const convPct = ((converted.length / seededVms.size) * 100).toFixed(1);
  const medDays = daysToConvert.length
    ? daysToConvert.sort((a, b) => a - b)[Math.floor(daysToConvert.length / 2)].toFixed(1)
    : "n/a";

  console.log("\n— CONVERSION —");
  console.log(`  seeded VMs that bought a pack: ${converted.length}/${seededVms.size} (${convPct}%)`);
  console.log(`  packs: taste=${packCounts.taste} creator=${packCounts.creator} studio=${packCounts.studio}`);
  console.log(`  median days seed→first purchase: ${medDays}`);

  // 4. Economics + the loss flag.
  const seedCogs = delivered.length * SEED_COGS_USD;
  const net = packMargin - seedCogs;
  console.log("\n— ECONOMICS —");
  console.log(`  pack revenue from seeded VMs: $${revenue.toFixed(2)}   pack margin: $${packMargin.toFixed(2)}`);
  console.log(`  seed COGS: $${seedCogs.toFixed(2)}   NET: ${net >= 0 ? "+" : ""}$${net.toFixed(2)} ${net >= 0 ? "✅ funnel paying back" : "❌ funnel underwater"}`);
  console.log(`  ⚠ taste-only converters (net-loss profile): ${tasteOnlyVms}/${converted.length || 1}`);
  console.log(`  breakeven reference: 15.5% conversion to creator / 5.8% to studio`);
}

main().catch((e) => { console.error(e); process.exit(1); });
