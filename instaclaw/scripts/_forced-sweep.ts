/**
 * Forced sweep: probe every assigned VM (regardless of health_status)
 * via gateway chat round-trip. Identify ANY currently-broken paying user.
 *
 * Excludes only:
 *   - status != assigned (ready/failed/terminated/destroyed)
 *
 * Sub status is checked AFTER the probe to classify each result:
 *   - active/trialing → P0: must be working
 *   - past_due → P1: should ideally work
 *   - canceled → ignore (will be terminated)
 *   - none → flag (no sub but VM assigned — orphan)
 *
 * Output: per-VM probe result + classification, plus a summary.
 */
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

type Vm = {
  id: string;
  name: string;
  ip_address: string;
  health_status: string;
  gateway_token: string | null;
  gateway_url: string | null;
  assigned_to: string;
};

async function chatProbe(vm: Vm, timeoutMs = 25_000): Promise<{
  status: number; ok: boolean; bodySnippet: string; ms: number;
  classification: "drift" | "ok" | "error" | "no-gateway";
}> {
  if (!vm.gateway_url || !vm.gateway_token) {
    return { status: 0, ok: false, bodySnippet: "no gateway_url/token", ms: 0, classification: "no-gateway" };
  }
  const t0 = Date.now();
  try {
    const r = await fetch(`${vm.gateway_url.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${vm.gateway_token}`,
        "x-openclaw-model": "claude-haiku-4-5-20251001",
      },
      body: JSON.stringify({
        model: "openclaw",
        max_tokens: 4,
        messages: [{ role: "user", content: "ok" }],
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await r.text();
    const cls = r.status === 401 ? "drift" : r.ok ? "ok" : "error";
    return { status: r.status, ok: r.ok, bodySnippet: body.slice(0, 100), ms: Date.now() - t0, classification: cls };
  } catch (err) {
    return { status: 0, ok: false, bodySnippet: String(err).slice(0, 100), ms: Date.now() - t0, classification: "error" };
  }
}

(async () => {
  console.log("=== Forced sweep: chat-probe every assigned VM ===\n");

  const { data: vms, error: qErr } = await s.from("instaclaw_vms")
    .select("id, name, ip_address, health_status, gateway_token, gateway_url, assigned_to")
    .eq("status", "assigned");

  if (qErr) { console.error("query error:", qErr); process.exit(1); }
  console.log(`Total assigned VMs: ${vms?.length ?? 0}\n`);
  if (!vms || vms.length === 0) return;

  // Probe in batches of 12 for parallelism
  const results: Array<{ vm: Vm; r: Awaited<ReturnType<typeof chatProbe>> }> = [];
  const total = vms.length;
  for (let i = 0; i < total; i += 12) {
    const batch = (vms as Vm[]).slice(i, i + 12);
    const out = await Promise.all(batch.map(async (vm) => ({ vm, r: await chatProbe(vm) })));
    results.push(...out);
    process.stderr.write(`\r  probed ${Math.min(i + 12, total)}/${total}…`);
  }
  process.stderr.write("\n\n");

  // Classify by sub status — fetch all subs in one go
  const userIds = [...new Set(results.map((x) => x.vm.assigned_to).filter(Boolean))];
  const subsMap = new Map<string, { status: string; tier: string; payment_status: string }>();
  // chunk into 200-id queries
  for (let i = 0; i < userIds.length; i += 200) {
    const chunk = userIds.slice(i, i + 200);
    const { data: subs } = await s.from("instaclaw_subscriptions")
      .select("user_id, status, tier, payment_status")
      .in("user_id", chunk);
    for (const sub of subs ?? []) {
      subsMap.set(sub.user_id!, { status: sub.status!, tier: sub.tier!, payment_status: sub.payment_status! });
    }
  }
  const usersMap = new Map<string, string>();
  for (let i = 0; i < userIds.length; i += 200) {
    const chunk = userIds.slice(i, i + 200);
    const { data: us } = await s.from("instaclaw_users").select("id, email").in("id", chunk);
    for (const u of us ?? []) usersMap.set(u.id, u.email ?? "?");
  }

  // Triage buckets
  const broken: Array<{ vm: Vm; r: typeof results[0]["r"]; sub: string; email: string }> = [];
  const stats = { ok: 0, drift: 0, error: 0, noGw: 0 };

  for (const { vm, r } of results) {
    const sub = subsMap.get(vm.assigned_to);
    const subStatus = sub?.status ?? "none";
    const email = usersMap.get(vm.assigned_to) ?? "?";

    if (r.classification === "ok") stats.ok++;
    else if (r.classification === "drift") stats.drift++;
    else if (r.classification === "error") stats.error++;
    else stats.noGw++;

    // Broken = NOT ok AND user is on a paying sub
    if (r.classification !== "ok" && (subStatus === "active" || subStatus === "trialing")) {
      broken.push({ vm, r, sub: `${subStatus}/${sub?.tier ?? "?"}`, email });
    }
  }

  console.log("=== Probe summary ===");
  console.log(`  total probed:    ${total}`);
  console.log(`  ok (200):        ${stats.ok}`);
  console.log(`  drift (401):     ${stats.drift}`);
  console.log(`  error/timeout:   ${stats.error}`);
  console.log(`  no-gateway-info: ${stats.noGw}`);

  console.log(`\n=== 🚨 BROKEN paying users (active/trialing only) ===`);
  console.log(`Total: ${broken.length}\n`);
  for (const b of broken) {
    console.log(`  ${b.email.padEnd(35)} ${b.vm.name?.padEnd(20)} health=${b.vm.health_status?.padEnd(12)} sub=${b.sub.padEnd(18)} probe=${b.r.status} ${b.r.classification}`);
    if (b.r.bodySnippet) console.log(`    body: ${b.r.bodySnippet.replace(/\s+/g, " ").slice(0, 150)}`);
  }

  // also report past_due brokens separately
  const brokenPastDue: typeof broken = [];
  for (const { vm, r } of results) {
    const sub = subsMap.get(vm.assigned_to);
    const email = usersMap.get(vm.assigned_to) ?? "?";
    if (r.classification !== "ok" && sub?.status === "past_due") {
      brokenPastDue.push({ vm, r, sub: `${sub.status}/${sub.tier}`, email });
    }
  }
  console.log(`\n=== past_due users with broken VMs (P1 — flag for Cooper) ===`);
  console.log(`Total: ${brokenPastDue.length}\n`);
  for (const b of brokenPastDue) {
    console.log(`  ${b.email.padEnd(35)} ${b.vm.name?.padEnd(20)} health=${b.vm.health_status?.padEnd(12)} probe=${b.r.status} ${b.r.classification}`);
  }
})();
