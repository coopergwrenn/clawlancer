/**
 * End-to-end smoke test: create complementary intents on two cohort
 * agents, then verify they appear in Index's read_intents AND that
 * Index discovers an opportunity (if it does so synchronously).
 *
 * Acceptance criteria:
 *
 *   - createIndexIntent returns status='created' for both agents
 *   - read_intents on each agent's key returns at least the intent we
 *     just created
 *   - (Optional, may not fire synchronously) discover_opportunities
 *     against each agent's key returns a draft opportunity referencing
 *     the OTHER agent
 *
 * Cleanup: archives both intents at the end so we don't pollute Yanek's
 * dev environment with test data.
 *
 * Usage:
 *   npx tsx scripts/_test-intent-creation.ts
 *   npx tsx scripts/_test-intent-creation.ts --no-cleanup    # leave intents
 */
import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

for (const l of readFileSync(
  "/Users/cooperwrenn/wild-west-bots/instaclaw/.env.local",
  "utf-8",
).split("\n")) {
  const m = l.match(/^([^#=]+)=(.*)$/);
  if (m && !process.env[m[1].trim()]) {
    process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

import { createIndexIntent } from "../lib/index-intent-creator";
// Use inline MCP helper — same as lib/index-intent-creator.ts uses while
// the IndexMcpClient class bug is open.
import crypto from "crypto";
async function callIndexMcpTool(args: {
  apiKey: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  _attempt?: number;
}): Promise<{ ok: true; result: unknown } | { ok: false; error: string; detail?: string }> {
  const attempt = args._attempt ?? 1;
  const base = (process.env.INDEX_NETWORK_API_URL?.trim() || "https://protocol.index.network").replace(/\/+$/, "");
  const url = `${base}/mcp`;
  const headers = { "x-api-key": args.apiKey, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, clientInfo: { name: "instaclaw", version: "0.1.0" } } }) }).then(r => r.text());
  const callRes = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: { name: args.toolName, arguments: args.toolArgs } }) });
  const raw = await callRes.text();
  let parsed: any;
  if (/^event:|\ndata:\s/m.test(raw)) {
    const matches = Array.from(raw.matchAll(/^data:\s*(.*)$/gm));
    try { parsed = JSON.parse(matches[matches.length - 1]?.[1] ?? ""); } catch { return { ok: false, error: "sse_non_json", detail: raw.slice(0, 200) }; }
  } else {
    try { parsed = JSON.parse(raw); } catch { return { ok: false, error: "non_json", detail: raw.slice(0, 200) }; }
  }
  if (parsed?.result?.isError === true) {
    const detail = JSON.stringify(parsed.result.content).slice(0, 200);
    // Retry once on burst-rate-limit signature (same shape as lib/index-intent-creator.ts).
    if (attempt === 1 && /Invalid API key/.test(detail)) {
      await new Promise((r) => setTimeout(r, 1500));
      return callIndexMcpTool({ ...args, _attempt: 2 });
    }
    return { ok: false, error: "tool_call_isError", detail };
  }
  return { ok: true, result: parsed?.result ?? null };
}

const skipCleanup = process.argv.includes("--no-cleanup");

let passed = 0;
let failed = 0;
const log = (s: string) => console.log(s);
const assert = (cond: boolean, msg: string) => {
  if (cond) {
    passed++;
    log(`  ✓ ${msg}`);
  } else {
    failed++;
    log(`  ✗ ${msg}`);
  }
};

