/**
 * After the configure-cron-dir fix deploys, validate recovery for the 2 stuck
 * users (ikhsansufi1, raisyacantik64).
 *
 * For each:
 *   1. Wait for a VM to be assigned (Pass 0 should pick them up)
 *   2. Trigger /api/vm/configure with force=true
 *   3. Verify response shows {"configured": true, "healthy": true}
 *   4. Confirm DB state: onboarding_complete=true, VM health_status=healthy
 *   5. Send a test message through the gateway, expect "OK" response
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

const TARGETS = [
  { email: "ikhsansufi1@gmail.com", userId: "48d2aa1e-45d1-4003-af7c-5c0b7e54c6c8" },
  { email: "raisyacantik64@gmail.com", userId: "e192416f-d99e-4798-a4f9-8b01a912f29a" },
];

async function waitForVm(userId: string, timeoutSec = 60): Promise<{
  id: string; name: string | null; ip_address: string; gateway_url: string | null; gateway_token: string | null;
} | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    const { data: vm } = await s
      .from("instaclaw_vms")
      .select("id, name, ip_address, gateway_url, gateway_token")
      .eq("assigned_to", userId)
      .maybeSingle();
    if (vm) return vm;
    await new Promise((r) => setTimeout(r, 4000));
  }
  return null;
}

async function fireConfigure(userId: string): Promise<{ status: number; body: string; durationMs: number }> {
  const t0 = Date.now();
  const res = await fetch(`${NEXTAUTH_URL}/api/vm/configure`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-key": ADMIN_KEY },
    body: JSON.stringify({ userId, force: true }),
  });
  return { status: res.status, body: await res.text(), durationMs: Date.now() - t0 };
}

async function chatProbe(gatewayUrl: string, gatewayToken: string): Promise<{ ok: boolean; body: string; status: number; durationMs: number }> {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    const r = await fetch(`${gatewayUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${gatewayToken}`,
        "x-openclaw-model": "claude-haiku-4-5-20251001",
      },
      body: JSON.stringify({
        model: "openclaw",
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with one word: OK" }],
        stream: false,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const text = await r.text();
    return { ok: r.ok, body: text.slice(0, 200), status: r.status, durationMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, body: String(err).slice(0, 200), status: 0, durationMs: Date.now() - t0 };
  }
}

(async () => {
  for (const t of TARGETS) {
    console.log(`\n══ ${t.email} ══`);

    console.log(`  [1/4] Wait up to 60s for Pass 0 to assign a VM…`);
    const vm = await waitForVm(t.userId, 60);
    if (!vm) {
      console.log(`    ❌ no VM assigned in 60s`);
      continue;
    }
    console.log(`    ✓ VM ${vm.name} (${vm.ip_address})`);

    console.log(`  [2/4] Force-trigger /api/vm/configure (this is THE test of the fix)…`);
    const cfg = await fireConfigure(t.userId);
    console.log(`    status=${cfg.status} duration=${(cfg.durationMs / 1000).toFixed(1)}s`);
    console.log(`    body: ${cfg.body.slice(0, 250)}`);
    if (cfg.status !== 200) {
      console.log(`    ❌ configure did NOT return 200`);
      continue;
    }

    console.log(`  [3/4] Verify DB state: onboarding_complete + VM healthy…`);
    const { data: u } = await s.from("instaclaw_users").select("onboarding_complete").eq("id", t.userId).single();
    const { data: vmAfter } = await s.from("instaclaw_vms")
      .select("name, health_status, config_version, gateway_url, gateway_token")
      .eq("assigned_to", t.userId).single();
    console.log(`    onboarding_complete: ${u?.onboarding_complete}`);
    console.log(`    VM health: ${vmAfter?.health_status} cfg=v${vmAfter?.config_version}`);
    if (!u?.onboarding_complete || vmAfter?.health_status !== "healthy") {
      console.log(`    ❌ DB state not yet healthy`);
      continue;
    }

    console.log(`  [4/4] Chat round-trip test through gateway…`);
    if (!vmAfter?.gateway_url || !vmAfter?.gateway_token) {
      console.log(`    ❌ no gateway info`);
      continue;
    }
    const chat = await chatProbe(vmAfter.gateway_url, vmAfter.gateway_token);
    console.log(`    status=${chat.status} duration=${(chat.durationMs / 1000).toFixed(1)}s`);
    if (chat.ok && /\bOK\b/i.test(chat.body)) {
      console.log(`    ✅ AGENT REPLIED — ${t.email} fully recovered`);
    } else {
      console.log(`    ❌ chat failed: ${chat.body.slice(0, 150)}`);
    }
  }
})();
