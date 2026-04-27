/**
 * Chat round-trip test against 5 random healthy assigned VMs.
 *
 * Bypasses SSH entirely — pulls gateway_url + gateway_token from DB, POSTs
 * directly to the VM's gateway on port 18789. This is the same pattern that
 * worked for the orphan-recovery probes last week.
 *
 * For each VM:
 *   1. Check gateway responds at all (health/info if available, else just probe chat)
 *   2. POST a test message via /v1/chat/completions
 *   3. Verify 200 + assistant content actually contains the expected pattern
 *   4. Capture latency
 *
 * Outputs per-VM pass/fail + an aggregate result.
 */
import * as path from "path";
import { createClient } from "@supabase/supabase-js";
require("dotenv").config({ path: path.join(__dirname, "..", ".env.local") });

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

interface VMTestResult {
  vmId: string;
  vmName: string;
  ipAddress: string;
  tier: string;
  configVersion: number | null;
  healthCheck: { ok: boolean; status: number | null; durationMs: number; body?: string };
  chatTest: {
    ok: boolean;
    status: number | null;
    durationMs: number;
    response?: string;
    contentMatch: boolean;
    error?: string;
  };
  pass: boolean;
}

const TEST_PROMPT = "Reply with one word: OK";
const EXPECTED_PATTERN = /\bOK\b/i;

async function probeOne(vm: {
  id: string;
  name: string;
  ip_address: string;
  gateway_url: string;
  gateway_token: string;
  tier: string;
  config_version: number | null;
}): Promise<VMTestResult> {
  // 1. Health probe (lightweight — does gateway respond?)
  const healthStart = Date.now();
  let healthOk = false;
  let healthStatus: number | null = null;
  let healthBody = "";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`${vm.gateway_url.replace(/\/+$/, "")}/health`, {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    healthStatus = r.status;
    healthOk = r.ok;
    healthBody = (await r.text().catch(() => "")).slice(0, 100);
  } catch (err) {
    healthBody = String(err).slice(0, 100);
  }
  const healthDur = Date.now() - healthStart;

  // 2. Chat round-trip
  const chatStart = Date.now();
  let chatOk = false;
  let chatStatus: number | null = null;
  let chatResp = "";
  let contentMatch = false;
  let chatErr: string | undefined;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    const r = await fetch(
      `${vm.gateway_url.replace(/\/+$/, "")}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${vm.gateway_token}`,
          "x-openclaw-model": "claude-haiku-4-5-20251001",
        },
        body: JSON.stringify({
          model: "openclaw",
          max_tokens: 16,
          messages: [{ role: "user", content: TEST_PROMPT }],
          stream: false,
        }),
        signal: ctrl.signal,
      },
    );
    clearTimeout(timer);
    chatStatus = r.status;
    chatOk = r.ok;
    if (r.ok) {
      const body = await r.json().catch(() => null);
      // Accept both Anthropic shape (content[].text) and OpenAI shape (choices[].message.content).
      chatResp =
        body?.choices?.[0]?.message?.content ??
        body?.content?.find?.((b: { type?: string; text?: string }) => b.type === "text")?.text ??
        JSON.stringify(body).slice(0, 200);
      contentMatch = EXPECTED_PATTERN.test(chatResp);
    } else {
      chatResp = (await r.text().catch(() => "")).slice(0, 200);
    }
  } catch (err) {
    chatErr = String(err).slice(0, 200);
  }
  const chatDur = Date.now() - chatStart;

  return {
    vmId: vm.id,
    vmName: vm.name,
    ipAddress: vm.ip_address,
    tier: vm.tier,
    configVersion: vm.config_version,
    healthCheck: { ok: healthOk, status: healthStatus, durationMs: healthDur, body: healthBody },
    chatTest: {
      ok: chatOk,
      status: chatStatus,
      durationMs: chatDur,
      response: chatResp.slice(0, 100),
      contentMatch,
      error: chatErr,
    },
    pass: healthOk && chatOk && contentMatch,
  };
}

(async () => {
  // Healthy + assigned + has gateway_url + has gateway_token + at current manifest
  const { data: candidates } = await s
    .from("instaclaw_vms")
    .select("id, name, ip_address, gateway_url, gateway_token, tier, config_version, last_proxy_call_at")
    .eq("status", "assigned")
    .eq("health_status", "healthy")
    .not("gateway_url", "is", null)
    .not("gateway_token", "is", null)
    .gt("last_proxy_call_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()); // active in last 7d

  if (!candidates?.length) {
    console.log("No candidates — fleet has no healthy assigned VMs with gateways. Skipping check 6.");
    return;
  }

  console.log(`Candidate pool: ${candidates.length} healthy assigned VMs with gateway + recent activity`);

  // Random shuffle, take 5
  const sample = [...candidates].sort(() => Math.random() - 0.5).slice(0, 5);
  console.log(`Selected 5 for chat tests:`);
  for (const vm of sample) {
    console.log(`  ${vm.name} ip=${vm.ip_address} tier=${vm.tier} cfg=v${vm.config_version}`);
  }
  console.log(``);

  // Probe in parallel — bounded by 5 since we only have 5 anyway
  const results = await Promise.all(sample.map(probeOne));

  console.log(`\n══ CHECK 6 RESULTS ══`);
  for (const r of results) {
    const verdict = r.pass ? "✅ PASS" : "❌ FAIL";
    console.log(`\n${verdict}  ${r.vmName} (${r.ipAddress})`);
    console.log(
      `  health: ${r.healthCheck.ok ? "OK" : "FAIL"} status=${r.healthCheck.status} ${r.healthCheck.durationMs}ms ${r.healthCheck.body ? `body="${r.healthCheck.body}"` : ""}`,
    );
    console.log(
      `  chat:   ${r.chatTest.ok ? "200" : "FAIL"} status=${r.chatTest.status} ${r.chatTest.durationMs}ms contentMatch=${r.chatTest.contentMatch}`,
    );
    if (r.chatTest.response) console.log(`  reply: "${r.chatTest.response}"`);
    if (r.chatTest.error) console.log(`  error: ${r.chatTest.error}`);
  }

  const passing = results.filter((r) => r.pass).length;
  console.log(`\n── Aggregate: ${passing}/${results.length} VMs passed all checks ──`);
})();