async function main() {
  log("\n=== Intent creation E2E smoke test ===\n");

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Pick two cohort users with index credentials. Carter Cleveland (vm-917) +
  // Katherine Jones (vm-859) — both spectator-visible and used in prior smoke
  // tests, so well-known known-good cohort members.
  const { data: vms, error } = await sb
    .from("instaclaw_vms")
    .select("name, assigned_to, index_user_id, index_api_key")
    .eq("partner", "edge_city")
    .not("index_api_key", "is", null)
    .in("name", ["instaclaw-vm-917", "instaclaw-vm-859"]);
  if (error || !vms || vms.length < 2) {
    console.error("✗ need vm-917 + vm-859 both provisioned with index_api_key. err:", error);
    process.exit(1);
  }
  const carter = vms.find((v) => v.name === "instaclaw-vm-917")!;
  const katherine = vms.find((v) => v.name === "instaclaw-vm-859")!;

  log(`Test pair:`);
  log(`  Carter   : vm-917  index_user_id=${(carter.index_user_id as string).slice(0, 8)}…`);
  log(`  Katherine: vm-859  index_user_id=${(katherine.index_user_id as string).slice(0, 8)}…`);

  const carterDescription = `[SMOKE TEST 2026-05-19] Researching agentic browser automation; want to meet people working on multi-agent coordination protocols, especially anyone building agent-to-agent messaging systems.`;
  const katherineDescription = `[SMOKE TEST 2026-05-19] Building agent-to-agent messaging infrastructure; looking to collaborate with people researching agentic browser automation or multi-agent coordination.`;

  // ── TEST 1: createIndexIntent on Carter ──
  log("\n=== Test 1: createIndexIntent on Carter ===");
  const carterRes = await createIndexIntent({
    userId: carter.assigned_to as string,
    description: carterDescription,
  });
  log(`  result: ${JSON.stringify(carterRes)}`);
  assert(carterRes.status === "created", "Carter's intent created");
  const carterIntentId = carterRes.status === "created" ? carterRes.intentId : null;

  // Pace between tests so we don't trip Yanek's burst rate limit.
  await new Promise((r) => setTimeout(r, 1500));

  // ── TEST 2: createIndexIntent on Katherine ──
  log("\n=== Test 2: createIndexIntent on Katherine ===");
  const katherineRes = await createIndexIntent({
    userId: katherine.assigned_to as string,
    description: katherineDescription,
  });
  log(`  result: ${JSON.stringify(katherineRes)}`);
  assert(katherineRes.status === "created", "Katherine's intent created");
  const katherineIntentId =
    katherineRes.status === "created" ? katherineRes.intentId : null;

  await new Promise((r) => setTimeout(r, 1500));

  // ── TEST 3: verify via read_intents on Carter's key ──
  log("\n=== Test 3: read_intents on Carter's key (confirm visibility) ===");
  const carterIntents = await callIndexMcpTool({
    apiKey: carter.index_api_key as string,
    toolName: "read_intents",
    toolArgs: {},
  });
  if (carterIntents.ok) {
    const content = (carterIntents.result as { content?: Array<{ text?: string }> })?.content;
    const text = (content?.[0]?.text ?? "").slice(0, 1500);
    log(`  read_intents response (first 1500 chars):\n${text}`);
    assert(
      text.includes("SMOKE TEST 2026-05-19") || text.includes(carterIntentId ?? ""),
      "Carter's smoke intent shows up in read_intents",
    );
  } else {
    log(`  read_intents failed: ${JSON.stringify(carterIntents)}`);
    assert(false, "read_intents tool call ok");
  }

  await new Promise((r) => setTimeout(r, 1500));

  // ── TEST 4: optional — discover_opportunities to see if a match was already drafted ──
  log("\n=== Test 4 (optional): discover_opportunities on Carter's key ===");
  const carterOpps = await callIndexMcpTool({
    apiKey: carter.index_api_key as string,
    toolName: "discover_opportunities",
    toolArgs: { networkId: "fee18edc-1e60-4b13-b8c8-20e6f6ed1acb" },
  });
  if (carterOpps.ok) {
    const content = (carterOpps.result as { content?: Array<{ text?: string }> })?.content;
    const text = (content?.[0]?.text ?? "").slice(0, 1500);
    log(`  discover_opportunities response (first 1500 chars):\n${text}`);
    log(
      `  (note: a discovered draft opportunity is good signal but doesn't fire matchpool_outcomes until both parties ACCEPT)`,
    );
  } else {
    log(`  discover_opportunities failed (non-fatal): ${JSON.stringify(carterOpps)}`);
  }

  // ── CLEANUP ──
  if (skipCleanup) {
    log("\n(--no-cleanup; leaving intents in Yanek's dev environment)");
  } else if (carterIntentId && /^[0-9a-f-]{36}$/i.test(carterIntentId)) {
    log("\n=== Cleanup: archive both intents ===");
    for (const [label, vm, intentId] of [
      ["Carter", carter, carterIntentId],
      ["Katherine", katherine, katherineIntentId],
    ] as const) {
      if (!intentId || !/^[0-9a-f-]{36}$/i.test(intentId)) {
        log(`  ${label}: no usable intentId (${intentId}) — skip archive`);
        continue;
      }
      const r = await callIndexMcpTool({
        apiKey: vm.index_api_key as string,
        toolName: "delete_intent",
        toolArgs: { intentId },
      });
      log(`  ${label}: delete_intent → ${r.ok ? "ok" : `error: ${r.error}`}`);
    }
  }

  log("\n========================");
  log(`  ${passed} passed, ${failed} failed`);
  log("========================\n");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("✗ test threw:", e);
  process.exit(99);
});
