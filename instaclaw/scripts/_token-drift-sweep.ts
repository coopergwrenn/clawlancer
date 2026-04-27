/**
 * Token-drift sweep across all assigned + unhealthy VMs.
 *
 * Strategy:
 *   1. Pull every VM where status='assigned' AND health_status NOT IN
 *      ('healthy', 'suspended') — paying users that are NOT healthy
 *      and NOT intentionally paused.
 *   2. For each, chat-probe the gateway with the DB-stored gateway_token.
 *      A 401 Unauthorized = token drift (DB token != gateway's runtime token).
 *      A 200 / network error / 5xx = NOT a drift signal — leave for other tools.
 *   3. For each 401, POST /api/vm/resync-token (BYOK-safe).
 *   4. Re-probe to confirm fix.
 *
 * Usage:
 *   npx tsx scripts/_token-drift-sweep.ts          # dry-run
 *   npx tsx scripts/_token-drift-sweep.ts --exec   # actually resync
 */
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const ADMIN_KEY = process.env.ADMIN_API_KEY!;
const NEXTAUTH_URL = process.env.NEXTAUTH_URL ?? "https://instaclaw.io";
const EXEC = process.argv.includes("--exec");

type Vm = {
  id: string;
  name: string;
  ip_address: string;
  health_status: string;
  gateway_token: string | null;
  gateway_url: string | null;
  api_mode: string | null;
};

async function chatProbe(vm: Vm, timeoutMs = 25_000): Promise<{
  status: number; ok: boolean; bodySnippet: string; ms: number; classification: "drift" | "ok" | "other-error" | "no-token-or-url";
}> {
  if (!vm.gateway_url || !vm.gateway_token) {
    return { status: 0, ok: false, bodySnippet: "no gateway_url/token in DB", ms: 0, classification: "no-token-or-url" };
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
    const cls = r.status === 401 ? "drift" : r.ok ? "ok" : "other-error";
    return { status: r.status, ok: r.ok, bodySnippet: body.slice(0, 120), ms: Date.now() - t0, classification: cls };
  } catch (err) {
    return { status: 0, ok: false, bodySnippet: String(err).slice(0, 120), ms: Date.now() - t0, classification: "other-error" };
  }
}

async function resync(vm: Vm): Promise<{ ok: boolean; status: number; body: string; ms: number }> {
  const t0 = Date.now();
  const r = await fetch(`${NEXTAUTH_URL}/api/vm/resync-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY },
    body: JSON.stringify({ vmId: vm.id }),
    signal: AbortSignal.timeout(60_000),
  });
  return { ok: r.ok, status: r.status, body: (await r.text()).slice(0, 200), ms: Date.now() - t0 };
}

(async () => {
  console.log(`=== Token-drift sweep (${EXEC ? "EXEC" : "DRY-RUN"}) ===\n`);

  const { data: vms } = await s
    .from("instaclaw_vms")
    .select("id, name, ip_address, health_status, gateway_token, gateway_url, api_mode")
    .eq("status", "assigned")
    .not("health_status", "in", "(healthy,suspended)");

  console.log(`Assigned + unhealthy (excl. suspended): ${vms?.length ?? 0}\n`);
  if (!vms || vms.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const drifted: Vm[] = [];
  const otherErrors: { vm: Vm; status: number; body: string }[] = [];
  const okList: Vm[] = [];
  const skipped: Vm[] = [];

  // Probe in batches of 8 to keep parallelism reasonable
  for (let i = 0; i < vms.length; i += 8) {
    const batch = (vms as Vm[]).slice(i, i + 8);
    const results = await Promise.all(batch.map(async (vm) => ({ vm, r: await chatProbe(vm) })));
    for (const { vm, r } of results) {
      const tag = `${vm.name?.padEnd(20)} health=${vm.health_status?.padEnd(18)}`;
      console.log(`  ${tag} → ${r.status} ${r.classification} (${r.ms}ms) ${r.bodySnippet.replace(/\s+/g, " ").slice(0, 70)}`);
      if (r.classification === "drift") drifted.push(vm);
      else if (r.classification === "no-token-or-url") skipped.push(vm);
      else if (r.classification === "ok") okList.push(vm);
      else otherErrors.push({ vm, status: r.status, body: r.bodySnippet });
    }
  }

  console.log(`\n=== Probe summary ===`);
  console.log(`  total checked:   ${vms.length}`);
  console.log(`  drift (401):     ${drifted.length}`);
  console.log(`  ok (200):        ${okList.length}  ← unhealthy in DB but chat works (stale health flag?)`);
  console.log(`  other errors:    ${otherErrors.length}`);
  console.log(`  skipped (no DB): ${skipped.length}`);

  if (drifted.length === 0) {
    console.log(`\nNo token drift detected — nothing to fix. (Chat probe is the canonical signal.)`);
    return;
  }

  console.log(`\nDrifted VMs (will resync):`);
  for (const v of drifted) console.log(`  ${v.name} (${v.ip_address}) health=${v.health_status} api_mode=${v.api_mode ?? "?"}`);

  if (!EXEC) {
    console.log(`\nDRY-RUN — rerun with --exec to call /api/vm/resync-token on each.`);
    return;
  }

  console.log(`\n=== Resyncing ${drifted.length} drifted VMs ===`);
  for (const vm of drifted) {
    process.stdout.write(`  ${vm.name}… `);
    try {
      const r = await resync(vm);
      console.log(`status=${r.status} (${(r.ms/1000).toFixed(1)}s) ${r.body.slice(0, 100)}`);
    } catch (e) {
      console.log(`FAIL: ${(e as Error).message.slice(0, 120)}`);
    }
  }

  console.log(`\n=== Re-probing after resync ===`);
  for (const vm of drifted) {
    // Re-fetch the row so we use the new gateway_token from DB
    const { data: fresh } = await s.from("instaclaw_vms")
      .select("id, name, ip_address, health_status, gateway_token, gateway_url, api_mode")
      .eq("id", vm.id).single();
    if (!fresh) { console.log(`  ${vm.name}: row vanished?`); continue; }
    const r = await chatProbe(fresh as Vm);
    console.log(`  ${fresh.name}: ${r.status} ${r.classification} (${r.ms}ms)`);
  }
})();
